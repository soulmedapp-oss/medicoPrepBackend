const DiscussionPost = require('../models/DiscussionPost');
const User = require('../models/User');
const { can } = require('../rbac/can');
const { recordAudit } = require('../utils/audit');
const { reportError } = require('../lib/errorReporter.js');
const { isValidObjectId } = require('../utils/security');
const { displayNameFor, DEFAULT_AVATAR_ID } = require('../utils/identity');
const { containsProfanity } = require('../utils/profanity');
const {
  displayIdentity, sortThread, canEditPost, shouldAutoHide, nextMuteUntil, REPORT_REASONS, BODY_MIN, BODY_MAX,
} = require('../utils/discussions');

const ANCHOR_TYPES = new Set(['lecture']); // 'question' is modelled, not yet served
const REPORT_QUEUE_LIMIT = 200;
// Every discussion notification points at the lecture page (spec §7).
const DISCUSSION_LINK = '/Videos';

// The mute is a date, so an expired one is no mute at all. Both the read
// (muted_until in the thread) and the write (POST 403) go through here so
// they can never disagree about whether a student is muted.
function activeMute(user, now = Date.now()) {
  const until = user?.discussion_muted_until;
  if (!until) return null;
  const date = new Date(until);
  return date.getTime() > now ? date : null;
}

const excerpt = (text) => String(text || '').slice(0, 120);

