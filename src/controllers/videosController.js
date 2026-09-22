const Video = require('../models/Video');
const bunnyProvider = require('../services/video/bunnyProvider');
const { getProvider } = require('../services/video');
const { isValidTextLength } = require('../utils/validation');
const { validateSubjectIfConfigured } = require('../utils/subjects');
const { requestVideoSummary, requestVideoChat } = require('../services/tutorService');
const { getOpenAiKey } = require('../services/settingsService');
const { can } = require('../rbac/can');
const { missingUpdatePermissions } = require('../rbac/updatePermissions');
const { MAX_CHAT_MESSAGE_LENGTH } = require('../utils/security');
const { recordActiveStateChange, recordDeactivated } = require('../utils/audit');

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

function canAccessVideo(video, planName) {
  if (video.is_free) return true;
  const allowed = Array.isArray(video.allowed_plans) ? video.allowed_plans : [];
  if (allowed.length === 0) return true;
  return allowed.includes(planName);
}

// How long an upload claim (processing_status === 'uploading' with no
// bunny_video_id yet) is honoured before it's treated as abandoned and made
// reclaimable again. Must comfortably exceed how long a *live* claim can
// legitimately take — bounded by bunnyProvider's BUNNY_FETCH_TIMEOUT_MS
// (12s) for the createUpload call plus a save() — while staying short enough
// that an admin whose attempt crashed mid-claim isn't locked out for long.
const STALE_CLAIM_MS = 5 * 60 * 1000;

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
  const isStale = !Number.isFinite(updatedAtMs) || now - updatedAtMs >= staleMs;
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
  if (!video.bunny_video_id || video.processing_status !== 'ready') {
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

function createVideosController() {
  async function loadVideoForUser(user, videoId) {
    const video = await Video.findById(videoId).lean();
    if (!video) return { error: 'Video not found' };
    if (!can(user, 'CanViewVideos')) {
      if (!video.is_published || video.is_active === false) {
        return { error: 'Video not found' };
      }
      const planName = user?.subscription_plan || 'free';
      if (!canAccessVideo(video, planName)) {
        return { error: 'Upgrade required', status: 403 };
      }
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
        filter.is_published = true;
        filter.is_active = { $ne: false };
      }

      if (subject) {
        filter.subject = subject;
      }
      if (teacher_name) {
        filter.teacher_name = teacher_name;
      }
      if (teacher_email) {
        filter.teacher_email = teacher_email;
      }

      const videos = await Video.find(filter).sort({ created_date: -1 }).lean();
      if (all === 'true') {
        return res.json({ videos });
      }

      const planName = req.user?.subscription_plan || 'free';
      const visible = videos.filter((video) => canAccessVideo(video, planName));
      return res.json({ videos: visible });
    } catch (err) {
      console.error(err);
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
      if (!data.video_url || !isValidTextLength(String(data.video_url), 5, 500)) {
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

      const subjectName = await validateSubjectIfConfigured(data.subject);
      const video = await Video.create({
        title: data.title,
        description: data.description || '',
        subject: subjectName,
        teacher_name: data.teacher_name,
        teacher_email: data.teacher_email || '',
        subtopic: data.subtopic || '',
        order: data.order !== undefined ? Number(data.order) : 0,
        video_url: data.video_url,
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
      console.error(err);
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
        updates.subject = await validateSubjectIfConfigured(updates.subject);
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
      console.error(err);
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
      console.error(err);
      return res.status(500).json({ error: 'Failed to deactivate video' });
    }
  }

  async function getVideoSummary(req, res) {
    try {
      const { value } = await getOpenAiKey();
      if (!value) {
        return res.status(400).json({ error: 'Tutor service is not configured' });
      }
      const { video, error, status } = await loadVideoForUser(req.user, req.params.id);
      if (!video) {
        return res.status(status || 404).json({ error });
      }
      const summary = await requestVideoSummary(video);
      return res.json({ summary });
    } catch (err) {
      console.error(err);
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
            created = await bunnyProvider.createUpload({ title: claimed.title });
          } catch (createErr) {
            // Nothing was created upstream yet, so there's nothing to
            // orphan — unlike the save() failure below, where a real Bunny
            // video already exists. Release the claim so an ordinary,
            // recoverable failure (a Bunny 500, a timeout) doesn't lock the
            // admin out for the rest of STALE_CLAIM_MS; that window exists
            // to recover from a crashed process, not this case, where we're
            // still running and can clean up after ourselves.
            try {
              await Video.updateOne(
                { _id: claimed._id },
                { $set: { processing_status: previousStatus } }
              );
            } catch (releaseErr) {
              // The release failing is how a row ends up stuck at
              // 'uploading' in the first place. Log it, but let the real
              // error (createErr) surface below rather than masking it.
              console.error('Failed to release upload claim after createUpload error', {
                video_id: String(claimed._id),
                error: releaseErr,
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
            console.error('Bunny upload created but not persisted — orphaned Bunny video', {
              video_id: String(claimed._id),
              bunny_video_id: videoId,
              bunny_library_id: libraryId,
              error: saveErr,
            });
            return res.status(500).json({ error: 'Failed to start upload' });
          }
        }
      }

      return res.json(bunnyProvider.createUploadCredentials({ libraryId, videoId }));
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to start upload' });
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
      const { video, error, status } = await loadVideoForUser(req.user, req.params.id);
      if (!video) {
        return res.status(status || 404).json({ error });
      }
      const answer = await requestVideoChat(message.trim(), video, req.body?.history);
      return res.json({ answer });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to generate response' });
    }
  }

  async function getPlayback(req, res) {
    try {
      const { video, error, status } = await loadVideoForUser(req.user, req.params.id);
      if (!video) return res.status(status || 404).json({ error });
      const result = playbackResponse(video);
      return res.status(result.status).json(result.body);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to start playback' });
    }
  }

  return {
    listVideos,
    createVideo,
    updateVideo,
    deleteVideo,
    getVideoSummary,
    chatAboutVideo,
    createUploadUrl,
    getPlayback,
  };
}

module.exports = { createVideosController, decideUploadClaim, playbackResponse };
