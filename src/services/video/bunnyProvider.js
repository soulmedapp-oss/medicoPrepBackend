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

// TTL must outlast the lecture itself: a student who pauses a 3-hour revision
// video would otherwise have playback die partway through.
function getPlaybackToken(video, { now = Math.floor(Date.now() / 1000) } = {}) {
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

module.exports = { config, buildPlaybackToken, buildUploadSignature, getPlaybackToken };