function createDiscussionsController({ createNotification, loadVideoForPlayback }) {
  const isModerator = (user) => can(user, 'CanModerateDiscussions');

  // Resolves the anchor and applies the lecture gate. Returns { lecture } or
  // { status, error }. This is deliberately the SAME gate as playback
  // (spec §6): a lecture that 404s for playback must 404 for its thread.
  async function gate(user, anchorType, anchorId) {
    if (!ANCHOR_TYPES.has(anchorType) || !isValidObjectId(String(anchorId))) return { status: 400, error: 'Invalid anchor' };
    const { video, error, status } = await loadVideoForPlayback(user, anchorId);
    if (!video) return { status: status || 404, error: error || 'Not found' };
    return { lecture: video };
  }

  // Shapes one post for the caller; `authors` is a Map(userId -> user) loaded
  // once per request. Staff-only fields (is_hidden, report_count) and the
  // real identity are added for moderators only — author_id never leaks to a
  // student, or an anonymous author could be correlated across posts.
  function shape(post, { user, moderator, authors }) {
    const identity = displayIdentity(post, { viewerIsModerator: moderator, author: authors.get(String(post.author_id)) });
    const mine = String(post.author_id) === String(user._id);
    return {
      _id: post._id,
      body: post.body,
      video_time: post.video_time,
      created_date: post.created_date,
      edited_at: post.edited_at,
      upvote_count: post.upvotes?.length || 0,
      upvoted_by_me: (post.upvotes || []).some((u) => String(u) === String(user._id)),
      is_teacher_reply: !!post.is_teacher_reply,
      is_pinned: !!post.is_pinned,
      can_edit: canEditPost(post, user._id),
      is_mine: mine,
      identity,
      ...(moderator ? { is_hidden: !!post.is_hidden, hidden_reason: post.hidden_reason, report_count: post.report_count || 0 } : {}),
    };
  }

  async function loadAuthors(posts) {
    const ids = [...new Set(posts.map((p) => String(p.author_id)))];
    const users = ids.length ? await User.find({ _id: { $in: ids } }).select('full_name email nickname').lean() : [];
    return new Map(users.map((u) => [String(u._id), u]));
  }

  async function listThread(req, res) {
    try {
      const anchorType = String(req.query?.anchor_type || '');
      const anchorId = String(req.query?.anchor_id || '');
      const { lecture, status, error } = await gate(req.user, anchorType, anchorId);
      if (!lecture) return res.status(status).json({ error });

      const moderator = isModerator(req.user);
      const filter = { 'anchor.type': anchorType, 'anchor.id': anchorId };
      // Filtered in the query, not in JS, so a hidden post never travels.
      if (!moderator) filter.is_hidden = { $ne: true };
      const rows = await DiscussionPost.find(filter).sort({ created_date: -1 }).lean();

      const authors = await loadAuthors(rows);
      const ctx = { user: req.user, moderator, authors };
      const repliesByParent = new Map();
      rows.filter((p) => p.parent_id).forEach((p) => {
        const key = String(p.parent_id);
        if (!repliesByParent.has(key)) repliesByParent.set(key, []);
        repliesByParent.get(key).push(p);
      });
      // Top level newest first; replies pinned -> teacher -> upvotes -> oldest.
      // A reply whose parent is hidden is dropped with its parent for students,
      // since its parent is not in `rows` to hang it on.
      const posts = rows
        .filter((p) => !p.parent_id)
        .sort((a, b) => new Date(b.created_date) - new Date(a.created_date))
        .map((post) => {
          const replies = sortThread(repliesByParent.get(String(post._id)) || []).map((reply) => shape(reply, ctx));
          return { ...shape(post, ctx), reply_count: replies.length, replies };
        });

      return res.json({ posts, muted_until: activeMute(req.user) });
    } catch (err) {
      reportError(req, err);
      return res.status(500).json({ error: 'Failed to load the discussion' });
    }
  }

  async function createPost(req, res) {
    try {
      const data = req.body || {};

      // Order matters (spec §8): the mute is checked first, so a muted
      // student always gets the same answer whatever they typed.
      const muted = activeMute(req.user);
      if (muted) {
        return res.status(403).json({ error: `Posting is paused until ${muted.toDateString()}`, muted_until: muted });
      }

      const anchorType = String(data.anchor_type || '');
      const anchorId = String(data.anchor_id || '');
      if (!ANCHOR_TYPES.has(anchorType) || !isValidObjectId(anchorId)) {
        return res.status(400).json({ error: 'Invalid anchor' });
      }
      const body = typeof data.body === 'string' ? data.body.trim() : '';
      if (body.length < BODY_MIN || body.length > BODY_MAX) {
        return res.status(400).json({ error: `Post must be between ${BODY_MIN} and ${BODY_MAX} characters` });
      }
      let parentId = data.parent_id ? String(data.parent_id) : null;
      if (parentId && !isValidObjectId(parentId)) {
        return res.status(400).json({ error: 'Invalid parent_id' });
      }
      let videoTime = null;
      if (data.video_time !== undefined && data.video_time !== null && data.video_time !== '') {
        videoTime = Number(data.video_time);
        if (!Number.isFinite(videoTime) || videoTime < 0) {
          return res.status(400).json({ error: 'Invalid video_time' });
        }
      }

      const { lecture, status, error } = await gate(req.user, anchorType, anchorId);
      if (!lecture) return res.status(status).json({ error });

      // `parent` is the post actually replied to — the notification goes to
      // its author — while `parent_id` is re-parented to the top-level post,
      // because depth is one level (spec §5).
      let parent = null;
      if (parentId) {
        parent = await DiscussionPost.findById(parentId).lean();
        if (!parent || String(parent.anchor?.id) !== anchorId) {
          return res.status(404).json({ error: 'Post not found' });
        }
        parentId = parent.parent_id ? String(parent.parent_id) : String(parent._id);
      }

      if (containsProfanity(body)) {
        return res.status(400).json({ error: 'Please rephrase your post' });
      }

      const isAnonymous = Boolean(data.is_anonymous);
      const moderator = isModerator(req.user);
      const created = await DiscussionPost.create({
        anchor: { type: anchorType, id: anchorId },
        parent_id: parentId,
        author_id: req.user._id,
        // A snapshot, so a later nickname change does not rewrite history.
        author_snapshot: { display_name: displayNameFor(req.user), avatar_id: req.user.avatar_id || DEFAULT_AVATAR_ID },
        is_anonymous: isAnonymous,
        body,
        video_time: videoTime,
        is_teacher_reply: moderator,
      });
      const post = typeof created.toObject === 'function' ? created.toObject() : created;

      if (parent && String(parent.author_id) !== String(req.user._id)) {
        const parentAuthor = await User.findById(parent.author_id).select('email').lean();
        if (parentAuthor?.email) {
          const who = isAnonymous ? 'Anonymous' : displayNameFor(req.user);
          const prefix = moderator ? 'Teacher ' : '';
          await createNotification({
            userEmail: parentAuthor.email,
            title: 'New reply to your post',
            message: `${prefix}${who} replied to your question on ${lecture.title || 'a lecture'}.`,
            type: 'info',
            link: DISCUSSION_LINK,
          });
        }
      }

      const authors = new Map([[String(req.user._id), req.user]]);
      return res.status(201).json({ post: shape(post, { user: req.user, moderator, authors }) });
    } catch (err) {
      reportError(req, err);
      return res.status(500).json({ error: 'Failed to create the post' });
    }
  }

  async function toggleUpvote(req, res) {
    try {
      const post = await DiscussionPost.findById(req.params.id).lean();
      if (!post) return res.status(404).json({ error: 'Post not found' });
      const userId = String(req.user._id);
      if (String(post.author_id) === userId) {
        return res.status(400).json({ error: 'You cannot upvote your own post' });
      }
      const others = (post.upvotes || []).filter((u) => String(u) !== userId);
      const upvoted = others.length === (post.upvotes || []).length; // not mine yet -> add
      await DiscussionPost.updateOne(
        { _id: post._id },
        upvoted ? { $addToSet: { upvotes: req.user._id } } : { $pull: { upvotes: req.user._id } }
      );
      return res.json({ upvoted, upvote_count: others.length + (upvoted ? 1 : 0) });
    } catch (err) {
      reportError(req, err);
      return res.status(500).json({ error: 'Failed to record the upvote' });
    }
  }

  async function reportPost(req, res) {
    try {
      const reason = String(req.body?.reason || '');
      if (!REPORT_REASONS.includes(reason)) {
        return res.status(400).json({ error: `reason must be one of: ${REPORT_REASONS.join(', ')}` });
      }
      const post = await DiscussionPost.findById(req.params.id).lean();
      if (!post) return res.status(404).json({ error: 'Post not found' });

      // Idempotent per user: a second report from the same person changes
      // nothing and still answers 200 (spec §8).
      const userId = String(req.user._id);
      if ((post.reports || []).some((r) => String(r.user_id) === userId)) {
        return res.json({ ok: true, hidden: Boolean(post.is_hidden) });
      }

      // $push and $inc in ONE update, so report_count can never drift from
      // reports.length under concurrent reports.
      const updated = await DiscussionPost.findByIdAndUpdate(
        post._id,
        { $push: { reports: { user_id: req.user._id, reason, at: new Date() } }, $inc: { report_count: 1 } },
        { new: true }
      ).lean();

      let hidden = Boolean(updated?.is_hidden);
      if (!hidden && shouldAutoHide(updated?.reports)) {
        await DiscussionPost.updateOne({ _id: post._id }, { $set: { is_hidden: true, hidden_reason: 'auto_reports' } });
        hidden = true;
        await recordAudit(req, {
          action: 'discussion.hidden',
          target_type: 'discussion_post',
          target_id: post._id,
          target_label: excerpt(post.body),
          before: { is_hidden: false, report_count: post.report_count || 0 },
          after: { is_hidden: true, hidden_reason: 'auto_reports', report_count: updated.report_count },
        });
        await maybeMute(req, updated.author_id);
      }
      return res.json({ ok: true, hidden });
    } catch (err) {
      reportError(req, err);
      return res.status(500).json({ error: 'Failed to report the post' });
    }
  }

  async function updatePost(req, res) {
    try {
      const updates = req.body || {};
      const has = (key) => Object.prototype.hasOwnProperty.call(updates, key);
      const post = await DiscussionPost.findById(req.params.id).lean();
      if (!post) return res.status(404).json({ error: 'Post not found' });

      const moderator = isModerator(req.user);
      const wantsModeration = has('is_pinned') || has('is_hidden');
      if (wantsModeration && !moderator) {
        return res.status(403).json({ error: 'Permission denied', required: ['CanModerateDiscussions'] });
      }
      if (has('body') && !canEditPost(post, req.user._id)) {
        return res.status(403).json({ error: 'You can only edit your own post, within 15 minutes of posting' });
      }
      if (!wantsModeration && !has('body')) {
        return res.status(400).json({ error: 'Nothing to update' });
      }

      const set = {};
      if (has('body')) {
        const body = typeof updates.body === 'string' ? updates.body.trim() : '';
        if (body.length < BODY_MIN || body.length > BODY_MAX) {
          return res.status(400).json({ error: `Post must be between ${BODY_MIN} and ${BODY_MAX} characters` });
        }
        if (containsProfanity(body)) {
          return res.status(400).json({ error: 'Please rephrase your post' });
        }
        set.body = body;
        set.edited_at = new Date();
      }
      const pinning = has('is_pinned') ? Boolean(updates.is_pinned) : null;
      const hiding = has('is_hidden') ? Boolean(updates.is_hidden) : null;
      if (pinning !== null) set.is_pinned = pinning;
      if (hiding !== null) {
        set.is_hidden = hiding;
        set.hidden_reason = hiding ? 'moderator' : '';
        set.hidden_by = hiding ? req.user._id : null;
      }

      // One pinned answer per thread: pinning this one unpins its siblings.
      if (pinning === true) {
        await DiscussionPost.updateMany(
          { 'anchor.type': post.anchor?.type, 'anchor.id': post.anchor?.id, _id: { $ne: post._id }, is_pinned: true },
          { $set: { is_pinned: false } }
        );
      }

      const updated = await DiscussionPost.findByIdAndUpdate(post._id, { $set: set }, { new: true }).lean();

      if (hiding !== null && Boolean(post.is_hidden) !== hiding) {
        await recordAudit(req, {
          action: hiding ? 'discussion.hidden' : 'discussion.unhidden',
          target_type: 'discussion_post',
          target_id: post._id,
          target_label: excerpt(post.body),
          before: { is_hidden: Boolean(post.is_hidden), hidden_reason: post.hidden_reason || '' },
          after: { is_hidden: hiding, hidden_reason: set.hidden_reason },
        });
        if (hiding) {
          const author = await User.findById(post.author_id).select('email').lean();
          if (author?.email) {
            await createNotification({
              userEmail: author.email,
              title: 'Your post was hidden',
              message: 'A moderator hid your post in a lecture discussion. Please keep posts respectful and on topic.',
              type: 'warning',
              link: DISCUSSION_LINK,
            });
          }
          await maybeMute(req, post.author_id);
        }
      }

      const row = updated || post;
      const authors = await loadAuthors([row]);
      return res.json({ post: shape(row, { user: req.user, moderator, authors }) });
    } catch (err) {
      reportError(req, err);
      return res.status(500).json({ error: 'Failed to update the post' });
    }
  }

  async function listReports(req, res) {
    try {
      const rows = await DiscussionPost.find({ $or: [{ report_count: { $gt: 0 } }, { is_hidden: true }] })
        .sort({ report_count: -1, created_date: -1 })
        .limit(REPORT_QUEUE_LIMIT)
        .lean();
      const authors = await loadAuthors(rows);
      const ctx = { user: req.user, moderator: isModerator(req.user), authors };
      // `anchor` so the queue can link to the lecture; `reports` so the
      // moderator sees who reported it and why.
      const posts = rows.map((post) => ({
        ...shape(post, ctx),
        anchor: post.anchor,
        parent_id: post.parent_id || null,
        reports: post.reports || [],
      }));
      return res.json({ posts });
    } catch (err) {
      reportError(req, err);
      return res.status(500).json({ error: 'Failed to load reported posts' });
    }
  }

  // Spec §6 mute rule: three hidden posts in 30 days pauses posting for 7
  // days. Called after a hide (by a moderator or by auto-reports).
  async function maybeMute(req, authorId) {
    const hidden = await DiscussionPost.find({
      author_id: authorId,
      is_hidden: true,
      hidden_reason: { $in: ['moderator', 'auto_reports'] },
    }).select('created_date').lean();
    const until = nextMuteUntil(hidden.map((p) => p.created_date));
    if (!until) return;
    const author = await User.findByIdAndUpdate(authorId, { $set: { discussion_muted_until: until } }, { new: true }).lean();
    await recordAudit(req, {
      action: 'discussion.user_muted',
      target_type: 'user',
      target_id: authorId,
      target_label: author?.email,
      after: { muted_until: until },
    });
    await createNotification({
      userEmail: author?.email,
      title: 'Posting paused',
      message: `Posting in discussions is paused until ${until.toDateString()} after several posts were hidden.`,
      type: 'warning',
      link: DISCUSSION_LINK,
    });
  }

  return { listThread, createPost, toggleUpvote, reportPost, updatePost, listReports };
}

module.exports = { createDiscussionsController };
