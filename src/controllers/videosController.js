const Video = require('../models/Video');
const User = require('../models/User');
const Playlist = require('../models/Playlist');
const VideoProgress = require('../models/VideoProgress');
const DiscussionPost = require('../models/DiscussionPost');
const { isLecturePlayable } = require('../utils/playlistAccess');
const { viewerFor } = require('../utils/entitlement');
const { STUDENT_LECTURE_FIELDS } = require('../utils/studentProjection');
const bunnyProvider = require('../services/video/bunnyProvider');
const { getProvider } = require('../services/video');
const { applyBunnyStatusTransition } = require('../services/video/statusTransition');
const { isValidTextLength } = require('../utils/validation');
const { resolveSubjectForWrite } = require('../utils/subjects');
const { subjectWriteFields, buildSubjectFilter } = require('../utils/subjectResolution');
const { requestVideoSummary, requestVideoChat } = require('../services/tutorService');
const { getOpenAiKey } = require('../services/settingsService');
const { can } = require('../rbac/can');
const { missingUpdatePermissions } = require('../rbac/updatePermissions');
const { MAX_CHAT_MESSAGE_LENGTH } = require('../utils/security');
const { recordActiveStateChange, recordDeactivated, recordAudit } = require('../utils/audit');
const { reportError } = require('../lib/errorReporter.js');
const { logger } = require('../lib/logger');

const UPDATABLE_VIDEO_FIELDS = [
  'title',
  'description',
  'subject',
  'teacher_name',
  'teacher_email',
  'subtopic',
  'order',
  'video_url',
  'thumbnail_url',
  'card_thumbnail_url',
  'transcript_text',
  'transcript_url',
  'is_published',
  'is_active',
  'allowed_plans',
];

function pickFields(source, fields) {
  const out = {};
  fields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(source || {}, field)) {
      out[field] = source[field];
    }
  });
  return out;
}

// Pure: given the staff-path video page and a Map of userId string -> user
// doc ({ _id, full_name }), returns new video objects carrying three flat
// fields for the admin UI — created_by_name, updated_by_name and
// updated_by_at (passed through as-is). Never mutates the input videos.
// A missing/deleted user (absent from the map) yields null rather than
// throwing, and only _id/full_name ever reach the output — no email, no
// other user field.
function attachActorNames(videos, userMap) {
  const nameFor = (id) => {
    if (!id) return null;
    const user = userMap instanceof Map ? userMap.get(String(id)) : undefined;
    return user && user.full_name ? user.full_name : null;
  };
  return videos.map((video) => ({
    ...video,
    created_by_name: nameFor(video.created_by),
    updated_by_name: nameFor(video.updated_by),
    updated_by_at: video.updated_by_at || null,
  }));
}

// How long an upload claim (processing_status === 'uploading' with no
// bunny_video_id yet) is honoured before it's treated as abandoned and made
// reclaimable again. Must comfortably exceed how long a *live* claim can
// legitimately take — bounded by bunnyProvider's BUNNY_FETCH_TIMEOUT_MS
// (12s) for the createUpload call plus a save() — while staying short enough
// that an admin whose attempt crashed mid-claim isn't locked out for long.
const STALE_CLAIM_MS = 5 * 60 * 1000;

// Pure: decides a new video row's provider from the untrusted request body,
// and whether video_url is required for it. The raw value is never trusted
// straight into the enum — anything other than the literal string 'bunny'
// becomes 'youtube' (the schema's own default), so a typo'd or missing
// provider can't slip past validation into an unexpected state. A bunny row
// has no video_url at all (the asset lives on Bunny, addressed by
// bunny_video_id once uploaded), so video_url is only required for youtube.
function resolveVideoCreateProvider(data) {
  const provider = data && data.provider === 'bunny' ? 'bunny' : 'youtube';
  return { provider, videoUrlRequired: provider !== 'bunny' };
}

// Pure: should createUploadUrl's reuse branch (there is already a
// bunny_video_id to hand tus credentials for) reopen a failed row's state
// machine before returning those credentials? Only when the row's last
// known status is exactly 'failed' — the one deliberate-retry exception to
// nextProcessingStatus's terminal guard, which stays untouched (and correct
// for webhooks) precisely because this check lives at the call site instead.
function shouldReopenFailedUpload({ bunnyVideoId, processingStatus }) {
  return Boolean(bunnyVideoId) && processingStatus === 'failed';
}

