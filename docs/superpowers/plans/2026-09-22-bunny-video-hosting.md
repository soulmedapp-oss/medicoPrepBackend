# Bunny Video Hosting + Video AI Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins upload SoulMed's own lecture videos to Bunny Stream against a subject, serve them to entitled students behind short-lived signed tokens, and make the existing per-video AI chat answer follow-ups while refusing off-topic questions.

**Architecture:** `Video` gains a `provider` discriminator (`youtube` | `bunny`) so existing link-based rows keep working untouched. A provider adapter (`src/services/video/`) isolates all Bunny calls behind `createUpload / getPlaybackToken / getStatus / delete`. Video bytes go browser → Bunny over tus, never through the API. Playback is authorised by the existing `loadVideoForUser` check, which now guards a 4-hour signed token instead of a static URL.

**Tech Stack:** Node 22 + Express 5 (CommonJS), Mongoose 9, `node:test` + `node:assert/strict`, `node:crypto`; React 18 + Vite + TanStack Query + shadcn/Radix on the frontend; Bunny Stream HTTP API and tus resumable upload.

**Spec:** `docs/superpowers/specs/2026-09-22-bunny-video-hosting-design.md`

## Global Constraints

- Backend is **CommonJS** (`require`/`module.exports`). Do not introduce ESM.
- Tests run with `npm test` → `node --test "test/**/*.test.js"`. New tests go in `test/*.test.js` and use `node:test` + `node:assert/strict`, matching `test/grading.test.js`.
- `BUNNY_STREAM_API_KEY`, `BUNNY_STREAM_READONLY_API_KEY` and `BUNNY_STREAM_TOKEN_KEY` **must never be sent to the browser** — only values derived from them.
- Playback tokens are returned **only** by `GET /videos/:id/playback`, never by `GET /videos`.
- `canAccessVideo` / `loadVideoForUser` remain the single access gate. Do not add a second gate.
- Playback token TTL comes from `BUNNY_PLAYBACK_TOKEN_TTL`, default `14400` (4 hours).
- `AdminVideos.jsx` must not be modified. The new admin page is additive.
- Existing rows must keep working: `provider` defaults to `'youtube'`, `processing_status` defaults to `'ready'`.
- Frontend files use CRLF line endings in some places (`navItems.js`); preserve whatever a file already uses.
- Nav entries sort alphabetically with Dashboard pinned (`src/lib/navUtils.js`); no ordering metadata is needed for new pages.

## Review Focus

These are the failure modes the spec implies but which no task's happy path exercises. Each has a test attached to the task that owns the code.

1. **Out-of-order webhooks** — Bunny sends `2` (Encoding) after `3` (Finished); a naive handler flips a ready video back to `processing` and students lose access. Covered in Task 8.
2. **Playback requested while still processing** — student opens a just-published lecture; must get a clear 409, not a token for an unplayable asset. Covered in Task 9.
3. **Webhook body re-serialisation** — `express.json()` parses and discards the raw body, so `JSON.stringify(req.body)` produces a different byte sequence and every signature fails silently. Covered in Task 6.
4. **Token expiry mid-lecture** — a 3-hour lecture watched with pauses outlives a short TTL and playback dies partway. Covered in Task 5.
5. **Oversized chat history** — a long conversation plus a 60k-char transcript exceeds the model's context and the request errors for the student. Covered in Task 2.

---

# Phase 0 — Video AI chat (no Bunny dependency)

The chat UI, API client, routes, controller and OpenAI calls all already exist. Phase 0 fixes two behaviours.

### Task 1: Refuse off-topic questions

Today `requestVideoChat` uses the system prompt `'You are a helpful medical tutor. Answer concisely in 3-6 sentences.'`, so the model happily answers questions the lecture never covered, using general knowledge. The spec requires the answer to stay inside the video's context.

**Files:**
- Modify: `src/services/tutorService.js:190-203` (`requestVideoChat`)
- Test: `test/videoChat.test.js` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `VIDEO_CHAT_SYSTEM_PROMPT` (string) exported from `src/services/tutorService.js`.

- [ ] **Step 1: Write the failing test**

Create `test/videoChat.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { VIDEO_CHAT_SYSTEM_PROMPT } = require('../src/services/tutorService');

test('video chat system prompt confines answers to the lecture context', () => {
  assert.equal(typeof VIDEO_CHAT_SYSTEM_PROMPT, 'string');
  const prompt = VIDEO_CHAT_SYSTEM_PROMPT.toLowerCase();
  assert.ok(prompt.includes('only'), 'prompt must restrict the model to the provided context');
  assert.ok(
    prompt.includes('does not cover') || prompt.includes("doesn't cover"),
    'prompt must tell the model how to decline uncovered questions'
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A5 videoChat`
Expected: FAIL — `VIDEO_CHAT_SYSTEM_PROMPT` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `src/services/tutorService.js`, above `requestVideoChat`:

```js
// The chat must answer from this lecture only. Without an explicit refusal
// instruction the model answers uncovered questions from general knowledge,
// which reads to a student as if the lecture taught it.
const VIDEO_CHAT_SYSTEM_PROMPT = [
  'You are a medical tutor helping a student understand one specific lecture.',
  'Answer only from the lecture context provided in the user message.',
  'If the context does not cover the question, say that this lecture does not cover it',
  'and suggest what the student could search for instead. Do not answer from outside knowledge.',
  'Answer concisely in 3-6 sentences.',
].join(' ');
```

