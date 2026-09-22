const crypto = require('node:crypto');

const DEFAULT_TTL_SECONDS = 4 * 60 * 60;

function config() {
  return {
    libraryId: process.env.BUNNY_STREAM_LIBRARY_ID || '',
    apiKey: process.env.BUNNY_STREAM_API_KEY || '',
    tokenKey: process.env.BUNNY_STREAM_TOKEN_KEY || '',
    cdnHostname: process.env.BUNNY_STREAM_CDN_HOSTNAME || '',
    ttl: Math.max(600, Number(process.env.BUNNY_PLAYBACK_TOKEN_TTL) || DEFAULT_TTL_SECONDS),
  };
}

const sha256Hex = (value) => crypto.createHash('sha256').update(value).digest('hex');

const base64Url = (buf) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

// Bunny CDN token authentication (V2), directory-scoped.
//
// HLS fetches one playlist then many segments. A token signed for the exact
// playlist path authorises only that file, so segment requests 403 and playback
// dies a few seconds in. Signing token_path=/<guid>/ covers every file beneath
// it — verified against the live library, along with the fact that token_path
// must appear INSIDE the signed message as well as on the URL.
function buildPlaybackToken({ tokenKey, videoId, expires }) {
  const tokenPath = `/${videoId}/`;
  const message = `${tokenPath}${expires}token_path=${tokenPath}`;
  return `HS256-${base64Url(crypto.createHmac('sha256', tokenKey).update(message).digest())}`;
}

function buildUploadSignature({ libraryId, apiKey, expires, videoId }) {
  return sha256Hex(`${libraryId}${apiKey}${expires}${videoId}`);
}

const TUS_ENDPOINT = 'https://video.bunnycdn.com/tusupload';
const UPLOAD_WINDOW_SECONDS = 24 * 60 * 60;

// Pure: takes its keys as arguments so tests can pass fakes without touching
// env or the network. The signature is derived from apiKey, but apiKey itself
// never appears in the returned payload — that's what ships to the browser.
function buildUploadPayload({ libraryId, apiKey, videoId, now = Math.floor(Date.now() / 1000) }) {
  const expires = now + UPLOAD_WINDOW_SECONDS;
  return {
    tus_endpoint: TUS_ENDPOINT,
    library_id: libraryId,
    video_id: videoId,
    expires,
    signature: buildUploadSignature({ libraryId, apiKey, expires, videoId }),
  };
}

// Thin wrapper: reads the raw apiKey out of module-private config() and hands
// buildUploadPayload just what it needs. This is the only sanctioned way for
// a caller (the controller) to get upload credentials — it never sees apiKey.
function createUploadCredentials({ libraryId, videoId }) {
  const { apiKey } = config();
  return buildUploadPayload({ libraryId, apiKey, videoId });
}

// TTL must outlast the lecture itself: a student who pauses a 3-hour revision
// video would otherwise have playback die partway through.
function getPlaybackToken(video, { now = Math.floor(Date.now() / 1000) } = {}) {
  if (!video || !video.bunny_video_id) {
    // A bunny-provider row mid-upload can have bunny_video_id === ''. Signing a
    // token over "//" fails silently downstream (a 403/404 in the player) with
    // no server-side attribution, so fail loudly here instead.
    throw new Error('getPlaybackToken requires a video with a bunny_video_id');
  }
  const { tokenKey, cdnHostname, ttl } = config();
  const videoId = video.bunny_video_id;
  const duration = Number(video.duration_seconds) || 0;
  const expires = now + Math.max(ttl, duration + 900);
  return {
    hls_url: `https://${cdnHostname}/${videoId}/playlist.m3u8`,
    token: buildPlaybackToken({ tokenKey, videoId, expires }),
    // The player must send token_path on every request, URL-encoded, or the
    // directory token is not matched and segments 403.
    token_path: `/${videoId}/`,
    expires_at: expires,
  };
}