// Pure mirror of the Mongo filter used in createUploadUrl's atomic claim
// below: given a video row's claim-relevant fields, does the filter match
// (this caller may proceed to create a Bunny video), or not (either another
// caller already holds a live claim, or this row already has a real Bunny
// video to reuse)? Exists so the staleness/status boundary logic is
// unit-testable without a database. It does not itself provide the
// atomicity guarantee — that comes from Mongo evaluating the equivalent
// filter+update as a single operation in createUploadUrl — so the two must
// be kept in lockstep by hand; this function reads, it never writes.
function decideUploadClaim({ bunnyVideoId, processingStatus, updatedAt, now = Date.now(), staleMs = STALE_CLAIM_MS }) {
  if (bunnyVideoId) return 'reuse';
  const updatedAtMs = updatedAt instanceof Date ? updatedAt.getTime() : new Date(updatedAt).getTime();
  // Strictly greater than, to agree exactly with the Mongo filter below:
  // `updated_date: { $lt: cutoff }` (cutoff = now - staleMs) only matches
  // once the row's age is strictly greater than staleMs, not at the boundary.
  const isStale = !Number.isFinite(updatedAtMs) || now - updatedAtMs > staleMs;
  if (processingStatus !== 'uploading' || isStale) return 'claim';
  return 'wait';
}

// Pure: maps an already-authorised video to its playback response.
//
// The bunny_video_id check must run before the processing_status check: a
// freshly created bunny row takes the schema default processing_status:
// 'ready' while bunny_video_id is still '' (nothing has been uploaded yet).
// That row would pass a processing_status-only check and reach
// getPlaybackToken, which throws on an empty bunny_video_id — turning an
// ordinary "not uploaded yet" state into a 500 instead of a clear 409.
function playbackResponse(video) {
  if (video.provider !== 'bunny') {
    return { status: 200, body: { provider: 'youtube', video_url: video.video_url } };
  }
  if (!video.bunny_video_id) {
    // With no webhook reconciliation in place, this warn line is the only
    // server-side signal that distinguishes "nothing has been uploaded yet /
    // the upload never made it" from the ready-but-not-yet-encoded case below
    // — both return the identical client-facing 409 so we never leak upload
    // state to the browser.
    logger.warn({ video_id: String(video._id) }, 'playbackResponse: bunny video has no bunny_video_id yet');
    return {
      status: 409,
      body: { error: 'This lecture is still being processed. Try again in a few minutes.' },
    };
  }
  if (video.processing_status !== 'ready') {
    logger.warn(
      { video_id: String(video._id), processing_status: video.processing_status },
      'playbackResponse: bunny video not ready'
    );
    return {
      status: 409,
      body: { error: 'This lecture is still being processed. Try again in a few minutes.' },
    };
  }
  const {
    hls_url: hlsUrl,
    token,
    token_path: tokenPath,
    expires_at: expiresAt,
  } = getProvider('bunny').getPlaybackToken(video);
  // token_path must reach the client: Bunny's CDN token is a directory
  // token whose signed message covers token_path, and the player must send
  // it back as a query parameter on every request or playback 403s — see
  // Fix round 1 in task-9-report.md for the live-CDN verification.
  return {
    status: 200,
    body: { provider: 'bunny', hls_url: hlsUrl, token, token_path: tokenPath, expires_at: expiresAt },
  };
}

// Task 5 — pure: the playback entitlement decision, extracted so it is
// testable without a database and so the handler below can call the exact
// function pinned by tests (Review Focus #1). Its output shape
// ({ error } or { error, status }) is what every handler behind this gate
// expects, so the "no video -> res.status(status || 404)" handling in
// getPlayback/getVideoSummary/chatAboutVideo needs no per-handler change.
//
// Staff (CanViewVideos) bypass is unchanged from today: they may preview any
// active lecture regardless of playlists. Everyone else needs the lecture to
// be active AND playable through at least one published, active playlist
// they're entitled to (isLecturePlayable) — which is now the only
// entitlement rule in the file; the lecture's own is_published/allowed_plans
// decide nothing. A lecture in no playlist therefore falls through to the
// same clean "Upgrade required" 403 an unentitled lecture gets today — never
// a thrown error, never a token.
function resolvePlaybackAccess({ lecture, playlists, viewer, isStaff }) {
  if (!lecture) return { allowed: false, status: 404, error: 'Video not found' };
  if (lecture.is_active === false) {
    return { allowed: false, status: 404, error: 'Video not found' };
  }
  if (isStaff) {
    return { allowed: true };
  }
  if (!isLecturePlayable(lecture, playlists, viewer)) {
    return { allowed: false, status: 403, error: 'Upgrade required' };
  }
  return { allowed: true };
}