Use it in `requestVideoChat`:

```js
{ role: 'system', content: VIDEO_CHAT_SYSTEM_PROMPT },
```

Add `VIDEO_CHAT_SYSTEM_PROMPT` to the `module.exports` object at the bottom of the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -A5 videoChat`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/tutorService.js test/videoChat.test.js
git commit -m "feat(video-chat): confine AI answers to the lecture context"
```

---

### Task 2: Conversation memory

`requestVideoChat(message, video)` sends a single user message with no history, so "explain that more simply" loses its referent.

**Files:**
- Modify: `src/services/tutorService.js` (`requestVideoChat`)
- Modify: `src/controllers/videosController.js` (`chatAboutVideo`)
- Test: `test/videoChat.test.js` (extend)

**Interfaces:**
- Consumes: `VIDEO_CHAT_SYSTEM_PROMPT` from Task 1.
- Produces:
  - `buildChatHistory(history)` → `Array<{ role: 'user'|'assistant', content: string }>` exported from `src/services/tutorService.js`. Caps at the last 6 turns and `MAX_CHAT_CONTEXT_CHARS` total; drops malformed entries.
  - `requestVideoChat(message, video, history)` — third parameter optional, defaults `[]`.
  - `POST /videos/:id/ai-chat` accepts an optional `history: [{ role, text }]` in the body.

- [ ] **Step 1: Write the failing test**

Append to `test/videoChat.test.js`:

```js
const { buildChatHistory } = require('../src/services/tutorService');
const { MAX_CHAT_CONTEXT_CHARS } = require('../src/utils/security');

test('chat history keeps only the last 6 turns', () => {
  const history = Array.from({ length: 20 }, (_, i) => ({ role: 'user', text: `q${i}` }));
  const built = buildChatHistory(history);
  assert.equal(built.length, 6);
  assert.equal(built[5].content, 'q19');
});

test('chat history drops malformed and empty entries', () => {
  const built = buildChatHistory([
    { role: 'user', text: 'kept' },
    { role: 'system', text: 'injected' },
    { role: 'assistant', text: '' },
    null,
    'nonsense',
  ]);
  assert.deepEqual(built, [{ role: 'user', content: 'kept' }]);
});

test('chat history is capped so a long conversation cannot exceed the context budget', () => {
  const long = 'x'.repeat(MAX_CHAT_CONTEXT_CHARS);
  const built = buildChatHistory([
    { role: 'user', text: long },
    { role: 'assistant', text: long },
  ]);
  const total = built.reduce((sum, m) => sum + m.content.length, 0);
  assert.ok(total <= MAX_CHAT_CONTEXT_CHARS, `history was ${total} chars`);
});

test('chat history tolerates a missing or non-array argument', () => {
  assert.deepEqual(buildChatHistory(undefined), []);
  assert.deepEqual(buildChatHistory('nope'), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A5 videoChat`
Expected: FAIL — `buildChatHistory` is not a function.

- [ ] **Step 3: Write minimal implementation**

In `src/services/tutorService.js`:

```js
const MAX_CHAT_HISTORY_TURNS = 6;

// Client-supplied history is untrusted: only user/assistant turns survive, so a
// caller cannot inject a system message, and the total is capped so a long
// conversation plus a 60k-char transcript cannot blow the context budget.
function buildChatHistory(history) {
  if (!Array.isArray(history)) return [];
  const clean = history
    .filter((entry) => entry && typeof entry === 'object')
    .filter((entry) => entry.role === 'user' || entry.role === 'assistant')
    .map((entry) => ({ role: entry.role, content: String(entry.text || '').trim() }))
    .filter((entry) => entry.content.length > 0)
    .slice(-MAX_CHAT_HISTORY_TURNS);

  let budget = MAX_CHAT_CONTEXT_CHARS;
  const kept = [];
  for (let i = clean.length - 1; i >= 0; i -= 1) {
    const entry = clean[i];
    if (entry.content.length > budget) break;
    budget -= entry.content.length;
    kept.unshift(entry);
  }
  return kept;
}
```

Change `requestVideoChat`'s signature and messages:

```js
async function requestVideoChat(message, video, history = []) {
  const openai = await getOpenAiClient();
  const context = buildVideoContext(video);
  const response = await openai.chat.completions.create({
    model: videoModel,
    temperature: 0.2,
    max_tokens: Math.min(videoChatMaxTokens, 800),
    messages: [
      { role: 'system', content: VIDEO_CHAT_SYSTEM_PROMPT },
      { role: 'user', content: context },
      ...buildChatHistory(history),
      { role: 'user', content: truncateText(message, MAX_CHAT_MESSAGE_LENGTH) },
    ],
  });
  return response.choices?.[0]?.message?.content?.trim() || '';
}
```

Export `buildChatHistory`.

In `src/controllers/videosController.js`, inside `chatAboutVideo`, replace the `requestVideoChat` call:

