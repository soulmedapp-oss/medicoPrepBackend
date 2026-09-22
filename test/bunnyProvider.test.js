const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  buildPlaybackToken,
  buildUploadSignature,
  getPlaybackToken,
  createUploadCredentials,
  createUpload,
  ensureCollection,
} = require('../src/services/video/bunnyProvider');

// Sets an env var for the duration of `fn` and restores the previous value
// (or removes the key entirely if it was unset) afterwards, even if `fn`
// throws — so these tests never leak env mutations into tests that run
// after them.
async function withEnv(vars, fn) {
  const previous = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

// Formula verified against the live library — see the spec's
// "Verified against the live library" table. Do not substitute the embed-view
// token (sha256 hex of key+guid+expires); that protects Bunny's iframe player,
// not the HLS playlist and segments we serve ourselves.
test('playback token is a base64url HS256 directory token over the signed message', () => {
  const dir = '/GUID/';
  const expires = 1800000000;
  const expected = 'HS256-' + crypto
    .createHmac('sha256', 'KEY')
    .update(`${dir}${expires}token_path=${dir}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  assert.equal(buildPlaybackToken({ tokenKey: 'KEY', videoId: 'GUID', expires }), expected);
});

test('playback token is base64url — no +, / or = survive', () => {
  // Any of those three characters breaks the token as a query parameter.
  for (let i = 0; i < 50; i += 1) {
    const token = buildPlaybackToken({ tokenKey: `k${i}`, videoId: `v${i}`, expires: 1800000000 + i });
    assert.match(token, /^HS256-[A-Za-z0-9_-]+$/, `token ${i} is not base64url: ${token}`);
  }
});

test('upload signature is sha256(libraryId + apiKey + expires + videoId)', () => {
  const expected = crypto.createHash('sha256').update('12' + 'API' + '1800000000' + 'GUID').digest('hex');
  assert.equal(
    buildUploadSignature({ libraryId: '12', apiKey: 'API', expires: 1800000000, videoId: 'GUID' }),
    expected
  );
});

// Review Focus #4: a 3-hour lecture watched with pauses must not outlive its token.
// Default TTL (4h = 14400s) dominates here: duration + 900 = 11700 < 14400, so
// this pins the ttl-dominant branch of Math.max(ttl, duration + 900) exactly —
// not just "greater than or equal", which an equality regression would still pass.
test('playback token TTL: default ttl dominates a 3-hour lecture', () => {
  const now = 1800000000;
  const video = { bunny_video_id: 'GUID', duration_seconds: 3 * 60 * 60 };
  const result = getPlaybackToken(video, { now });
  assert.equal(result.expires_at, now + 4 * 60 * 60);
});

// A 5-hour lecture pushes duration + 900 (18900) past the default ttl (14400),
// so this pins the OTHER branch of Math.max — the one the 3-hour case above
// never exercises. Together the two cases pin both arms exactly, so silently
// dropping the +900 safety buffer (i.e. regressing to expires = now + duration)
// would fail this test even though it still satisfies a ">=" check.
test('playback token TTL: long lecture duration dominates the default ttl', () => {
  const now = 1800000000;
  const video = { bunny_video_id: 'GUID', duration_seconds: 5 * 60 * 60 };
  const result = getPlaybackToken(video, { now });
  assert.equal(result.expires_at, now + video.duration_seconds + 900);
});

test('getPlaybackToken returns exactly hls_url, token, token_path and expires_at', () => {
  const result = getPlaybackToken({ bunny_video_id: 'GUID', duration_seconds: 60 }, { now: 1800000000 });
  assert.deepEqual(Object.keys(result).sort(), ['expires_at', 'hls_url', 'token', 'token_path']);
});

// A bunny row mid-upload can have bunny_video_id === '' (the model default).
// Without a guard this silently builds a token over "//" and a URL with a
// double slash — no exception, no log, just a 403/404 in a student's player.
test('getPlaybackToken throws when bunny_video_id is missing or empty', () => {
  assert.throws(() => getPlaybackToken({ bunny_video_id: '', duration_seconds: 60 }, { now: 1800000000 }));
  assert.throws(() => getPlaybackToken({ duration_seconds: 60 }, { now: 1800000000 }));
  assert.throws(() => getPlaybackToken(undefined, { now: 1800000000 }));
});

const { buildUploadPayload } = require('../src/services/video/bunnyProvider');

test('upload payload carries a signature but never the api key', () => {
  const payload = buildUploadPayload({
    libraryId: '12', apiKey: 'SECRET-API-KEY', videoId: 'GUID', now: 1800000000,
  });
  const serialised = JSON.stringify(payload);
  assert.ok(!serialised.includes('SECRET-API-KEY'), 'api key must not reach the client');
  assert.equal(payload.video_id, 'GUID');
  assert.equal(payload.library_id, '12');
  assert.ok(payload.expires > 1800000000, 'signature must have a future expiry');
  assert.match(payload.signature, /^[0-9a-f]{64}$/);
  // C: lecturesClient.upload reads tus_endpoint. bunnyProvider.test.js
  // previously pinned video_id/library_id/signature/expires but never
  // tus_endpoint, so renaming that field would keep this whole suite green
  // while silently breaking every upload. Pin the full key set.
  assert.deepEqual(
    Object.keys(payload).sort(),
    ['expires', 'library_id', 'signature', 'tus_endpoint', 'video_id']
  );
});

// This is the function the route actually calls, and the one the Task 5
// review was about: it reads the real apiKey out of module-private config()
// on the caller's behalf. A regression here — e.g. spreading config() into
// the response — would leak the key while every other test (including the
// one above, which only exercises the pure buildUploadPayload with a fake
// key) stays green. Setting a distinctive env sentinel and asserting it
// never appears in the serialised output is the only way to pin this.
test('createUploadCredentials reads config() internally but never leaks the api key it finds there', async () => {
  await withEnv({ BUNNY_STREAM_API_KEY: 'SENTINEL-REAL-BUNNY-KEY-7f3a9c' }, () => {
    const result = createUploadCredentials({ libraryId: '12', videoId: 'GUID' });
    const serialised = JSON.stringify(result);
    assert.ok(
      !serialised.includes('SENTINEL-REAL-BUNNY-KEY-7f3a9c'),
      'api key must not leak from createUploadCredentials'
    );
    assert.equal(result.video_id, 'GUID');
    assert.equal(result.library_id, '12');
    assert.match(result.signature, /^[0-9a-f]{64}$/);
  });
});

// Nothing previously asserted the shape of the HTTP request createUpload
// sends to Bunny (URL, method, AccessKey header, body, or that it carries a
// timeout signal) — a regression there would only ever surface against the
// live service. Faking global.fetch pins that shape without any network
// call, and restoring it in `finally` keeps the fake from leaking into
// other tests.
test('createUpload posts to the correct Bunny endpoint with an AccessKey header, JSON title body, and a timeout signal', async () => {
  const previousFetch = global.fetch;
  let captured;
  global.fetch = async (url, options) => {
    captured = { url, options };
    return { ok: true, json: async () => ({ guid: 'new-guid' }) };
  };
  try {
    await withEnv({ BUNNY_STREAM_LIBRARY_ID: '99', BUNNY_STREAM_API_KEY: 'FAKE-KEY' }, async () => {
      const result = await createUpload({ title: 'Lecture 1' });
      assert.equal(captured.url, 'https://video.bunnycdn.com/library/99/videos');
      assert.equal(captured.options.method, 'POST');
      assert.equal(captured.options.headers.AccessKey, 'FAKE-KEY');
      assert.equal(captured.options.headers['content-type'], 'application/json');
      assert.deepEqual(JSON.parse(captured.options.body), { title: 'Lecture 1' });
      assert.ok(captured.options.signal instanceof AbortSignal, 'a timeout signal must be attached');
      assert.deepEqual(result, { videoId: 'new-guid', libraryId: '99' });
    });
  } finally {
    global.fetch = previousFetch;
  }
});

// ensureCollection groups Bunny dashboard videos by subject. Each test below
// uses a distinct collection name so the module-level cache (which is
// intentionally never reset between tests — that's the point of the cache
// test further down) can't leak a result from one test into another.

test('ensureCollection: reuses an existing collection by exact name and never issues a POST', async () => {
  const previousFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => [
        { guid: 'other-guid', name: 'Physiology' },
        { guid: 'anatomy-guid', name: 'Anatomy-Reuse' },
      ],
    };
  };
  try {
    await withEnv({ BUNNY_STREAM_LIBRARY_ID: '99', BUNNY_STREAM_API_KEY: 'FAKE-KEY' }, async () => {
      const guid = await ensureCollection('Anatomy-Reuse');
      assert.equal(guid, 'anatomy-guid');
      assert.equal(calls.length, 1, 'only the list call should have been made, no POST');
      assert.equal(calls[0].url, 'https://video.bunnycdn.com/library/99/collections');
      assert.equal(calls[0].options.headers.AccessKey, 'FAKE-KEY');
    });
  } finally {
    global.fetch = previousFetch;
  }
});

test('ensureCollection: creates a collection when no exact name match exists', async () => {
  const previousFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (!options || options.method !== 'POST') {
      return { ok: true, json: async () => [{ guid: 'other-guid', name: 'Physiology' }] };
    }
    return { ok: true, json: async () => ({ guid: 'new-collection-guid', name: 'Biochemistry-Create' }) };
  };
  try {
    await withEnv({ BUNNY_STREAM_LIBRARY_ID: '99', BUNNY_STREAM_API_KEY: 'FAKE-KEY' }, async () => {
      const guid = await ensureCollection('Biochemistry-Create');
      assert.equal(guid, 'new-collection-guid');
      assert.equal(calls.length, 2, 'a list call followed by a create call');
      assert.equal(calls[1].url, 'https://video.bunnycdn.com/library/99/collections');
      assert.equal(calls[1].options.method, 'POST');
      assert.equal(calls[1].options.headers.AccessKey, 'FAKE-KEY');
      assert.deepEqual(JSON.parse(calls[1].options.body), { name: 'Biochemistry-Create' });
      assert.ok(calls[1].options.signal instanceof AbortSignal);
    });
  } finally {
    global.fetch = previousFetch;
  }
});

// ensureCollection must never throw into the upload path: a lecture that
// uploads without a collection is fine, a lecture that fails to upload
// because collection bookkeeping broke is not.
test('ensureCollection: a failing list returns null and does not throw', async () => {
  const previousFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  try {
    await withEnv({ BUNNY_STREAM_LIBRARY_ID: '99', BUNNY_STREAM_API_KEY: 'FAKE-KEY' }, async () => {
      const guid = await ensureCollection('Pathology-ListFails');
      assert.equal(guid, null);
    });
  } finally {
    global.fetch = previousFetch;
  }
});

test('ensureCollection: a rejected fetch (network error) also returns null instead of throwing', async () => {
  const previousFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('network down');
  };
  try {
    await withEnv({ BUNNY_STREAM_LIBRARY_ID: '99', BUNNY_STREAM_API_KEY: 'FAKE-KEY' }, async () => {
      await assert.doesNotReject(ensureCollection('Pathology-NetworkFails'));
      const guid = await ensureCollection('Pathology-NetworkFails');
      assert.equal(guid, null);
    });
  } finally {
    global.fetch = previousFetch;
  }
});

test('ensureCollection: caches by name so a second call for the same subject makes no further Bunny calls', async () => {
  const previousFetch = global.fetch;
  let callCount = 0;
  global.fetch = async () => {
    callCount += 1;
    return { ok: true, json: async () => [{ guid: 'cached-guid', name: 'Pharmacology-Cache' }] };
  };
  try {
    await withEnv({ BUNNY_STREAM_LIBRARY_ID: '99', BUNNY_STREAM_API_KEY: 'FAKE-KEY' }, async () => {
      const first = await ensureCollection('Pharmacology-Cache');
      const countAfterFirst = callCount;
      const second = await ensureCollection('Pharmacology-Cache');
      assert.equal(first, 'cached-guid');
      assert.equal(second, 'cached-guid');
      assert.equal(callCount, countAfterFirst, 'no additional fetch call for a cached name');
    });
  } finally {
    global.fetch = previousFetch;
  }
});

test('createUpload: omits collectionId entirely when no subject is given', async () => {
  const previousFetch = global.fetch;
  let captured;
  global.fetch = async (url, options) => {
    captured = { url, options };
    return { ok: true, json: async () => ({ guid: 'new-guid' }) };
  };
  try {
    await withEnv({ BUNNY_STREAM_LIBRARY_ID: '99', BUNNY_STREAM_API_KEY: 'FAKE-KEY' }, async () => {
      await createUpload({ title: 'No Subject Lecture' });
      const body = JSON.parse(captured.options.body);
      assert.deepEqual(body, { title: 'No Subject Lecture' });
      assert.ok(!Object.prototype.hasOwnProperty.call(body, 'collectionId'));
    });
  } finally {
    global.fetch = previousFetch;
  }
});

test('createUpload: includes collectionId when a subject resolves to a collection', async () => {
  const previousFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/collections')) {
      return { ok: true, json: async () => [{ guid: 'subject-guid', name: 'Radiology-Upload' }] };
    }
    return { ok: true, json: async () => ({ guid: 'video-guid' }) };
  };
  try {
    await withEnv({ BUNNY_STREAM_LIBRARY_ID: '99', BUNNY_STREAM_API_KEY: 'FAKE-KEY' }, async () => {
      const result = await createUpload({ title: 'Radiology Lecture', subject: 'Radiology-Upload' });
      const videoCall = calls.find((c) => c.url.endsWith('/videos'));
      const body = JSON.parse(videoCall.options.body);
      assert.deepEqual(body, { title: 'Radiology Lecture', collectionId: 'subject-guid' });
      assert.deepEqual(result, { videoId: 'video-guid', libraryId: '99' });
    });
  } finally {
    global.fetch = previousFetch;
  }
});

test('createUpload: omits collectionId when ensureCollection fails, without failing the upload', async () => {
  const previousFetch = global.fetch;
  global.fetch = async (url) => {
    if (url.endsWith('/collections')) {
      return { ok: false, status: 500, json: async () => ({}) };
    }
    return { ok: true, json: async () => ({ guid: 'video-guid-2' }) };
  };
  try {
    await withEnv({ BUNNY_STREAM_LIBRARY_ID: '99', BUNNY_STREAM_API_KEY: 'FAKE-KEY' }, async () => {
      const result = await createUpload({ title: 'Cardiology Lecture', subject: 'Cardiology-Fails' });
      assert.equal(result.videoId, 'video-guid-2');
    });
  } finally {
    global.fetch = previousFetch;
  }
});
