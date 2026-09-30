const DiscussionPost = require('../models/DiscussionPost');
const User = require('../models/User');
const Video = require('../models/Video');
const { can } = require('../rbac/can');
const { loadPermissions } = require('../rbac/loadPermissions');
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
const QUESTION_QUEUE_LIMIT = 200;
// Every discussion notification points at the lecture page (spec §7) — deep
// linked to the lecture itself, which the Videos page opens as its watch view.
const DISCUSSION_LINK = '/Videos';
const discussionLink = (post) => (post?.anchor?.id ? `${DISCUSSION_LINK}?lecture=${post.anchor.id}` : DISCUSSION_LINK);

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

// Everything maybeMute/maybeUnmute need off an author in one projection: the
// address to notify, the mute already in force, and the role fields the
// permission loader reads (effective_permissions is derived, never stored).
const AUTHOR_FIELDS = 'email discussion_muted_until role roles permissions is_teacher';

function createDiscussionsController({ createNotification, loadVideoForPlayback }) {
  const isModerator = (user) => can(user, 'CanModerateDiscussions');

  // Resolves the anchor and applies the lecture gate. Returns { lecture } or
  // { status, error, body }. This is deliberately the SAME gate as playback
  // (spec §6): a lecture that 404s for playback must 404 for its thread —
  // and (Fix round 1) a locked lecture's 403 carries the same `body`
  // (upgradeRefusal's { error, code, lock }) playback does, so the client
  // can open the identical upgrade prompt for its discussion thread.
  //
  // Fix round 1, Critical 1: EVERY handler goes through here — the by-id
  // routes resolve the anchor off the post they loaded — so a student can
  // only upvote/report/edit inside a thread they may read.
  //
  // Fix round 1, ruling: a moderator bypasses playability. A role built from
  // legacy `manage_doubts` holds CanModerateDiscussions WITHOUT CanViewVideos,
  // so loadVideoForPlayback would run the student entitlement rule on them and
  // 404 the very lecture they are meant to moderate. Moderation is not
  // playback: the lecture still has to exist, it just does not have to be
  // playable by this caller.
  async function gate(user, anchorType, anchorId) {
    if (!ANCHOR_TYPES.has(anchorType) || !isValidObjectId(String(anchorId))) return { status: 400, error: 'Invalid anchor' };
    if (isModerator(user)) {
      const lecture = await Video.findById(anchorId).lean();
      if (!lecture) return { status: 404, error: 'Video not found' };
      return { lecture };
    }
    // Task 3: loadVideoForPlayback's 403 refusal now carries `body` (the
    // uniform upgradeRefusal shape) instead of a bare `error` string —
    // threaded through here so the discussions gate answers with the same
    // lock details playback does, not a generic 'Not found'.
    const { video, error, status, body } = await loadVideoForPlayback(user, anchorId);
    if (!video) return { status: status || 404, error: error || 'Not found', body };
    return { lecture: video };
  }

  // The gate for a post that is already loaded: its own anchor decides.
  const gateForPost = (user, post) => gate(user, post.anchor?.type, String(post.anchor?.id || ''));

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
      const { lecture, status, error, body } = await gate(req.user, anchorType, anchorId);
      if (!lecture) return res.status(status).json(body || { error });

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
      // Top level newest first — that is the query's sort, and `filter` keeps
      // it, so there is no second ordering here to disagree with it. Replies
      // are pinned -> teacher -> upvotes -> oldest (sortThread).
      // A reply whose parent is hidden is dropped with its parent for students,
      // since its parent is not in `rows` to hang it on.
      const posts = rows
        .filter((p) => !p.parent_id)
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
        // The time chip belongs to a question about a moment in the lecture;
        // a reply inherits its question's moment (spec §7).
        if (parentId) {
          return res.status(400).json({ error: 'video_time is only for a new question, not a reply' });
        }
      }

      const gated = await gate(req.user, anchorType, anchorId);
      if (!gated.lecture) return res.status(gated.status).json(gated.body || { error: gated.error });
      const { lecture } = gated;

      // A timestamp past the end of the lecture would seek nowhere, so cap it
      // at the known duration rather than refusing the post over a rounding
      // overshoot from the player.
      const duration = Number(lecture.duration_seconds);
      if (videoTime !== null && Number.isFinite(duration) && duration > 0) {
        videoTime = Math.min(videoTime, duration);
      }

      // `parent` is the post actually replied to — the notification goes to
      // its author — while `parent_id` is re-parented to the top-level post,
      // because depth is one level (spec §5).
      let parent = null;
      if (parentId) {
        parent = await DiscussionPost.findById(parentId).lean();
        if (!parent || parent.anchor?.type !== anchorType || String(parent.anchor?.id) !== anchorId) {
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

      // Fix round 2, Minor: a reply to a reply concerns TWO people — the
      // person answered and the person who asked the question — so both are
      // told, deduped, and never the replier themself.
      if (parent) {
        const recipients = new Set([String(parent.author_id)]);
        if (parent.parent_id) {
          const top = await DiscussionPost.findById(parent.parent_id).select('author_id').lean();
          if (top?.author_id) recipients.add(String(top.author_id));
        }
        recipients.delete(String(req.user._id));
        const who = isAnonymous ? 'Anonymous' : displayNameFor(req.user);
        const prefix = moderator ? 'Teacher ' : '';
        for (const recipientId of recipients) {
          // eslint-disable-next-line no-await-in-loop
          const recipient = await User.findById(recipientId).select('email').lean();
          if (recipient?.email) {
            // eslint-disable-next-line no-await-in-loop
            await createNotification({
              userEmail: recipient.email,
              title: 'New reply to your post',
              message: `${prefix}${who} replied to your question on ${lecture.title || 'a lecture'}.`,
              type: 'info',
              link: discussionLink(parent),
            });
          }
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
      const gated = await gateForPost(req.user, post);
      if (!gated.lecture) return res.status(gated.status).json(gated.body || { error: gated.error });
      const userId = String(req.user._id);
      if (String(post.author_id) === userId) {
        return res.status(400).json({ error: 'You cannot upvote your own post' });
      }
      const others = (post.upvotes || []).filter((u) => String(u) !== userId);
      const upvoted = others.length === (post.upvotes || []).length; // not mine yet -> add
      // { new: true } so the count returned is the stored one, not this
      // request's guess at it.
      const updated = await DiscussionPost.findByIdAndUpdate(
        post._id,
        upvoted ? { $addToSet: { upvotes: req.user._id } } : { $pull: { upvotes: req.user._id } },
        { new: true }
      ).lean();
      return res.json({ upvoted, upvote_count: (updated?.upvotes || []).length });
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
      const gated = await gateForPost(req.user, post);
      if (!gated.lecture) return res.status(gated.status).json(gated.body || { error: gated.error });

      // One report per user per post, and `report_count` in step with
      // `reports.length` — both in ONE conditional update, so two concurrent
      // reports from the same person cannot both pass a read-then-write check
      // (fix round 1, Important 3). A null result means "already reported".
      // Fix round 2, Critical 3: a reporter whose report was DISMISSED is
      // still remembered — they get the same idempotent answer and cannot
      // report again to re-trip the auto-hide a moderator just reversed.
      const updated = await DiscussionPost.findOneAndUpdate(
        { _id: post._id, 'reports.user_id': { $ne: req.user._id }, 'dismissed_reports.user_id': { $ne: req.user._id } },
        { $push: { reports: { user_id: req.user._id, reason, at: new Date() } }, $inc: { report_count: 1 } },
        { new: true }
      ).lean();
      if (!updated) return res.json({ ok: true, hidden: Boolean(post.is_hidden) });

      let hidden = Boolean(updated.is_hidden);
      // Fix round 2, Critical 2: staff are exempt from crowd moderation. A
      // teacher's reply is never auto-hidden — three students who dislike the
      // answer must not be able to remove it — the report is recorded and the
      // queue puts it in front of a human moderator instead.
      if (!hidden && !updated.is_teacher_reply && shouldAutoHide(updated.reports)) {
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
        const author = await User.findById(updated.author_id).select(AUTHOR_FIELDS).lean();
        if (author?.email) {
          await createNotification({
            userEmail: author.email,
            title: 'Your post was hidden',
            message: `Your post on ${gated.lecture.title || 'a lecture'} was hidden after reports from other students.`,
            type: 'warning',
            link: discussionLink(post),
          });
        }
        await maybeMute(req, updated.author_id, { trigger: 'auto_reports', author });
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
      const gated = await gateForPost(req.user, post);
      if (!gated.lecture) return res.status(gated.status).json(gated.body || { error: gated.error });
      const lectureTitle = gated.lecture.title || 'a lecture';

      const moderator = isModerator(req.user);
      // Fix round 2, Critical 3: `dismiss_reports` is a moderation decision
      // like pinning and hiding, so it belongs in the same gate — a student
      // sending it gets 403, not a silently ignored key.
      const wantsModeration = has('is_pinned') || has('is_hidden') || has('dismiss_reports');
      if (wantsModeration && !moderator) {
        return res.status(403).json({ error: 'Permission denied', required: ['CanModerateDiscussions'] });
      }
      if (has('body') && !canEditPost(post, req.user._id)) {
        return res.status(403).json({ error: 'You can only edit your own post, within 15 minutes of posting' });
      }
      // Fix round 2, Minor: an author cannot rewrite a post that has already
      // been hidden — the moderator judged the text that is there.
      if (has('body') && post.is_hidden) {
        return res.status(403).json({ error: 'This post is hidden' });
      }
      if (!wantsModeration && !has('body')) {
        return res.status(400).json({ error: 'Nothing to update' });
      }

      const set = {};
      const unset = {};
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
      const dismissing = has('dismiss_reports') && Boolean(updates.dismiss_reports);

      // Fix round 2, Important 1: the pin marks the accepted ANSWER, so only a
      // reply can carry it — a question is not its own answer — and a hidden
      // post must never be promoted to the top of its thread.
      if (pinning === true) {
        if (!post.parent_id) {
          return res.status(400).json({ error: 'Only a reply can be pinned as the answer' });
        }
        if (post.is_hidden) {
          return res.status(400).json({ error: 'A hidden post cannot be pinned' });
        }
      }

      if (pinning !== null) set.is_pinned = pinning;
      if (hiding !== null) {
        set.is_hidden = hiding;
        set.hidden_reason = hiding ? 'moderator' : '';
        set.hidden_by = hiding ? req.user._id : null;
      }

      // Fix round 2, Critical 3: Dismiss is a real decision, not a UI no-op.
      // The active reports MOVE to dismissed_reports (the history is kept, and
      // those reporters can never re-trip the auto-hide), and a post the crowd
      // hid comes back up. A post a moderator hid by hand stays hidden — only
      // its reports are cleared, so it leaves the queue.
      let dismissedRows = [];
      if (dismissing) {
        const dismissedAt = new Date();
        dismissedRows = (post.reports || []).map((report) => ({
          user_id: report.user_id, reason: report.reason, at: report.at, dismissed_at: dismissedAt,
        }));
        set.reports = [];
        set.report_count = 0;
        if (post.hidden_reason === 'auto_reports') {
          set.is_hidden = false;
          set.hidden_reason = '';
          // $set and $unset must never name the same path in one update.
          delete set.hidden_by;
          unset.hidden_by = '';
        }
      }

      // One pinned answer per QUESTION: pinning this reply unpins the other
      // replies to the same question, and leaves every other thread on the
      // lecture alone (fix round 2, Important 1 — `parent_id` was missing from
      // this filter, so pinning an answer under one question unpinned the
      // pinned answer of every other question on the lecture).
      if (pinning === true) {
        await DiscussionPost.updateMany(
          {
            'anchor.type': post.anchor?.type,
            'anchor.id': post.anchor?.id,
            parent_id: post.parent_id,
            _id: { $ne: post._id },
            is_pinned: true,
          },
          { $set: { is_pinned: false } }
        );
      }

      const updateOps = {};
      if (Object.keys(set).length > 0) updateOps.$set = set;
      if (Object.keys(unset).length > 0) updateOps.$unset = unset;
      if (dismissedRows.length > 0) updateOps.$push = { dismissed_reports: { $each: dismissedRows } };
      const updated = Object.keys(updateOps).length > 0
        ? await DiscussionPost.findByIdAndUpdate(post._id, updateOps, { new: true }).lean()
        : null;

      if (pinning !== null && Boolean(post.is_pinned) !== pinning) {
        await recordAudit(req, {
          action: pinning ? 'discussion.pinned' : 'discussion.unpinned',
          target_type: 'discussion_post',
          target_id: post._id,
          target_label: lectureTitle,
          before: { is_pinned: Boolean(post.is_pinned) },
          after: { is_pinned: pinning },
        });
      }

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
          // Loaded once and handed to maybeMute, which needs the same two
          // fields (email to notify, discussion_muted_until to not re-mute).
          const author = await User.findById(post.author_id).select(AUTHOR_FIELDS).lean();
          if (author?.email) {
            await createNotification({
              userEmail: author.email,
              title: 'Your post was hidden',
              message: `A moderator hid your post on ${lectureTitle}: it did not meet the discussion guidelines.`,
              type: 'warning',
              link: discussionLink(post),
            });
          }
          await maybeMute(req, post.author_id, { trigger: 'moderator', author });
        } else {
          // Fix round 2, Critical 1: reversing a hide can take the author back
          // under the mute threshold — if it does, the mute goes with it.
          await maybeUnmute(post.author_id);
        }
      }

      if (dismissing) {
        await recordAudit(req, {
          action: 'discussion.reports_dismissed',
          target_type: 'discussion_post',
          target_id: post._id,
          target_label: excerpt(post.body),
          before: {
            reports: post.reports || [],
            report_count: post.report_count || 0,
            is_hidden: Boolean(post.is_hidden),
            hidden_reason: post.hidden_reason || '',
          },
          after: {
            report_count: 0,
            is_hidden: Boolean((updated || post).is_hidden),
            hidden_reason: (updated || post).hidden_reason || '',
          },
        });
        // Dismissed reports are no longer a hide either, so the author may fall
        // back under the mute threshold here too (fix round 2, Critical 1).
        await maybeUnmute(post.author_id);
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
      const titleById = await lectureTitles(rows);
      // `anchor` so the queue can link to the lecture; `reports` so the
      // moderator sees who reported it and why.
      const posts = rows.map((post) => ({
        ...shape(post, ctx),
        anchor: post.anchor,
        anchor_label: titleById.get(String(post.anchor?.id || '')) || '',
        parent_id: post.parent_id || null,
        reports: post.reports || [],
      }));
      return res.json({ posts });
    } catch (err) {
      reportError(req, err);
      return res.status(500).json({ error: 'Failed to load reported posts' });
    }
  }

  // Fix round 2, Critical 3: queues carry the lecture TITLE, in ONE query
  // over the distinct anchors — the report queue page used to fetch the
  // entire video catalogue (/videos?all=true) just to name them.
  async function lectureTitles(posts) {
    const anchorIds = [...new Set(posts.map((post) => String(post.anchor?.id || '')).filter(Boolean))];
    const lectures = anchorIds.length ? await Video.find({ _id: { $in: anchorIds } }).select('title').lean() : [];
    return new Map(lectures.map((lecture) => [String(lecture._id), lecture.title || '']));
  }

  // The teacher's work queue: every visible question (top-level post) that no
  // teacher has replied to yet, newest first. "Answered" means a visible reply
  // whose author held CanModerateDiscussions when they wrote it — peer replies
  // do not close a question, and a hidden teacher reply does not count either.
  async function listUnanswered(req, res) {
    try {
      const questions = await DiscussionPost.find({ parent_id: null, is_hidden: { $ne: true } })
        .sort({ created_date: -1 })
        .limit(QUESTION_QUEUE_LIMIT)
        .lean();
      const ids = questions.map((post) => post._id);
      const replies = ids.length
        ? await DiscussionPost.find({ parent_id: { $in: ids }, is_hidden: { $ne: true } }).select('parent_id is_teacher_reply').lean()
        : [];
      const replyCount = new Map();
      const answered = new Set();
      replies.forEach((reply) => {
        const key = String(reply.parent_id);
        replyCount.set(key, (replyCount.get(key) || 0) + 1);
        if (reply.is_teacher_reply) answered.add(key);
      });
      const open = questions.filter((post) => !answered.has(String(post._id)));
      const authors = await loadAuthors(open);
      const ctx = { user: req.user, moderator: isModerator(req.user), authors };
      const titleById = await lectureTitles(open);
      const posts = open.map((post) => ({
        ...shape(post, ctx),
        anchor: post.anchor,
        anchor_label: titleById.get(String(post.anchor?.id || '')) || '',
        reply_count: replyCount.get(String(post._id)) || 0,
      }));
      return res.json({ posts });
    } catch (err) {
      reportError(req, err);
      return res.status(500).json({ error: 'Failed to load unanswered questions' });
    }
  }

  // Spec §6 mute rule: three hidden posts in 30 days pauses posting for 7
  // days, and the notification is sent ONCE (fix round 1, Important 1).
  // Called after a hide, by a moderator or by auto-reports; `author` is the
  // already-loaded author document where the caller has one.
  async function maybeMute(req, authorId, { trigger = 'moderator', author } = {}) {
    const target = author || await User.findById(authorId).select(AUTHOR_FIELDS).lean();
    // Already paused: every later hide inside the window would otherwise
    // extend the mute and notify again.
    if (activeMute(target)) return;
    // Fix round 2, Critical 2: staff are exempt from crowd moderation — a
    // moderator is never muted, or three students reporting the same teacher
    // answer could silence the very person meant to police the threads.
    // `effective_permissions` is derived, not stored, so it is resolved here
    // through the same loader authMiddleware uses.
    if (target) {
      const { permissions } = await loadPermissions(target);
      if (can({ effective_permissions: permissions }, 'CanModerateDiscussions')) return;
    }
    const hidden = await DiscussionPost.find({
      author_id: authorId,
      is_hidden: true,
      hidden_reason: { $in: ['moderator', 'auto_reports'] },
    }).select('created_date').lean();
    const until = nextMuteUntil(hidden.map((p) => p.created_date));
    if (!until) return;
    const muted = await User.findByIdAndUpdate(authorId, { $set: { discussion_muted_until: until } }, { new: true }).lean();
    const email = muted?.email || target?.email;
    await recordAudit(req, {
      action: 'discussion.user_muted',
      target_type: 'user',
      target_id: authorId,
      target_label: email,
      after: { muted_until: until, trigger },
    });
    await createNotification({
      userEmail: email,
      title: 'Posting paused',
      message: `Posting in discussions is paused until ${until.toDateString()} after several posts were hidden.`,
      type: 'warning',
      link: DISCUSSION_LINK,
    });
  }

  // Fix round 2, Critical 1: a mute must be liftable by undoing what caused
  // it. When a hide is reversed — unhidden by hand, or the reports behind an
  // auto-hide dismissed — the author can drop back under the threshold, and the
  // mute has to go with it. No notification and no audit row of its own: the
  // hide/unhide (or reports_dismissed) row already records the decision this
  // follows from.
  async function maybeUnmute(authorId) {
    const target = await User.findById(authorId).select('discussion_muted_until').lean();
    if (!activeMute(target)) return;
    const hidden = await DiscussionPost.find({
      author_id: authorId,
      is_hidden: true,
      hidden_reason: { $in: ['moderator', 'auto_reports'] },
    }).select('created_date').lean();
    // The same helper the mute itself uses, so the threshold and the 30-day
    // window are read from one place: null here IS "under MUTE_THRESHOLD".
    if (nextMuteUntil(hidden.map((p) => p.created_date))) return;
    await User.findByIdAndUpdate(authorId, { $unset: { discussion_muted_until: '' } });
  }

  return { listThread, createPost, toggleUpvote, reportPost, updatePost, listReports, listUnanswered };
}

module.exports = { createDiscussionsController };