```js
const answer = await requestVideoChat(message.trim(), video, req.body?.history);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -A5 videoChat`
Expected: PASS (all five tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/tutorService.js src/controllers/videosController.js test/videoChat.test.js
git commit -m "feat(video-chat): send recent conversation turns with each question"
```

---

### Task 3: Frontend sends conversation history

**Files:**
- Modify: `frontend/soulmed/src/api/videosClient.js:50-56` (`askQuestion`)
- Modify: `frontend/soulmed/src/pages/Videos.jsx:212-226` (`sendChat`)

**Interfaces:**
- Consumes: `POST /videos/:id/ai-chat` now accepting `history` (Task 2).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Update the API client**

In `src/api/videosClient.js`:

```js
  async askQuestion(id, message, history = []) {
    const data = await request(`/videos/${id}/ai-chat`, {
      method: 'POST',
      body: JSON.stringify({ message, history }),
    });
    return data.answer;
  },
```

- [ ] **Step 2: Pass the existing messages from `sendChat`**

In `src/pages/Videos.jsx`, `chatMessages` already holds `{ role, text }` in exactly the shape the backend expects. Change the call:

```js
      const answer = await videosClient.askQuestion(selectedVideo.id, message, chatMessages);
```

`chatMessages` is read before the new user turn is appended in the same tick, which is correct — the new question is sent separately as `message`.

- [ ] **Step 3: Verify lint and types**

Run: `cd frontend/soulmed && npx eslint src/pages/Videos.jsx src/api/videosClient.js`
Expected: no new errors.

- [ ] **Step 4: Manual check**

Open a video, ask "what is this lecture about?", then ask "explain that more simply". The second answer should refer to the first. Then ask something unrelated ("who won the 2024 election?") and confirm the tutor declines.

- [ ] **Step 5: Commit**

```bash
git add src/api/videosClient.js src/pages/Videos.jsx
git commit -m "feat(video-chat): send recent turns so follow-up questions keep context"
```

---

# Phase 1 — Bunny hosting

**Blocked until** the Bunny library exists and `.env` carries the five `BUNNY_STREAM_*` values (spec §6).

### Task 4: Video model gains provider fields

**Files:**
- Modify: `src/models/Video.js`
- Test: `test/videoModel.test.js` (create)

**Interfaces:**
- Produces: `Video` documents with `provider`, `bunny_video_id`, `bunny_library_id`, `processing_status`, `duration_seconds`, `transcript_status`.

- [ ] **Step 1: Write the failing test**

Create `test/videoModel.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const Video = require('../src/models/Video');

test('existing link videos default to the youtube provider and are ready', () => {
  const doc = new Video({ title: 'T', subject: 'Anatomy', teacher_name: 'Dr A', video_url: 'https://y/1' });
  assert.equal(doc.provider, 'youtube');
  assert.equal(doc.processing_status, 'ready');
  assert.equal(doc.validateSync(), undefined);
});

test('a youtube video without a url is invalid', () => {
  const doc = new Video({ title: 'T', subject: 'Anatomy', teacher_name: 'Dr A' });
  const err = doc.validateSync();
  assert.ok(err && err.errors.video_url, 'video_url should be required for youtube');
});

test('a bunny video is valid without a video_url', () => {
  const doc = new Video({
    title: 'T', subject: 'Anatomy', teacher_name: 'Dr A',
    provider: 'bunny', bunny_video_id: 'guid', processing_status: 'uploading',
  });
  assert.equal(doc.validateSync(), undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A5 videoModel`
Expected: FAIL — the bunny document is rejected for a missing `video_url`.

- [ ] **Step 3: Write minimal implementation**

In `src/models/Video.js`, change `video_url` and add the new fields:

```js
    video_url: {
      type: String,
      required: function required() {
        return this.provider !== 'bunny';
      },
    },
    provider: { type: String, enum: ['youtube', 'bunny'], default: 'youtube' },
    bunny_video_id: { type: String, default: '' },
    bunny_library_id: { type: String, default: '' },
    processing_status: {
      type: String,
      enum: ['uploading', 'processing', 'ready', 'failed'],
      default: 'ready',
    },
    duration_seconds: { type: Number, default: 0 },
    transcript_status: {
      type: String,
      enum: ['none', 'pending', 'ready', 'failed'],
      default: 'none',
    },
```

Below the schema definition:

```js
videoSchema.index({ provider: 1, processing_status: 1 });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -A5 videoModel`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/models/Video.js test/videoModel.test.js
git commit -m "feat(video): add provider and processing fields for hosted lectures"
```

---

### Task 5: Bunny adapter — token and upload signature

Pure crypto, no network. This is the security core of the feature.

**Files:**
- Create: `src/services/video/bunnyProvider.js`
- Create: `src/services/video/index.js`
- Test: `test/bunnyProvider.test.js` (create)

**Interfaces:**
- Produces:
  - `buildPlaybackToken({ tokenKey, videoId, expires })` → `string` (lowercase SHA256 hex)
  - `buildUploadSignature({ libraryId, apiKey, expires, videoId })` → `string` (lowercase SHA256 hex)
  - `getPlaybackToken(video, { now })` → `{ hls_url, token, expires_at }`
  - `getProvider()` from `src/services/video/index.js` → the adapter selected by `VIDEO_PROVIDER`

- [ ] **Step 1: Write the failing test**

Create `test/bunnyProvider.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  buildPlaybackToken,
  buildUploadSignature,
  getPlaybackToken,
} = require('../src/services/video/bunnyProvider');

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
test('playback token TTL covers a long lecture', () => {
  const now = 1800000000;
  const video = { bunny_video_id: 'GUID', duration_seconds: 3 * 60 * 60 };
  const result = getPlaybackToken(video, { now });
  assert.ok(
    result.expires_at - now >= video.duration_seconds,
    'token must outlive the video it unlocks'
  );
});

test('playback token result never leaks the signing key', () => {
  const result = getPlaybackToken({ bunny_video_id: 'GUID', duration_seconds: 60 }, { now: 1800000000 });
  assert.deepEqual(Object.keys(result).sort(), ['expires_at', 'hls_url', 'token', 'token_path']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A5 bunnyProvider`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/services/video/bunnyProvider.js`:

```js
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

// `config` is deliberately NOT exported: it returns the raw Bunny API key and
// token-signing key, and a single `res.json(bunnyProvider.config())` anywhere
// downstream would leak both. Callers get derived values only.
module.exports = { buildPlaybackToken, buildUploadSignature, getPlaybackToken };
```

Create `src/services/video/index.js`:

```js
const bunnyProvider = require('./bunnyProvider');

// `youtube` rows have no hosted asset: playback is the stored URL.
const youtubeProvider = {
  getPlaybackToken: (video) => ({ hls_url: '', token: '', expires_at: 0, video_url: video.video_url }),
};

function getProvider(name) {
  return name === 'bunny' ? bunnyProvider : youtubeProvider;
}

module.exports = { getProvider };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -A5 bunnyProvider`
Expected: PASS (four tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/video test/bunnyProvider.test.js
git commit -m "feat(video): add Bunny provider adapter with signed playback tokens"
```

---

### Task 6: Webhook signature verification and raw body capture

**Files:**
- Create: `src/utils/bunnyWebhook.js`
- Modify: `src/server.js:207` (`express.json`)
- Test: `test/bunnyWebhook.test.js` (create)

**Interfaces:**
- Consumes: `safeCompare` from `src/utils/security.js`.
- Produces: `verifyBunnySignature(rawBody, signature, secret)` → `boolean`.

- [ ] **Step 1: Write the failing test**

Create `test/bunnyWebhook.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyBunnySignature } = require('../src/utils/bunnyWebhook');

const SECRET = 'readonly-key';
const BODY = '{"VideoLibraryId":12,"VideoGuid":"abc","Status":3}';
const sign = (body, secret = SECRET) =>
  crypto.createHmac('sha256', secret).update(body).digest('hex');

test('a correctly signed body is accepted', () => {
  assert.equal(verifyBunnySignature(BODY, sign(BODY), SECRET), true);
});

test('a tampered body is rejected', () => {
  const tampered = BODY.replace('"Status":3', '"Status":5');
  assert.equal(verifyBunnySignature(tampered, sign(BODY), SECRET), false);
});

// Review Focus #3: express.json() discards the raw body. Re-serialising the
// parsed object reorders keys, so the signature fails - which is exactly the
// silent bug this test exists to prevent.
test('a re-serialised body does not verify', () => {
  const reserialised = JSON.stringify({ Status: 3, VideoGuid: 'abc', VideoLibraryId: 12 });
  assert.notEqual(reserialised, BODY, 'precondition: re-serialising changes the bytes');
  assert.equal(verifyBunnySignature(reserialised, sign(BODY), SECRET), false);
});

test('a missing signature or secret is rejected rather than throwing', () => {
  assert.equal(verifyBunnySignature(BODY, undefined, SECRET), false);
  assert.equal(verifyBunnySignature(BODY, sign(BODY), ''), false);
  assert.equal(verifyBunnySignature(undefined, sign(BODY), SECRET), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A5 bunnyWebhook`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/utils/bunnyWebhook.js`:

```js
const crypto = require('node:crypto');
const { safeCompare } = require('./security');

// Bunny signs the EXACT bytes it sent. express.json() parses and discards them,
// so the route must read req.rawBody (see server.js) - re-serialising req.body
// produces different bytes and every signature silently fails.
function verifyBunnySignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(Buffer.isBuffer(rawBody) ? rawBody : String(rawBody))
    .digest('hex');
  return safeCompare(expected, String(signature).toLowerCase());
}

module.exports = { verifyBunnySignature };
```

In `src/server.js`, replace line 207:

```js
app.use(
  express.json({
    limit: '1mb',
    // Bunny webhook signatures are computed over the raw bytes; keep a copy
    // before the body is parsed away.
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -A5 bunnyWebhook`
Expected: PASS (four tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/bunnyWebhook.js src/server.js test/bunnyWebhook.test.js
git commit -m "feat(video): verify Bunny webhook signatures against the raw body"
```

---

### Task 7: Upload URL endpoint

**Files:**
- Modify: `src/services/video/bunnyProvider.js` (add `createUpload`, `getStatus`)
- Modify: `src/controllers/videosController.js` (add `createUploadUrl`)
- Modify: `src/routes/videosRoutes.js`
- Test: `test/bunnyProvider.test.js` (extend)

**Interfaces:**
- Consumes: `buildUploadSignature` (Task 5), `Video` fields (Task 4).
- Produces: `POST /videos/:id/upload-url` → `{ tus_endpoint, video_id, library_id, signature, expires }`.

- [ ] **Step 1: Write the failing test**

Append to `test/bunnyProvider.test.js`:

```js
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A5 "upload payload"`
Expected: FAIL — `buildUploadPayload` is not a function.

- [ ] **Step 3: Write minimal implementation**

In `src/services/video/bunnyProvider.js`:

```js
const TUS_ENDPOINT = 'https://video.bunnycdn.com/tusupload';
const UPLOAD_WINDOW_SECONDS = 24 * 60 * 60;

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

async function createUpload({ title }) {
  const { libraryId, apiKey } = config();
  const response = await fetch(`https://video.bunnycdn.com/library/${libraryId}/videos`, {
    method: 'POST',
    headers: { AccessKey: apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!response.ok) throw new Error(`Bunny create video failed (${response.status})`);
  const created = await response.json();
  return { videoId: created.guid, libraryId };
}

async function getStatus(videoId) {
  const { libraryId, apiKey } = config();
  const response = await fetch(`https://video.bunnycdn.com/library/${libraryId}/videos/${videoId}`, {
    headers: { AccessKey: apiKey },
  });
  if (!response.ok) throw new Error(`Bunny get video failed (${response.status})`);
  const video = await response.json();
  return { status: video.status, duration_seconds: video.length || 0 };
}
```

Add a thin wrapper so controllers never need the raw keys. `buildUploadPayload`
stays pure (it *accepts* keys, so tests can pass fakes); this reads them:

```js
// Controllers must not be able to reach the raw keys, so `config` stays
// module-private and this wrapper is the only way to mint upload credentials.
function createUploadCredentials({ libraryId, videoId }) {
  const { apiKey } = config();
  return buildUploadPayload({ libraryId, apiKey, videoId });
}
```

Export `buildUploadPayload`, `createUploadCredentials`, `createUpload`, `getStatus`.
Do **not** export `config`.

In `src/controllers/videosController.js`:

```js
  async function createUploadUrl(req, res) {
    try {
      const video = await Video.findById(req.params.id);
      if (!video) return res.status(404).json({ error: 'Video not found' });
      if (video.provider !== 'bunny') {
        return res.status(400).json({ error: 'Not a hosted lecture' });
      }
      const bunny = require('../services/video/bunnyProvider');
      const { videoId, libraryId } = video.bunny_video_id
        ? { videoId: video.bunny_video_id, libraryId: video.bunny_library_id }
        : await bunny.createUpload({ title: video.title });

      video.bunny_video_id = videoId;
      video.bunny_library_id = libraryId;
      video.processing_status = 'uploading';
      await video.save();

      return res.json(bunny.createUploadCredentials({ libraryId, videoId }));
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to start upload' });
    }
  }
```

Add `createUploadUrl` to the controller's returned object.

In `src/routes/videosRoutes.js`, after the `POST /videos` route:

```js
  router.post(
    '/videos/:id/upload-url',
    authMiddleware,
    authorize.any('CanAddVideos', 'CanEditVideos'),
    controller.createUploadUrl
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -A5 bunnyProvider`
Expected: PASS (five tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/video/bunnyProvider.js src/controllers/videosController.js src/routes/videosRoutes.js test/bunnyProvider.test.js
git commit -m "feat(video): issue signed tus upload credentials for hosted lectures"
```

---

### Task 8: Status webhook route

**Files:**
- Create: `src/utils/bunnyStatus.js`
- Modify: `src/server.js` (mount the webhook route near the other `app.post` upload routes)
- Test: `test/bunnyWebhook.test.js` (extend)

**Interfaces:**
- Consumes: `verifyBunnySignature` (Task 6).
- Produces: `nextProcessingStatus(current, bunnyStatus)` → `'uploading'|'processing'|'ready'|'failed'|null` (`null` = ignore this webhook).

- [ ] **Step 1: Write the failing test**

Append to `test/bunnyWebhook.test.js`:

```js
const { nextProcessingStatus } = require('../src/utils/bunnyStatus');

test('finished maps to ready and failed maps to failed', () => {
  assert.equal(nextProcessingStatus('processing', 3), 'ready');
  assert.equal(nextProcessingStatus('processing', 5), 'failed');
});

// Review Focus #1: Bunny may deliver an Encoding webhook after Finished.
// Demoting a ready video would silently revoke student access.
test('a late encoding webhook does not demote a ready video', () => {
  assert.equal(nextProcessingStatus('ready', 2), null);
  assert.equal(nextProcessingStatus('ready', 1), null);
  assert.equal(nextProcessingStatus('ready', 0), null);
});

test('an unknown status code is ignored', () => {
  assert.equal(nextProcessingStatus('processing', 99), null);
});

test('encoding progress moves an uploading video to processing', () => {
  assert.equal(nextProcessingStatus('uploading', 2), 'processing');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A5 bunnyStatus`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/utils/bunnyStatus.js`:

```js
// Bunny status codes: 0 Queued, 1 Processing, 2 Encoding, 3 Finished,
// 4 Resolution finished, 5 Failed, 9 Captions generated.
const IN_PROGRESS = new Set([0, 1, 2, 4]);

const TERMINAL = new Set(['ready', 'failed']);

// Webhooks arrive out of order and are retried, so the same video can receive a
// stale or duplicate callback at any time. `ready` and `failed` are terminal:
// once reached, NOTHING moves the video again. Guarding only the in-progress
// codes is not enough - a duplicate Failed webhook would revoke a student's
// access mid-lecture, and a late Finished webhook would resurrect a failed
// encode as playable.
function nextProcessingStatus(current, bunnyStatus) {
  if (TERMINAL.has(current)) return null;
  const code = Number(bunnyStatus);
  if (code === 3) return 'ready';
  if (code === 5) return 'failed';
  if (IN_PROGRESS.has(code)) return current === 'processing' ? null : 'processing';
  return null;
}

module.exports = { nextProcessingStatus };
```

In `src/server.js`, alongside the other upload routes:

```js
app.post('/webhooks/bunny/video-status', async (req, res) => {
  const signature = req.get('X-BunnyStream-Signature');
  const secret = process.env.BUNNY_STREAM_READONLY_API_KEY || '';
  if (!verifyBunnySignature(req.rawBody, signature, secret)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  const { VideoGuid: guid, Status: status } = req.body || {};
  const video = await Video.findOne({ bunny_video_id: guid });
  // 200 on an unknown guid so Bunny stops retrying a webhook we cannot use.
  if (!video) return res.status(200).json({ ok: true });

  const next = nextProcessingStatus(video.processing_status, status);
  if (next) {
    video.processing_status = next;
    if (next === 'ready') {
      const { duration_seconds: duration } = await getStatus(guid);
      video.duration_seconds = duration;
    }
    await video.save();
  }
  if (Number(status) === 9) {
    video.transcript_status = 'ready';
    await video.save();
  }
  return res.json({ ok: true });
});
```

Add the required imports (`verifyBunnySignature`, `nextProcessingStatus`, `getStatus`, `Video`) at the top of `server.js` alongside the existing model imports.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -A5 bunny`
Expected: PASS (all webhook and status tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/bunnyStatus.js src/server.js test/bunnyWebhook.test.js
git commit -m "feat(video): handle Bunny encoding webhooks without demoting ready videos"
```

---

### Task 9: Playback authorization endpoint

**Files:**
- Modify: `src/controllers/videosController.js` (add `getPlayback`)
- Modify: `src/routes/videosRoutes.js`
- Test: `test/videoPlayback.test.js` (create)

**Interfaces:**
- Consumes: `loadVideoForUser` (existing), `getProvider` (Task 5).
- Produces: `GET /videos/:id/playback` → `{ provider, video_url }` for youtube, `{ provider, hls_url, token, expires_at }` for bunny; `409` when not ready.

- [ ] **Step 1: Write the failing test**

Create `test/videoPlayback.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { playbackResponse } = require('../src/controllers/videosController');

test('a youtube video returns its stored url and no token', () => {
  const result = playbackResponse({ provider: 'youtube', video_url: 'https://y/1' });
  assert.equal(result.status, 200);
  assert.equal(result.body.video_url, 'https://y/1');
  assert.equal(result.body.token, undefined);
});

// Review Focus #2: a lecture published before encoding finished must not hand
// out a token for an asset that cannot play.
test('a bunny video still processing returns 409 rather than a dead token', () => {
  const result = playbackResponse({
    provider: 'bunny', bunny_video_id: 'g', processing_status: 'processing',
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.token, undefined);
  assert.match(result.body.error, /still being processed/i);
});

test('a failed bunny video returns 409', () => {
  const result = playbackResponse({
    provider: 'bunny', bunny_video_id: 'g', processing_status: 'failed',
  });
  assert.equal(result.status, 409);
});

test('a ready bunny video returns a token and expiry', () => {
  const result = playbackResponse({
    provider: 'bunny', bunny_video_id: 'g', processing_status: 'ready', duration_seconds: 60,
  });
  assert.equal(result.status, 200);
  assert.match(result.body.token, /^[0-9a-f]{64}$/);
  assert.ok(result.body.expires_at > Math.floor(Date.now() / 1000));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A5 videoPlayback`
Expected: FAIL — `playbackResponse` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/controllers/videosController.js`, as a module-level pure function (outside `createVideosController`, so it is testable without a request):

```js
const { getProvider } = require('../services/video');

// Pure: maps an already-authorised video to its playback response.
function playbackResponse(video) {
  if (video.provider !== 'bunny') {
    return { status: 200, body: { provider: 'youtube', video_url: video.video_url } };
  }
  if (video.processing_status !== 'ready') {
    return {
      status: 409,
      body: { error: 'This lecture is still being processed. Try again in a few minutes.' },
    };
  }
  const { hls_url: hlsUrl, token, expires_at: expiresAt } = getProvider('bunny').getPlaybackToken(video);
  return { status: 200, body: { provider: 'bunny', hls_url: hlsUrl, token, expires_at: expiresAt } };
}
```

Inside `createVideosController`:

```js
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
```

Add `getPlayback` to the returned object, and change the module export:

```js
module.exports = { createVideosController, playbackResponse };
```

In `src/routes/videosRoutes.js`:

```js
  router.get(
    '/videos/:id/playback',
    authMiddleware,
    authorize.any('CanAccessVideos', 'CanViewVideos'),
    controller.getPlayback
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -A5 videoPlayback`
Expected: PASS (four tests).

- [ ] **Step 5: Verify no token leaks from the list endpoint**

Run: `grep -n "token" src/controllers/videosController.js | grep -i "listVideos" || echo "no token in listVideos - correct"`
Expected: the message. `listVideos` must not call `getPlaybackToken`.

- [ ] **Step 6: Commit**

```bash
git add src/controllers/videosController.js src/routes/videosRoutes.js test/videoPlayback.test.js
git commit -m "feat(video): authorize playback with short-lived Bunny tokens"
```

---

### Task 10: `.env.example` and provider config

**Files:**
- Modify: `.env.example`

**Interfaces:**
- Produces: documented env names. No code depends on this task.

- [ ] **Step 1: Add the keys (names only, no values)**

Append to `.env.example`:

```
# Bunny Stream (hosted lecture videos). Values live in .env only.
VIDEO_PROVIDER=bunny
BUNNY_STREAM_LIBRARY_ID=
BUNNY_STREAM_API_KEY=
BUNNY_STREAM_READONLY_API_KEY=
BUNNY_STREAM_TOKEN_KEY=
BUNNY_STREAM_CDN_HOSTNAME=
BUNNY_PLAYBACK_TOKEN_TTL=14400
```

- [ ] **Step 2: Confirm no secret was committed**

Run: `git diff --cached .env.example | grep -E "=[^ ]+$" | grep -v "VIDEO_PROVIDER=bunny\|TTL=14400" || echo "no values present - correct"`
Expected: the message.

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "docs: document Bunny Stream environment variables"
```

---

### Task 11: New admin page — `AdminLectures`

**Files:**
- Create: `frontend/soulmed/src/pages/AdminLectures.jsx`
- Create: `frontend/soulmed/src/api/lecturesClient.js`
- Modify: `frontend/soulmed/src/pages.config.js`
- Modify: `frontend/soulmed/src/lib/navItems.js`

**Interfaces:**
- Consumes: `POST /videos` (existing, with `provider: 'bunny'`), `POST /videos/:id/upload-url` (Task 7), `GET /videos?all=true` (existing).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Add the tus dependency**

Run: `cd frontend/soulmed && npm install tus-js-client`

- [ ] **Step 2: Create the API client**

Create `src/api/lecturesClient.js`:

```js
import * as tus from 'tus-js-client';
import { httpRequest } from '@/api/httpClient';

export const lecturesClient = {
  async list() {
    const data = await httpRequest('/videos?all=true');
    return (data.videos || []).filter((v) => v.provider === 'bunny');
  },
  async create(payload) {
    const data = await httpRequest('/videos', {
      method: 'POST',
      body: JSON.stringify({ ...payload, provider: 'bunny' }),
    });
    return data.video;
  },
  async upload(videoId, file, onProgress) {
    const creds = await httpRequest(`/videos/${videoId}/upload-url`, { method: 'POST' });
    return new Promise((resolve, reject) => {
      const upload = new tus.Upload(file, {
        endpoint: creds.tus_endpoint,
        retryDelays: [0, 3000, 5000, 10000, 20000],
        headers: {
          AuthorizationSignature: creds.signature,
          AuthorizationExpire: String(creds.expires),
          VideoId: creds.video_id,
          LibraryId: creds.library_id,
        },
        metadata: { filetype: file.type, title: file.name },
        onError: reject,
        onProgress: (sent, total) => onProgress?.(Math.round((sent / total) * 100)),
        onSuccess: resolve,
      });
      upload.start();
    });
  },
};
```

- [ ] **Step 3: Build the page**

Create `src/pages/AdminLectures.jsx` following the structure of `AdminVideos.jsx` (same subject dropdown via `useSubjects({ all: true })`, same title/teacher/subtopic/order/plan fields), with these differences:

- A file input (`accept="video/*"`) replacing the `video_url` text field
- Save creates the video record first, then calls `lecturesClient.upload(...)` with a progress bar
- A **Status** column rendering `processing_status` as a badge: `uploading` slate, `processing` blue, `ready` emerald, `failed` red
- The publish switch is `disabled={row.processing_status !== 'ready'}` with the tooltip "Available once processing finishes"
- The list polls with `refetchInterval` while any row is `uploading` or `processing`, mirroring [AdminAIContent.jsx:56-59](../../frontend/soulmed/src/pages/AdminAIContent.jsx#L56-L59)

- [ ] **Step 4: Register the page**

In `src/pages.config.js`, alongside the other lazy imports:

```js
const AdminLectures = lazy(() => import('./pages/AdminLectures'));
```

Add `"AdminLectures": AdminLectures,` to the page map and
`AdminLectures: { permissions: [PERMISSIONS.CanViewVideos] },` to the permissions map.

In `src/lib/navItems.js`, add to `adminNavItems`:

```js
  { name: 'Lecture Library', icon: PlayCircle, page: 'AdminLectures', permissions: [PERMISSIONS.CanAddVideos] },
```

No ordering metadata is needed — the sidebar sorts alphabetically.

- [ ] **Step 5: Verify lint**

Run: `cd frontend/soulmed && npx eslint src/pages/AdminLectures.jsx src/api/lecturesClient.js src/lib/navItems.js src/pages.config.js`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/pages/AdminLectures.jsx src/api/lecturesClient.js src/pages.config.js src/lib/navItems.js package.json package-lock.json
git commit -m "feat(admin): add Lecture Library page with resumable Bunny uploads"
```

---

### Task 12: Student player branches on provider

**Files:**
- Modify: `frontend/soulmed/src/api/videosClient.js`
- Modify: `frontend/soulmed/src/pages/Videos.jsx:452-465`

**Interfaces:**
- Consumes: `GET /videos/:id/playback` (Task 9).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Add the playback call**

In `src/api/videosClient.js`:

```js
  async getPlayback(id) {
    return request(`/videos/${id}/playback`);
  },
```

- [ ] **Step 2: Add the hls.js dependency**

Run: `cd frontend/soulmed && npm install hls.js`

- [ ] **Step 3: Fetch playback when a video is opened**

In `Videos.jsx`, alongside the existing summary effect:

```jsx
  const [playback, setPlayback] = useState(null);
  const [playbackError, setPlaybackError] = useState('');

  useEffect(() => {
    // Clear on EVERY id change, not just when the selection empties. The
    // hls.js effect below is keyed on `playback`, so leaving the previous
    // video's payload in place while the new fetch is in flight keeps the old
    // Hls instance attached to the same <video> node — the previous lecture
    // keeps playing under the new lecture's title, and any progress sync in
    // that window writes the old video's currentTime against the new id.
    setPlayback(null);
    setPlaybackError('');
    if (!selectedVideo?.id) return undefined;
    let cancelled = false;
    videosClient
      .getPlayback(selectedVideo.id)
      .then((data) => { if (!cancelled) { setPlayback(data); setPlaybackError(''); } })
      .catch((err) => { if (!cancelled) { setPlayback(null); setPlaybackError(err.message || 'Unable to play this video.'); } });
    return () => { cancelled = true; };
  }, [selectedVideo?.id]);
```

- [ ] **Step 4: Attach hls.js for Bunny sources**

Add below that effect. Safari plays HLS natively, so hls.js is only attached where it is needed:

```jsx
  useEffect(() => {
    const el = videoRef.current;
    if (!el || playback?.provider !== 'bunny') return undefined;
    // token_path must ride along URL-encoded, or Bunny will not match the
    // directory token and every .ts segment 403s a few seconds into playback.
    const src = `${playback.hls_url}?token=${playback.token}&expires=${playback.expires_at}`
      + `&token_path=${encodeURIComponent(playback.token_path)}`;
    if (el.canPlayType('application/vnd.apple.mpegurl')) {
      el.src = src;
      return undefined;
    }
    const hls = new Hls();
    hls.loadSource(src);
    hls.attachMedia(el);
    return () => hls.destroy();
  }, [playback]);
```

Import it at the top: `import Hls from 'hls.js';`

- [ ] **Step 5: Branch the player**

Replace the condition at `Videos.jsx:452` — currently `selectedVideo?.video_url && getEmbedUrl(selectedVideo.video_url)` — with a three-way branch:

```jsx
{playbackError ? (
  <div className="aspect-video w-full flex items-center justify-center rounded-lg border bg-slate-50">
    <p className="text-sm text-slate-600">{playbackError}</p>
  </div>
) : playback?.provider === 'youtube' && getEmbedUrl(playback.video_url) ? (
  /* the existing <iframe> block, with src={getEmbedUrl(playback.video_url)} */
) : (
  /* the existing <video ref={videoRef} …> block, with its onLoadedMetadata /
     onPause / onEnded progress handlers unchanged. For bunny the src is set by
     the hls.js effect above; for anything else fall back to selectedVideo.video_url. */
)}
```

Keep the existing `onLoadedMetadata` / `onPause` / `onEnded` handlers exactly as they are so `VideoProgress` keeps recording.

- [ ] **Step 6: Verify lint and types**

Run: `cd frontend/soulmed && npx eslint src/pages/Videos.jsx src/api/videosClient.js && npm run typecheck 2>&1 | grep -iE "Videos.jsx|videosClient" || echo "no new type errors"`
Expected: no new errors. (`npm run typecheck` has pre-existing failures elsewhere in the repo — `Videos.jsx` already reports several.)

- [ ] **Step 7: Manual verification**

Upload a short test file in Lecture Library, wait for `ready`, publish it against a subject with a plan the test student holds, and confirm: the student sees it in the right subject group, it plays, progress is recorded, and the AI chat panel still works. Then copy the HLS URL into a private window and confirm it is refused.

- [ ] **Step 8: Commit**

```bash
git add src/pages/Videos.jsx src/api/videosClient.js package.json package-lock.json
git commit -m "feat(video): play Bunny lectures via tokenized HLS"
```

---

## Deferred

**Phase 2 (transcription)** gets its own plan once Phase 1 is live: enabling Bunny Transcribe AI for a ~20-lecture pilot, storing the VTT into `transcript_text`, wiring timestamped cues into `buildVideoContext`, and deciding Bunny ($0.10/min) versus self-hosted Whisper (~$0.006/min) for the bulk library. Spec §10.

**Timeout budget once transcripts land.** Today's per-request input to the video chat/summary prompts is ~200 chars (title/subject/teacher/description only — no `transcript_text`). Once Phase 2 populates transcripts, that jumps to ~88k chars (~22k tokens) per request. `OPENAI_TIMEOUT_MS = 25000` (`src/services/tutorService.js`) is sized for the current small payload; against API Gateway's 29-second ceiling, a 22k-token prompt leaves little headroom for a slow completion. Phase 2's plan needs to settle a timeout/streaming decision (raise the timeout within Gateway's limit, move to streaming responses, or front it with an async job like the existing tutor-session queue) before transcripts are wired in.