// The state precondition for a hard delete, kept pure so it is testable and
// so the impact preview and the delete itself cannot disagree.
function canHardDelete(video) {
  return Boolean(video) && video.is_active === false;
}

function createVideosController() {
  // The ONE per-lecture gate (spec §5): playback, ai-summary and ai-chat all
  // come through here. Candidate playlists are loaded with exactly one query
  // — never one query per playlist — and only for non-staff callers, since
  // the staff bypass never needs them.
  //
  // Final fix wave, B1: the AI endpoints used to run a separate, per-video
  // gate (loadVideoForUser -> canAccessVideo, reading the lecture's own
  // is_published/allowed_plans). Two gates for one question is one gate too
  // many, and the per-video one was about to become "everyone" the moment
  // Task 8 drops those fields — which would have silently shipped "any
  // student may use the AI tutor on any lecture". Both now resolve through
  // resolvePlaybackAccess, so a lecture is answerable exactly when it is
  // playable, and there is a single place left to get this wrong.
  async function loadVideoForPlayback(user, videoId) {
    const video = await Video.findById(videoId).lean();
    if (!video) return { error: 'Video not found' };
    const isStaff = can(user, 'CanViewVideos');
    let playlists = [];
    if (!isStaff) {
      playlists = await Playlist.find({
        'items.lecture_id': video._id,
        is_published: true,
        is_active: { $ne: false },
      }).lean();
    }
    const viewer = isStaff ? null : await viewerFor(user);
    const decision = resolvePlaybackAccess({ lecture: video, playlists, viewer, isStaff });
    if (!decision.allowed) {
      return { error: decision.error, status: decision.status };
    }
    return { video };
  }

  async function listVideos(req, res) {
    try {
      const { all, subject, teacher_name, teacher_email } = req.query;
      const filter = {};

      if (all === 'true') {
        if (!can(req.user, 'CanViewVideos')) {
          return res.status(403).json({ error: 'Staff access required' });
        }
      } else {
        // Final fix wave, B1: is_published is deliberately NOT part of the
        // student filter any more. The playlist is the single entitlement
        // gate (spec §5) — a lecture is visible iff it is active AND a
        // published, accessible playlist carries it — and keeping the old
        // per-video is_published predicate here would make this list
        // disagree with /videos/:id/playback about the very same lecture.
        filter.is_active = { $ne: false };
      }

      if (subject) {
        // Filter on subject_id, not the display string — but an unmatched or
        // inactive subject name must filter to NOTHING (buildSubjectFilter's
        // { _id: null }), the same zero-result outcome a plain string filter
        // gave before. It must never fall through to an unfiltered list.
        let resolvedSubject = null;
        try {
          resolvedSubject = await resolveSubjectForWrite(subject);
        } catch (err) {
          if (err.code !== 'SUBJECT_INACTIVE') throw err;
          resolvedSubject = null;
        }
        Object.assign(filter, buildSubjectFilter(resolvedSubject));
      }
      if (teacher_name) {
        filter.teacher_name = teacher_name;
      }
      if (teacher_email) {
        filter.teacher_email = teacher_email;
      }

      // The staff branch keeps the whole document (Video Management needs
      // every field); the student branch is projected down to the shared
      // allowlist — see studentProjection.js — so no list read can leak a
      // bunny id, a transcript or staff provenance.
      const videos =
        all === 'true'
          ? await Video.find(filter).sort({ created_date: -1 }).lean()
          : await Video.find(filter).select(STUDENT_LECTURE_FIELDS).sort({ created_date: -1 }).lean();
      if (all === 'true') {
        const userIds = new Set();
        videos.forEach((video) => {
          if (video.created_by) userIds.add(String(video.created_by));
          if (video.updated_by) userIds.add(String(video.updated_by));
        });
        const users = userIds.size
          ? await User.find({ _id: { $in: Array.from(userIds) } }).select('_id full_name').lean()
          : [];
        const userMap = new Map(users.map((user) => [String(user._id), user]));
        return res.json({ videos: attachActorNames(videos, userMap) });
      }

      // Same gate as resolvePlaybackAccess, list-shaped: the staff bypass is
      // the identical can(req.user, 'CanViewVideos') check, and everyone else
      // keeps only lectures a published, active, accessible playlist carries.
      // The candidate playlists are loaded with ONE query for the whole page
      // — never one per lecture.
      const isStaff = can(req.user, 'CanViewVideos');
      if (isStaff) {
        return res.json({ videos });
      }
      const viewer = await viewerFor(req.user);
      const playlists = await Playlist.find({
        is_published: true,
        is_active: { $ne: false },
      })
        .select('items allowed_plans is_free is_published is_active')
        .lean();
      const visible = videos.filter((video) => isLecturePlayable(video, playlists, viewer));
      return res.json({ videos: visible });
    } catch (err) {
      reportError(req, err);
      return res.status(500).json({ error: 'Failed to load videos' });
    }
  }

  async function createVideo(req, res) {
    try {
      const data = req.body || {};
      if (!data.title || !isValidTextLength(String(data.title), 2, 200)) {
        return res.status(400).json({ error: 'title must be between 2 and 200 characters' });
      }
      if (!data.subject || !isValidTextLength(String(data.subject), 2, 120)) {
        return res.status(400).json({ error: 'subject is required' });
      }
      if (!data.teacher_name || !isValidTextLength(String(data.teacher_name), 2, 120)) {
        return res.status(400).json({ error: 'teacher_name is required' });
      }
      if (data.teacher_email && !isValidTextLength(String(data.teacher_email), 3, 200)) {
        return res.status(400).json({ error: 'teacher_email must be between 3 and 200 characters' });
      }
      if (data.subtopic && !isValidTextLength(String(data.subtopic), 2, 200)) {
        return res.status(400).json({ error: 'subtopic must be between 2 and 200 characters' });
      }
      if (data.order !== undefined && Number.isNaN(Number(data.order))) {
        return res.status(400).json({ error: 'order must be a number' });
      }
      const { provider, videoUrlRequired } = resolveVideoCreateProvider(data);
      if (videoUrlRequired && (!data.video_url || !isValidTextLength(String(data.video_url), 5, 500))) {
        return res.status(400).json({ error: 'video_url is required' });
      }
      if (data.thumbnail_url && !isValidTextLength(String(data.thumbnail_url), 5, 500)) {
        return res.status(400).json({ error: 'thumbnail_url must be between 5 and 500 characters' });
      }
      if (data.card_thumbnail_url && !isValidTextLength(String(data.card_thumbnail_url), 5, 500)) {
        return res.status(400).json({ error: 'card_thumbnail_url must be between 5 and 500 characters' });
      }
      if (data.transcript_url && !isValidTextLength(String(data.transcript_url), 5, 500)) {
        return res.status(400).json({ error: 'transcript_url must be between 5 and 500 characters' });
      }
      if (data.transcript_text && !isValidTextLength(String(data.transcript_text), 5, 200000)) {
        return res.status(400).json({ error: 'transcript_text is too long' });
      }

      const allowedPlans = Array.isArray(data.allowed_plans)
        ? data.allowed_plans.map((p) => String(p).trim()).filter(Boolean)
        : [];
      const isFreePlan = allowedPlans.includes('free');

      // subject_id is never taken from the client — it is set only from the
      // server-resolved subject below. subject (the display name) is kept in
      // step with it until the string column is dropped (Task 5), so a
      // rollback needs no data repair.
      const subjectName = String(data.subject || '').trim();
      const resolvedSubject = await resolveSubjectForWrite(data.subject);
      const video = await Video.create({
        title: data.title,
        description: data.description || '',
        subject: subjectName,
        ...subjectWriteFields(resolvedSubject),
        teacher_name: data.teacher_name,
        teacher_email: data.teacher_email || '',
        subtopic: data.subtopic || '',
        order: data.order !== undefined ? Number(data.order) : 0,
        video_url: data.video_url || '',
        provider,
        thumbnail_url: data.thumbnail_url || '',
        card_thumbnail_url: data.card_thumbnail_url || '',
        transcript_url: data.transcript_url || '',
        transcript_text: data.transcript_text || '',
        is_published: Boolean(data.is_published),
        is_active: data.is_active !== false,
        allowed_plans: allowedPlans,
        is_free: isFreePlan,
        created_by: req.userId,
      });

      return res.status(201).json({ video });
    } catch (err) {
      reportError(req, err);
      return res.status(500).json({ error: 'Failed to create video' });
    }
  }

  async function updateVideo(req, res) {
    try {
      const updates = pickFields(req.body, UPDATABLE_VIDEO_FIELDS);
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No updatable fields provided' });
      }
      if (updates.title && !isValidTextLength(String(updates.title), 2, 200)) {
        return res.status(400).json({ error: 'title must be between 2 and 200 characters' });
      }
      if (updates.subject && !isValidTextLength(String(updates.subject), 2, 120)) {
        return res.status(400).json({ error: 'subject must be between 2 and 120 characters' });
      }
      if (updates.subject) {
        // Same rule as createVideo: subject_id always comes from the
        // server-resolved subject, never from req.body — subject_id is
        // deliberately absent from UPDATABLE_VIDEO_FIELDS so a client can
        // never write an arbitrary id directly.
        const resolvedSubject = await resolveSubjectForWrite(updates.subject);
        updates.subject = String(updates.subject).trim();
        Object.assign(updates, subjectWriteFields(resolvedSubject));
      }
      if (updates.teacher_name !== undefined && !isValidTextLength(String(updates.teacher_name), 2, 120)) {
        return res.status(400).json({ error: 'teacher_name is required' });
      }
      if (updates.teacher_email && !isValidTextLength(String(updates.teacher_email), 3, 200)) {
        return res.status(400).json({ error: 'teacher_email must be between 3 and 200 characters' });
      }
      if (updates.subtopic && !isValidTextLength(String(updates.subtopic), 2, 200)) {
        return res.status(400).json({ error: 'subtopic must be between 2 and 200 characters' });
      }
      if (updates.order !== undefined && Number.isNaN(Number(updates.order))) {
        return res.status(400).json({ error: 'order must be a number' });
      }
      if (updates.video_url && !isValidTextLength(String(updates.video_url), 5, 500)) {
        return res.status(400).json({ error: 'video_url must be between 5 and 500 characters' });
      }
      if (updates.thumbnail_url && !isValidTextLength(String(updates.thumbnail_url), 5, 500)) {
        return res.status(400).json({ error: 'thumbnail_url must be between 5 and 500 characters' });
      }
      if (updates.card_thumbnail_url && !isValidTextLength(String(updates.card_thumbnail_url), 5, 500)) {
        return res.status(400).json({ error: 'card_thumbnail_url must be between 5 and 500 characters' });
      }
      if (updates.transcript_url && !isValidTextLength(String(updates.transcript_url), 5, 500)) {
        return res.status(400).json({ error: 'transcript_url must be between 5 and 500 characters' });
      }
      if (updates.transcript_text && !isValidTextLength(String(updates.transcript_text), 5, 200000)) {
        return res.status(400).json({ error: 'transcript_text is too long' });
      }
      if (updates.allowed_plans) {
        updates.allowed_plans = Array.isArray(updates.allowed_plans)
          ? updates.allowed_plans.map((p) => String(p).trim()).filter(Boolean)
          : [];
        updates.is_free = updates.allowed_plans.includes('free');
      }
      if (updates.order !== undefined) {
        updates.order = Number(updates.order);
      }

      const existing = await Video.findById(req.params.id).lean();
      if (!existing) {
        return res.status(404).json({ error: 'Video not found' });
      }

      const missing = missingUpdatePermissions(req.user, updates, existing, { edit: 'CanEditVideos', deactivate: 'CanDeactivateVideos' });
      if (missing) return res.status(403).json({ error: 'Permission denied', required: missing });

      // updated_by/updated_by_at are written as a pair, only here — a human
      // hit this endpoint. The Bunny webhook, refresh-status, and the upload
      // claim/release paths all mutate processing_status without going
      // through updateVideo, so they never touch these two fields.
      updates.updated_by = req.userId;
      updates.updated_by_at = new Date();

      const video = await Video.findByIdAndUpdate(
        req.params.id,
        { $set: updates },
        { new: true }
      ).lean();
      if (!video) {
        return res.status(404).json({ error: 'Video not found' });
      }
      await recordActiveStateChange(req, { resource: 'video', before: existing, after: video, targetLabel: video.title });
      return res.json({ video });
    } catch (err) {
      reportError(req, err);
      return res.status(500).json({ error: 'Failed to update video' });
    }
  }

  async function deleteVideo(req, res) {
    try {
      const video = await Video.findById(req.params.id);
      if (!video) {
        return res.status(404).json({ error: 'Video not found' });
      }
      video.is_active = false;
      video.is_published = false;
      await video.save();
      await recordDeactivated(req, { resource: 'video', targetId: video._id, targetLabel: video.title });
      return res.json({ ok: true, video: video.toObject() });
    } catch (err) {
      reportError(req, err);
      return res.status(500).json({ error: 'Failed to deactivate video' });
    }
  }

  // Hard delete is the one irreversible action in the app, so it is gated
  // twice: a permission of its own (CanDeleteVideos, admin-only by default)
  // and a state precondition — the lecture must already be deactivated, so
  // students have stopped seeing it before the file is gone for good.
  async function deletionImpact(req, res) {
    try {
      const video = await Video.findById(req.params.id).lean();
      if (!video) {
        return res.status(404).json({ error: 'Video not found' });
      }
      const [playlists, progressCount] = await Promise.all([
        Playlist.find({ 'items.lecture_id': video._id }).select('_id name is_published').lean(),
        VideoProgress.countDocuments({ video_id: video._id }),
      ]);
      return res.json({
        video: { _id: video._id, title: video.title, provider: video.provider, is_active: video.is_active },
        can_delete: canHardDelete(video),
        playlists: playlists.map((p) => ({ _id: p._id, name: p.name, is_published: p.is_published })),
        progress_count: progressCount,
      });
    } catch (err) {
      reportError(req, err);
      return res.status(500).json({ error: 'Failed to load deletion impact' });
    }
  }

  // Order matters: Bunny first. If Bunny refuses, nothing local changes and
  // the operator sees a 502; a Bunny 404 (already removed in the dashboard)
  // lets the local cleanup proceed. Then playlists, progress, the row, and
  // an audit entry that names what was in it — the only record left.
  async function permanentlyDeleteVideo(req, res) {
    try {
      const video = await Video.findById(req.params.id).lean();
      if (!video) {
        return res.status(404).json({ error: 'Video not found' });
      }
      if (!canHardDelete(video)) {
        return res.status(409).json({ error: 'Deactivate the lecture before deleting it permanently' });
      }

      let bunny = { deleted: false, missing: false, skipped: true };
      if (video.provider === 'bunny' && video.bunny_video_id) {
        try {
          bunny = { ...(await bunnyProvider.deleteVideo(video.bunny_video_id)), skipped: false };
        } catch (err) {
          reportError(req, err, 'Bunny delete failed; local records untouched', {
            video_id: String(video._id),
            bunny_video_id: video.bunny_video_id,
          });
          return res.status(502).json({ error: 'Bunny refused to delete the video. Nothing was removed.' });
        }
      }

      const playlists = await Playlist.find({ 'items.lecture_id': video._id }).select('_id name').lean();
      const pulled = await Playlist.updateMany(
        { 'items.lecture_id': video._id },
        { $pull: { items: { lecture_id: video._id } }, $set: { updated_by: req.userId, updated_by_at: new Date() } }
      );
      const progress = await VideoProgress.deleteMany({ video_id: video._id });
      // The lecture's discussion thread goes with it (spec §8): deactivating a
      // lecture leaves the posts alone, but a hard delete leaves no anchor for
      // them to hang off, so they would be unreachable rows forever.
      const discussions = await DiscussionPost.deleteMany({ 'anchor.type': 'lecture', 'anchor.id': video._id });
      await Video.deleteOne({ _id: video._id });

      await recordAudit(req, {
        action: 'video.deleted',
        target_type: 'video',
        target_id: video._id,
        target_label: video.title,
        before: {
          title: video.title,
          subject: video.subject,
          subject_id: video.subject_id,
          provider: video.provider,
          video_url: video.video_url,
          bunny_video_id: video.bunny_video_id,
          bunny_library_id: video.bunny_library_id,
          duration_seconds: video.duration_seconds,
          created_by: video.created_by,
          created_date: video.created_date,
          playlists: playlists.map((p) => ({ _id: p._id, name: p.name })),
          progress_rows: progress.deletedCount,
          discussions_deleted: discussions.deletedCount,
        },
        after: { bunny },
      });

      return res.json({
        ok: true,
        bunny,
        playlists_updated: pulled.modifiedCount,
        progress_deleted: progress.deletedCount,
        discussions_deleted: discussions.deletedCount,
      });
    } catch (err) {
      reportError(req, err);
      return res.status(500).json({ error: 'Failed to delete video' });
    }
  }

  async function getVideoSummary(req, res) {
    try {
      const { value } = await getOpenAiKey();
      if (!value) {
        return res.status(400).json({ error: 'Tutor service is not configured' });
      }
      const { video, error, status } = await loadVideoForPlayback(req.user, req.params.id);
      if (!video) {
        return res.status(status || 404).json({ error });
      }
      const summary = await requestVideoSummary(video);
      return res.json({ summary });
    } catch (err) {
      reportError(req, err);
      return res.status(500).json({ error: 'Failed to generate summary' });
    }
  }

  async function createUploadUrl(req, res) {
    try {
      const video = await Video.findById(req.params.id);
      if (!video) return res.status(404).json({ error: 'Video not found' });
      if (video.provider !== 'bunny') {
        return res.status(400).json({ error: 'Not a hosted lecture' });
      }

      let videoId = video.bunny_video_id;
      let libraryId = video.bunny_library_id;

      if (shouldReopenFailedUpload({ bunnyVideoId: videoId, processingStatus: video.processing_status })) {
        // The admin explicitly picked a replacement file for a previously
        // failed encode (the UI only offers this when the row isn't ready).
        // That deliberate action is what makes reopening the state machine
        // safe here — nextProcessingStatus's terminal guard stays untouched
        // and still correctly ignores late/duplicate webhooks for every
        // other caller.
        video.processing_status = 'uploading';
        await video.save();
      }

      if (!videoId) {
        // Claim the "no Bunny video yet" slot atomically. A filter on
        // bunny_video_id alone would NOT be atomic in practice: the update
        // never touches bunny_video_id, so two near-simultaneous requests
        // both match, both flip processing_status to 'uploading', and both
        // proceed to createUpload() — the exact race this guard exists to
        // close. Instead the filter tests processing_status (and, via
        // updated_date, how long ago it was set) — the very field the update
        // changes — so a second request's filter genuinely fails once the
        // first has committed. A row stuck at 'uploading' with no
        // bunny_video_id (the process crashed between claiming and saving)
        // becomes reclaimable once updated_date is older than STALE_CLAIM_MS;
        // see decideUploadClaim above for the equivalent pure decision logic.
        // (updated_date is bumped by mongoose automatically on this query —
        // the Video schema's timestamps option covers findOneAndUpdate.)
        //
        // previousStatus is what the row was in before *this* claim — not
        // necessarily 'ready': a retry of a previously-failed upload, or a
        // video the encoding webhook already marked 'failed', starts from
        // whatever it was. If createUpload fails below, we release the claim
        // back to exactly this value rather than assuming a default.
        const previousStatus = video.processing_status;
        const staleCutoff = new Date(Date.now() - STALE_CLAIM_MS);
        const claimed = await Video.findOneAndUpdate(
          {
            _id: video._id,
            provider: 'bunny',
            bunny_video_id: '',
            $or: [
              { processing_status: { $ne: 'uploading' } },
              { updated_date: { $lt: staleCutoff } },
            ],
          },
          { $set: { processing_status: 'uploading' } },
          { new: true }
        );

        if (!claimed) {
          // Someone else holds a live (non-stale) claim. Re-read: if they've
          // already finished, reuse their bunny_video_id/library_id instead of
          // creating a second Bunny video; otherwise ask this caller to retry
          // rather than guessing or racing further.
          const current = await Video.findById(video._id);
          if (!current || !current.bunny_video_id) {
            return res.status(409).json({ error: 'Upload already starting, please retry' });
          }
          videoId = current.bunny_video_id;
          libraryId = current.bunny_library_id;
        } else {
          let created;
          try {
            created = await bunnyProvider.createUpload({ title: claimed.title, subject: claimed.subject });
          } catch (createErr) {
            // Bunny may or may not have created the video upstream before
            // this failed — a client-side AbortSignal.timeout or a non-2xx
            // received after Bunny already created it both throw here with
            // no video id to show for it, so we can't tell which happened.
            // Log what we know so a possible orphan is findable by hand, then
            // release the claim so an ordinary, recoverable failure (a Bunny
            // 500, a timeout) doesn't lock the admin out for the rest of
            // STALE_CLAIM_MS; that window exists to recover from a crashed
            // process, not this case, where we're still running and can
            // clean up after ourselves.
            reportError(req, createErr, 'Bunny createUpload failed — video may or may not have been created upstream', {
              video_id: String(claimed._id),
              title: claimed.title,
            });
            try {
              await Video.updateOne(
                { _id: claimed._id },
                { $set: { processing_status: previousStatus } }
              );
            } catch (releaseErr) {
              // The release failing is how a row ends up stuck at
              // 'uploading' in the first place. Log it, but let the real
              // error (createErr) surface below rather than masking it.
              reportError(req, releaseErr, 'Failed to release upload claim after createUpload error', {
                video_id: String(claimed._id),
              });
            }
            throw createErr;
          }
          videoId = created.videoId;
          libraryId = created.libraryId;

          try {
            claimed.bunny_video_id = videoId;
            claimed.bunny_library_id = libraryId;
            await claimed.save();
          } catch (saveErr) {
            // The Bunny video now exists upstream but our record never ended
            // up pointing at it. We can't recover it here, but we can make it
            // findable: log every id needed to reconcile it by hand instead of
            // losing it silently.
            reportError(req, saveErr, 'Bunny upload created but not persisted — orphaned Bunny video', {
              video_id: String(claimed._id),
              bunny_video_id: videoId,
              bunny_library_id: libraryId,
            });
            return res.status(500).json({ error: 'Failed to start upload' });
          }
        }
      }

      return res.json(bunnyProvider.createUploadCredentials({ libraryId, videoId }));
    } catch (err) {
      reportError(req, err);
      return res.status(500).json({ error: 'Failed to start upload' });
    }
  }

  // Recovery path for I2: if Bunny's webhook never verifies (wrong header,
  // wrong key, misconfiguration), a lecture can otherwise stay
  // uploading/processing forever — processing_status is settable by no other
  // API. This asks Bunny directly and applies the same transition logic the
  // webhook uses (applyBunnyStatusTransition), so the two can never disagree
  // about what a given Bunny status code means.
  async function refreshVideoStatus(req, res) {
    try {
      const video = await Video.findById(req.params.id);
      if (!video) return res.status(404).json({ error: 'Video not found' });
      if (video.provider !== 'bunny' || !video.bunny_video_id) {
        return res.status(400).json({ error: 'Not a hosted lecture with an upload in progress' });
      }

      let bunnyStatus;
      try {
        bunnyStatus = await bunnyProvider.getStatus(video.bunny_video_id);
      } catch (err) {
        reportError(req, err, 'Bunny getStatus failed during refresh-status', {
          video_id: String(video._id),
          bunny_video_id: video.bunny_video_id,
        });
        return res.status(502).json({ error: 'Unable to reach Bunny to refresh status' });
      }

      const next = await applyBunnyStatusTransition(video, bunnyStatus.status);
      (req.log || logger).info(
        {
          video_id: String(video._id),
          bunny_status: bunnyStatus.status,
          encode_progress: bunnyStatus.encode_progress,
          transition: next || 'none',
        },
        'Bunny status refreshed'
      );
      if (next === 'ready') {
        // Already have duration_seconds from the same getStatus call above —
        // unlike the webhook, no second Bunny call is needed here.
        video.duration_seconds = bunnyStatus.duration_seconds;
        await video.save();
      }

      return res.json({
        processing_status: video.processing_status,
        transcript_status: video.transcript_status,
        duration_seconds: video.duration_seconds,
      });
    } catch (err) {
      reportError(req, err);
      return res.status(500).json({ error: 'Failed to refresh status' });
    }
  }

  async function chatAboutVideo(req, res) {
    try {
      const { value } = await getOpenAiKey();
      if (!value) {
        return res.status(400).json({ error: 'Tutor service is not configured' });
      }
      const { message } = req.body || {};
      if (!message || typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'message is required' });
      }
      if (message.length > MAX_CHAT_MESSAGE_LENGTH) {
        return res.status(400).json({ error: `message must be ${MAX_CHAT_MESSAGE_LENGTH} characters or less` });
      }
      const { video, error, status } = await loadVideoForPlayback(req.user, req.params.id);
      if (!video) {
        return res.status(status || 404).json({ error });
      }
      const answer = await requestVideoChat(message.trim(), video, req.body?.history);
      return res.json({ answer });
    } catch (err) {
      reportError(req, err);
      return res.status(500).json({ error: 'Failed to generate response' });
    }
  }

  async function getPlayback(req, res) {
    try {
      const { video, error, status } = await loadVideoForPlayback(req.user, req.params.id);
      if (!video) return res.status(status || 404).json({ error });
      const result = playbackResponse(video);
      return res.status(result.status).json(result.body);
    } catch (err) {
      reportError(req, err);
      return res.status(500).json({ error: 'Failed to start playback' });
    }
  }

  return {
    // Exported so the discussions router can reuse the ONE playback gate
    // rather than growing a second copy of the entitlement rule.
    loadVideoForPlayback,
    listVideos,
    createVideo,
    updateVideo,
    deleteVideo,
    deletionImpact,
    permanentlyDeleteVideo,
    getVideoSummary,
    chatAboutVideo,
    createUploadUrl,
    refreshVideoStatus,
    getPlayback,
  };
}

module.exports = {
  createVideosController,
  canHardDelete,
  attachActorNames,
  decideUploadClaim,
  playbackResponse,
  resolvePlaybackAccess,
  resolveVideoCreateProvider,
  shouldReopenFailedUpload,
};