// Without a timeout, a stalled Bunny call (DNS hang, no response) never
// settles the await — the try/catch around it never fires, and on Lambda
// that burns the whole function duration until a bare platform 504 with no
// application log at all. 12s is comfortably inside typical Lambda budgets
// while leaving headroom past normal Bunny API latency.
const BUNNY_FETCH_TIMEOUT_MS = 12000;

// name -> collection guid. Module-level so repeat uploads for the same
// subject (the common case — many lectures per subject) cost no extra Bunny
// calls after the first. Only ever written after a successful lookup/create
// below, never pre-seeded and never written on failure.
const collectionGuidCache = new Map();

// Finds or creates a Bunny Collection named exactly `name` in this library,
// so the dashboard can group lectures by subject instead of showing a flat
// list. This must never throw into the upload path: a lecture that uploads
// without a collection is fine, a lecture that fails to upload because
// collection bookkeeping broke is not — so every failure is caught, logged,
// and turned into a null return instead.
async function ensureCollection(name) {
  if (collectionGuidCache.has(name)) return collectionGuidCache.get(name);
  const { libraryId, apiKey } = config();
  try {
    const listResponse = await fetch(`https://video.bunnycdn.com/library/${libraryId}/collections`, {
      headers: { AccessKey: apiKey },
      signal: AbortSignal.timeout(BUNNY_FETCH_TIMEOUT_MS),
    });
    if (!listResponse.ok) throw new Error(`Bunny list collections failed (${listResponse.status})`);
    const listed = await listResponse.json();
    const items = Array.isArray(listed) ? listed : listed.items || [];
    const existing = items.find((item) => item && item.name === name && item.guid);
    if (existing) {
      collectionGuidCache.set(name, existing.guid);
      return existing.guid;
    }

    const createResponse = await fetch(`https://video.bunnycdn.com/library/${libraryId}/collections`, {
      method: 'POST',
      headers: { AccessKey: apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(BUNNY_FETCH_TIMEOUT_MS),
    });
    if (!createResponse.ok) throw new Error(`Bunny create collection failed (${createResponse.status})`);
    const created = await createResponse.json();
    if (!created.guid) throw new Error('Bunny create collection returned no guid');
    collectionGuidCache.set(name, created.guid);
    return created.guid;
  } catch (err) {
    console.error('ensureCollection failed — uploading without a collection', { name, error: err });
    return null;
  }
}

async function createUpload({ title, subject }) {
  const { libraryId, apiKey } = config();
  const body = { title };
  if (subject) {
    const collectionId = await ensureCollection(subject);
    if (collectionId) body.collectionId = collectionId;
  }
  const response = await fetch(`https://video.bunnycdn.com/library/${libraryId}/videos`, {
    method: 'POST',
    headers: { AccessKey: apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(BUNNY_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Bunny create video failed (${response.status})`);
  const created = await response.json();
  return { videoId: created.guid, libraryId };
}

async function getStatus(videoId) {
  const { libraryId, apiKey } = config();
  const response = await fetch(`https://video.bunnycdn.com/library/${libraryId}/videos/${videoId}`, {
    headers: { AccessKey: apiKey },
    signal: AbortSignal.timeout(BUNNY_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Bunny get video failed (${response.status})`);
  const video = await response.json();
  return {
    status: video.status,
    duration_seconds: video.length || 0,
    encode_progress: video.encodeProgress,
  };
}

// `config` stays module-private: it returns raw secrets (BUNNY_STREAM_API_KEY,
// BUNNY_STREAM_TOKEN_KEY). Exporting it would let a single
// `res.json(bunnyProvider.config())` downstream leak both. Callers that need
// upload credentials go through createUploadCredentials instead.
module.exports = {
  buildPlaybackToken,
  buildUploadSignature,
  getPlaybackToken,
  buildUploadPayload,
  createUploadCredentials,
  createUpload,
  ensureCollection,
  getStatus,
};
