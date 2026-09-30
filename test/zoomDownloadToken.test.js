// Zoom cloud-recording downloads are authorised with ?access_token= on the
// URL, never an Authorization header: Zoom answers a download with a 302 to a
// CDN host and fetch drops Authorization across that redirect, so the header
// approach 401s on exactly the files that redirect. `recording.completed`
// carries its own short-lived `download_token` scoped to that recording's
// files; the S2S account token is only the fallback.
//
// zoomService destructures process.env at require time, so the credentials are
// set before the require below. node --test gives each file its own process,
// so this cannot leak into another test file.
process.env.ZOOM_ACCOUNT_ID = 'test-account';
process.env.ZOOM_CLIENT_ID = 'test-client';
process.env.ZOOM_CLIENT_SECRET = 'test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tokenedDownloadUrl, downloadRecordingFile } = require('../src/services/zoomService');

test('tokenedDownloadUrl uses the webhook download token and makes no Zoom API call', async () => {
  const previousFetch = global.fetch;
  let called = false;
  global.fetch = async () => { called = true; throw new Error('should not be called'); };
  try {
    const url = await tokenedDownloadUrl('https://zoom.us/rec/download/abc', { token: 'DL-TOKEN' });
    assert.equal(url, 'https://zoom.us/rec/download/abc?access_token=DL-TOKEN');
    assert.equal(called, false, 'the download token needs no account token');
  } finally {
    global.fetch = previousFetch;
  }
});

test('tokenedDownloadUrl appends with & when the URL already has a query string', async () => {
  const url = await tokenedDownloadUrl('https://zoom.us/rec/download/abc?x=1', { token: 'DL/TOKEN+1' });
  assert.equal(url, 'https://zoom.us/rec/download/abc?x=1&access_token=DL%2FTOKEN%2B1');
});

test('tokenedDownloadUrl falls back to the S2S account token when the webhook carried none', async () => {
  const previousFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ access_token: 'ACCOUNT-TOKEN', expires_in: 3600 }) };
  };
  try {
    const url = await tokenedDownloadUrl('https://zoom.us/rec/download/abc');
    assert.equal(url, 'https://zoom.us/rec/download/abc?access_token=ACCOUNT-TOKEN');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /^https:\/\/zoom\.us\/oauth\/token\?grant_type=account_credentials/);
  } finally {
    global.fetch = previousFetch;
  }
});

test('downloadRecordingFile puts the token on the URL and sends no Authorization header', async () => {
  const previousFetch = global.fetch;
  let captured;
  global.fetch = async (url, options) => {
    captured = { url, options };
    return { ok: true, arrayBuffer: async () => Buffer.from('WEBVTT\n') };
  };
  try {
    const buffer = await downloadRecordingFile(
      { download_url: 'https://zoom.us/rec/download/abc' },
      { token: 'DL-TOKEN' }
    );
    assert.equal(buffer.toString('utf8'), 'WEBVTT\n');
    assert.equal(captured.url, 'https://zoom.us/rec/download/abc?access_token=DL-TOKEN');
    assert.equal(captured.options.headers, undefined, 'no Authorization header survives a Zoom redirect');
    assert.equal(captured.options.redirect, 'follow');
  } finally {
    global.fetch = previousFetch;
  }
});

test('downloadRecordingFile refuses a file larger than maxBytes', async () => {
  const previousFetch = global.fetch;
  global.fetch = async () => ({ ok: true, arrayBuffer: async () => Buffer.alloc(64) });
  try {
    await assert.rejects(
      () => downloadRecordingFile({ download_url: 'https://zoom.us/rec/download/abc' }, { token: 'T', maxBytes: 16 }),
      /too large/
    );
  } finally {
    global.fetch = previousFetch;
  }
});
