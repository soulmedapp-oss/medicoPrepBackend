const crypto = require('crypto');

const {
  ZOOM_WEBHOOK_SECRET_TOKEN,
  ZOOM_ACCOUNT_ID,
  ZOOM_CLIENT_ID,
  ZOOM_CLIENT_SECRET,
} = process.env;

let accessTokenCache = {
  token: null,
  expiresAt: 0,
};

function verifyZoomWebhookSignature(rawBody, headers = {}) {
  if (!ZOOM_WEBHOOK_SECRET_TOKEN) return false;
  const signature = headers['x-zm-signature'];
  const timestamp = headers['x-zm-request-timestamp'];
  if (!signature || !timestamp || !rawBody) return false;
  const message = `v0:${timestamp}:${rawBody}`;
  const hash = crypto
    .createHmac('sha256', ZOOM_WEBHOOK_SECRET_TOKEN)
    .update(message)
    .digest('hex');
  const expected = `v0=${hash}`;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function buildZoomValidationResponse(plainToken) {
  const encryptedToken = crypto
    .createHmac('sha256', ZOOM_WEBHOOK_SECRET_TOKEN || '')
    .update(plainToken)
    .digest('hex');
  return { plainToken, encryptedToken };
}

function zoomTokenConfigured() {
  return Boolean(ZOOM_ACCOUNT_ID && ZOOM_CLIENT_ID && ZOOM_CLIENT_SECRET);
}

async function getZoomAccessToken() {
  if (!zoomTokenConfigured()) return null;
  if (accessTokenCache.token && accessTokenCache.expiresAt > Date.now() + 60000) {
    return accessTokenCache.token;
  }
  const credentials = Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString('base64');
  const url = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(
    ZOOM_ACCOUNT_ID
  )}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Zoom token request failed: ${body}`);
  }
  const data = await response.json();
  accessTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in || 0) * 1000),
  };
  return accessTokenCache.token;
}

function pickRecording(files = []) {
  if (!Array.isArray(files)) return null;
  const mp4 = files.find((file) => file.file_type === 'MP4');
  return mp4 || files[0] || null;
}

async function createZoomMeeting(payload) {
  const token = await getZoomAccessToken();
  if (!token) {
    throw new Error('Zoom credentials not configured');
  }
  const response = await fetch('https://api.zoom.us/v2/users/me/meetings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Zoom meeting create failed: ${body}`);
  }
  return response.json();
}

module.exports = {
  verifyZoomWebhookSignature,
  buildZoomValidationResponse,
  getZoomAccessToken,
  pickRecording,
  zoomTokenConfigured,
  createZoomMeeting,
};
