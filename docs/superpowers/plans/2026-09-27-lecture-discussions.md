# Lecture Discussions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A discussion thread under every lecture (peers + teachers, upvotes, teacher answers pinned), with a nickname/avatar identity layer and hide-never-delete moderation — replacing the unused Community feature.

**Architecture:** One new collection (`discussion_posts`) keyed by a generic `{type,id}` anchor; a pure rules module (`src/utils/discussions.js`) that decides identity projection, ordering, edit window, auto-hide and mute; a controller that reuses the existing per-lecture playback gate (`loadVideoForPlayback`) so "can discuss" ≡ "can play". Identity fields (`nickname`, `avatar_id`) live on `User`; avatars are a fixed SVG set shipped with the frontend, the backend only knows the ids. Frontend adds one `DiscussionPanel` component used in three places (student lecture view, admin previews) and a Profile section.

**Tech Stack:** Backend Node 22 / Express 5 / Mongoose 9 / `node:test`. Frontend React 18 / Vite 6 / TanStack Query v5 / shadcn. No new dependencies in either repo.

**Spec:** `docs/superpowers/specs/2026-09-27-lecture-discussions-design.md`

## Global Constraints

- Backend is **CommonJS**. No new dependencies in either repo.
- Tests: `npm test` → `node --test "test/**/*.test.js"`, `node:test` + `node:assert/strict`. Baseline **679/679**; the suite must stay green and pristine after every task.
- Frontend has **no unit suite**; verify with `npx eslint <changed files>` (no NEW errors) and `npm run build` (exit 0).
- Every route declares exactly one access marker (`test/rbacCoverage.test.js`). A permission declared but not yet used by a route must be listed in that test's `pendingLaterTasks` set until the route lands, and removed then.
- Every write body passes the global `bodyLimits` net; discussion `body` is additionally **2–2000 characters**, plain text.
- Identity rule (spec §4.3): students see `author_snapshot` (or "Anonymous"); holders of `CanModerateDiscussions` always also get `real_name` and `email`.
- The lecture gate is `loadVideoForPlayback(user, lectureId)` from `videosController` — never a new entitlement rule.
- Hide, never delete. Reports: 3 distinct reporters auto-hide. Mute: 3 hidden posts in 30 days → `discussion_muted_until = now + 7d`.
- Nickname: trimmed, 2–20 chars, `/^[A-Za-z0-9]+( [A-Za-z0-9]+)*$/`, not reserved (`admin`, `teacher`, `soulmed`, `moderator`, `anonymous`, `staff`, `support`), unique case-insensitively via `nickname_lc`.
- Avatar ids: `avatar-01` … `avatar-24` and `avatar-default`.
- Preserve each file's line endings; do not reformat unrelated code. In `Videos.jsx` the hls effect, `selectedVideoIdRef`, chat and `syncProgress` blocks must not change.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. **A student who lost access to a lecture** (playlist unpublished, plan downgraded) must get 404 on both `GET` and `POST /discussions` for it, exactly like playback — pinned in Task 3 (controller test "gate mirrors playback").
2. **An anonymous post viewed by a moderator** must still carry `real_name`/`email`; viewed by a student must carry neither the name nor the avatar nor the `author_id` — pinned in Task 2 (`displayIdentity` tests, including that `author_id` is stripped for students).
3. **The third report from the same user** must not auto-hide (distinct reporters only) — pinned in Task 2 (`shouldAutoHide`).
4. **Editing after 15 minutes**, or editing someone else's post, must 403 — pinned in Task 3 (controller tests).
5. **Two students choosing the same nickname with different case** — the second must be refused, and the availability endpoint must say so — pinned in Task 1 (validator + `nickname_lc` unique index) and Task 1's controller test for the 409.

---

### Task 1: Identity — nickname and avatar on the user (backend)

**Files:**
- Create: `src/utils/identity.js`
- Modify: `src/models/User.js` (after `token_version`), `src/controllers/authController.js` (`updateMe` allowlist + validation; new `nicknameAvailable`), `src/routes/authRoutes.js`, `src/controllers/usersController.js` (clear nickname), `src/utils/userUtils.js` (nothing to strip — nickname/avatar are public)
- Test: `test/identity.test.js`, `test/rbacRoutesPeople.test.js` (auth route expectation)

**Interfaces:**
- Produces: `validateNickname(raw) → { ok: true, value, lc } | { ok: false, error }`; `isValidAvatarId(id) → boolean`; `AVATAR_IDS: string[]`; `DEFAULT_AVATAR_ID = 'avatar-default'`; `displayNameFor(user) → nickname || first word of full_name || 'Student'`.
- Consumes: nothing new.

- [ ] **Step 1: Failing tests for the pure helpers**

```js
// test/identity.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateNickname, isValidAvatarId, AVATAR_IDS, DEFAULT_AVATAR_ID, displayNameFor } = require('../src/utils/identity');

test('validateNickname: trims, enforces 2-20 chars, letters/digits/single spaces', () => {
  assert.deepEqual(validateNickname('  Dr Neuron  '), { ok: true, value: 'Dr Neuron', lc: 'dr neuron' });
  assert.equal(validateNickname('a').ok, false);
  assert.equal(validateNickname('x'.repeat(21)).ok, false);
  assert.equal(validateNickname('two  spaces').ok, false);
  assert.equal(validateNickname('bad-char!').ok, false);
  assert.equal(validateNickname(42).ok, false);
});

test('validateNickname: reserved words are refused case-insensitively', () => {
  for (const word of ['admin', 'Teacher', 'SOULMED', 'moderator', 'Anonymous', 'staff', 'support']) {
    assert.equal(validateNickname(word).ok, false, word);
  }
});

test('avatar ids: 24 numbered plus the default; anything else is invalid', () => {
  assert.equal(AVATAR_IDS.length, 25);
  assert.ok(AVATAR_IDS.includes('avatar-01') && AVATAR_IDS.includes('avatar-24') && AVATAR_IDS.includes(DEFAULT_AVATAR_ID));
  assert.equal(isValidAvatarId('avatar-07'), true);
  assert.equal(isValidAvatarId('avatar-25'), false);
  assert.equal(isValidAvatarId('../x.svg'), false);
  assert.equal(isValidAvatarId(''), true, 'empty means "use the default"');
});

test('displayNameFor: nickname, else first name, else Student', () => {
  assert.equal(displayNameFor({ nickname: 'Dr Neuron', full_name: 'Anand Pandey' }), 'Dr Neuron');
  assert.equal(displayNameFor({ nickname: '', full_name: 'Anand Pandey' }), 'Anand');
  assert.equal(displayNameFor({}), 'Student');
});
```

- [ ] **Step 2: Run** `node --test test/identity.test.js` → FAIL (module not found).

- [ ] **Step 3: Implement `src/utils/identity.js`**

```js
const RESERVED = new Set(['admin', 'teacher', 'soulmed', 'moderator', 'anonymous', 'staff', 'support']);
const NICKNAME_PATTERN = /^[A-Za-z0-9]+( [A-Za-z0-9]+)*$/;
const DEFAULT_AVATAR_ID = 'avatar-default';
const AVATAR_IDS = Object.freeze([
  ...Array.from({ length: 24 }, (_, i) => `avatar-${String(i + 1).padStart(2, '0')}`),
  DEFAULT_AVATAR_ID,
]);

function validateNickname(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'Nickname must be text' };
  const value = raw.trim();
  if (value.length < 2 || value.length > 20) return { ok: false, error: 'Nickname must be 2 to 20 characters' };
  if (!NICKNAME_PATTERN.test(value)) return { ok: false, error: 'Use letters, numbers and single spaces only' };
  const lc = value.toLowerCase();
  if (RESERVED.has(lc)) return { ok: false, error: 'That nickname is reserved' };
  return { ok: true, value, lc };
}

// '' is allowed and means "the default avatar".
const isValidAvatarId = (id) => id === '' || AVATAR_IDS.includes(id);

function displayNameFor(user) {
  if (user?.nickname) return user.nickname;
  const first = String(user?.full_name || '').trim().split(/\s+/)[0];
  return first || 'Student';
}

module.exports = { validateNickname, isValidAvatarId, AVATAR_IDS, DEFAULT_AVATAR_ID, displayNameFor };
```

- [ ] **Step 4: Run** `node --test test/identity.test.js` → PASS.

- [ ] **Step 5: User model fields** — in `src/models/User.js` directly after the `refresh_tokens` block add:

```js
    // Public identity for discussions (spec §4). nickname_lc backs the
    // case-insensitive uniqueness; sparse so users without one don't collide.
    nickname: { type: String, default: '' },
    nickname_lc: { type: String, index: { unique: true, sparse: true } },
    avatar_id: { type: String, default: '' },
    // Set when a moderator hides a third post within 30 days (spec §6).
    discussion_muted_until: { type: Date },
```

- [ ] **Step 6: `PATCH /auth/me` accepts nickname and avatar** — in `authController.updateMe`, add `'nickname'`, `'avatar_id'` to `allowedFields` (the list containing `'target_exam'`), then after the existing `college/target_exam/year_of_study` length loop add:

```js
    if (Object.prototype.hasOwnProperty.call(updates, 'avatar_id') && !isValidAvatarId(String(updates.avatar_id ?? ''))) {
      return res.status(400).json({ error: 'Unknown avatar' });
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'nickname')) {
      const raw = String(updates.nickname ?? '').trim();
      if (raw === '') {
        updates.nickname = '';
        updates.nickname_lc = undefined; // $unset below keeps the sparse index clean
      } else {
        const check = validateNickname(raw);
        if (!check.ok) return res.status(400).json({ error: check.error });
        const taken = await User.exists({ nickname_lc: check.lc, _id: { $ne: req.userId } });
        if (taken) return res.status(409).json({ error: 'That nickname is already taken' });
        updates.nickname = check.value;
        updates.nickname_lc = check.lc;
      }
    }
```

and make the write use `$unset` for a cleared nickname: where `updateMe` builds its `findByIdAndUpdate`, split `updates` into `$set` (everything except `nickname_lc: undefined`) and `$unset: { nickname_lc: '' }` when clearing. Import `{ validateNickname, isValidAvatarId }` from `../utils/identity` at the top.

- [ ] **Step 7: Availability endpoint** — in `authController` add and export:

```js
async function nicknameAvailable(req, res) {
  try {
    const check = validateNickname(String(req.query.nickname || ''));
    if (!check.ok) return res.json({ available: false, reason: check.error });
    const taken = await User.exists({ nickname_lc: check.lc, _id: { $ne: req.userId } });
    return res.json({ available: !taken, value: check.value });
  } catch (err) {
    reportError(req, err);
    return res.status(500).json({ error: 'Failed to check nickname' });
  }
}
```

In `src/routes/authRoutes.js` after the `/me` routes: `router.get('/nickname-available', authMiddleware, selfService, authController.nicknameAvailable);`

- [ ] **Step 8: Admin clears a nickname** — in `usersController.updateUser` add `'nickname'` to `allowedFields`; then, before the update is applied:

```js
      if (Object.prototype.hasOwnProperty.call(payload, 'nickname')) {
        // Admins only CLEAR nicknames (moderation); they do not set them.
        if (String(payload.nickname || '').trim() !== '') {
          return res.status(400).json({ error: 'nickname can only be cleared here' });
        }
        payload.nickname = '';
        unsetOps.nickname_lc = '';
        clearedNickname = existing.nickname || '';
      }
```

(declare `let clearedNickname = ''; const unsetOps = {};` near the top of the handler, and merge `$unset: unsetOps` into the update when non-empty). After a successful update, if `clearedNickname` is non-empty: `await recordAudit(req, { action: 'user.nickname_cleared', target_type: 'user', target_id: existing._id, target_label: existing.email, before: { nickname: clearedNickname } });` and, if the controller has `createNotification`, `await createNotification({ userEmail: existing.email, title: 'Nickname removed', message: 'Your nickname was removed by a moderator. You can choose a new one from your profile.', type: 'warning', link: '/Profile' })` — check how `createUsersController` receives dependencies and thread `createNotification` through `createUsersRoutes` the same way `doubtsRoutes` does if it is not already there.

- [ ] **Step 9: Route test** — in `test/rbacRoutesPeople.test.js`, in the auth routes test add `expectRule(routes, 'GET', '/auth/nickname-available', 'self', []);`.

- [ ] **Step 10: Controller tests** — append to `test/identity.test.js` (stub style from `test/rbacMediaControllers.test.js`: `stub(User, 'exists', …)`, `stub(User, 'findByIdAndUpdate', …)`):

```js
test('updateMe: a nickname taken by another user (any case) is refused 409, nothing written', async () => { /* stub User.findById -> q(self); User.exists -> async () => true; assert 409 and no findByIdAndUpdate call */ });
test('updateMe: a valid unique nickname is stored as typed with its lower-case twin', async () => { /* User.exists -> false; capture findByIdAndUpdate arg; assert $set.nickname === 'Dr Neuron' && $set.nickname_lc === 'dr neuron' */ });
test('updateMe: an unknown avatar id is refused 400', async () => { /* avatar_id: 'avatar-99' -> 400 */ });
```

Write these out fully in the file (the comments above describe the arrangement; the assertions must be real).

- [ ] **Step 11: Run** `npm test` → all green (679 + new). **Commit:**

```bash
git add src/utils/identity.js src/models/User.js src/controllers/authController.js src/controllers/usersController.js src/routes/authRoutes.js test/identity.test.js test/rbacRoutesPeople.test.js
git commit -m "feat(identity): nickname and avatar on the user, availability check, admin clear"
```

---

### Task 2: Discussion rules, model and permissions (backend, no routes yet)

**Files:**
- Create: `src/models/DiscussionPost.js`, `src/utils/discussions.js`, `src/utils/profanity.js`
- Modify: `src/rbac/permissions.js`, `src/rbac/legacyMap.js`, `test/rbacCoverage.test.js` (`pendingLaterTasks`), `test/rbacLegacyMap.test.js`, `test/rbacMigration.test.js`
- Test: `test/discussions.test.js`, `test/profanity.test.js`

**Interfaces:**
- Produces: `displayIdentity(post, { viewerIsModerator, author }) → object`; `sortThread(posts) → posts`; `canEditPost(post, userId, now) → boolean`; `shouldAutoHide(reports) → boolean`; `nextMuteUntil(hiddenDates, now) → Date | null`; `containsProfanity(text) → boolean`; constants `EDIT_WINDOW_MS = 15*60*1000`, `AUTO_HIDE_REPORTS = 3`, `MUTE_THRESHOLD = 3`, `MUTE_DAYS = 7`, `REPORT_REASONS = ['spam','abuse','wrong','other']`, `BODY_MIN = 2`, `BODY_MAX = 2000`.
- Consumes: `displayNameFor`, `DEFAULT_AVATAR_ID` from Task 1.

- [ ] **Step 1: Permissions** — in `src/rbac/permissions.js`:
  - in the StudentPages block add `one('StudentPages', 'CanAccessDiscussions', 'Discuss lectures', 'Read and post in the discussion under each lecture.'),`
  - after the Doubts block add `one('Discussions', 'CanModerateDiscussions', 'Moderate discussions', 'Pin answers, hide posts and see who wrote anonymous posts.'),`
  - in `src/rbac/legacyMap.js`: `manage_doubts: [...all('Doubts'), 'CanModerateDiscussions'],` (students get `CanAccessDiscussions` automatically via `STUDENT_PAGES`; teachers via the student-page spread).
  - in `test/rbacCoverage.test.js` set `const pendingLaterTasks = new Set(['CanAccessDiscussions', 'CanModerateDiscussions']);` with a comment naming Task 3.
  - update `test/rbacLegacyMap.test.js` / `test/rbacMigration.test.js` only if they enumerate `manage_doubts` exactly (run them; fix expectations to include the new code).

- [ ] **Step 2: Failing tests for the rules**

```js
// test/discussions.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  displayIdentity, sortThread, canEditPost, shouldAutoHide, nextMuteUntil,
  EDIT_WINDOW_MS, MUTE_DAYS,
} = require('../src/utils/discussions');

const post = (over = {}) => ({ _id: 'p1', author_id: 'u1', author_snapshot: { display_name: 'Dr Neuron', avatar_id: 'avatar-03' }, is_anonymous: false, ...over });
const author = { _id: 'u1', full_name: 'Anand Pandey', email: 'a@x.com', nickname: 'Dr Neuron' };

test('displayIdentity: a student sees the snapshot and never the author id, name or email', () => {
  const out = displayIdentity(post(), { viewerIsModerator: false, author });
  assert.deepEqual(out, { display_name: 'Dr Neuron', avatar_id: 'avatar-03', is_anonymous: false });
});
test('displayIdentity: anonymous post -> student sees Anonymous + default avatar only', () => {
  const out = displayIdentity(post({ is_anonymous: true }), { viewerIsModerator: false, author });
  assert.deepEqual(out, { display_name: 'Anonymous', avatar_id: 'avatar-default', is_anonymous: true });
});
test('displayIdentity: a moderator always gets real_name and email, even on anonymous posts', () => {
  const out = displayIdentity(post({ is_anonymous: true }), { viewerIsModerator: true, author });
  assert.equal(out.display_name, 'Anonymous');
  assert.equal(out.real_name, 'Anand Pandey');
  assert.equal(out.email, 'a@x.com');
  assert.equal(out.author_id, 'u1');
  assert.equal(out.nickname, 'Dr Neuron');
});

test('sortThread: pinned first, then teacher replies, then most upvoted, then oldest', () => {
  const mk = (id, o) => ({ _id: id, created_date: new Date(2026, 0, o.day || 1), upvotes: Array(o.up || 0).fill('x'), is_pinned: !!o.pin, is_teacher_reply: !!o.t });
  const sorted = sortThread([mk('old', { day: 1 }), mk('up', { day: 2, up: 5 }), mk('teacher', { day: 3, t: true }), mk('pinned', { day: 4, pin: true }), mk('new', { day: 5 })]);
  assert.deepEqual(sorted.map((p) => p._id), ['pinned', 'teacher', 'up', 'old', 'new']);
});

test('canEditPost: own post within 15 minutes only', () => {
  const now = Date.now();
  assert.equal(canEditPost({ author_id: 'u1', created_date: new Date(now - 60_000) }, 'u1', now), true);
  assert.equal(canEditPost({ author_id: 'u1', created_date: new Date(now - EDIT_WINDOW_MS - 1) }, 'u1', now), false);
  assert.equal(canEditPost({ author_id: 'u1', created_date: new Date(now) }, 'u2', now), false);
});

test('shouldAutoHide: three DISTINCT reporters, not three reports from one person', () => {
  assert.equal(shouldAutoHide([{ user_id: 'a' }, { user_id: 'b' }]), false);
  assert.equal(shouldAutoHide([{ user_id: 'a' }, { user_id: 'a' }, { user_id: 'a' }]), false);
  assert.equal(shouldAutoHide([{ user_id: 'a' }, { user_id: 'b' }, { user_id: 'c' }]), true);
});

test('nextMuteUntil: third hidden post within 30 days mutes for 7 days; older hides do not count', () => {
  const now = Date.now(); const d = (daysAgo) => new Date(now - daysAgo * 86400000);
  assert.equal(nextMuteUntil([d(1), d(2)], now), null);
  assert.equal(nextMuteUntil([d(1), d(2), d(40)], now), null);
  const until = nextMuteUntil([d(1), d(2), d(3)], now);
  assert.equal(until.getTime(), now + MUTE_DAYS * 86400000);
});
```

```js
// test/profanity.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { containsProfanity } = require('../src/utils/profanity');
test('containsProfanity: whole words, case-insensitive, no false positives on substrings', () => {
  assert.equal(containsProfanity('This is a perfectly fine question about the scrotum'), false, 'anatomy is not profanity');
  assert.equal(containsProfanity('what the F*** is this'), false, 'masked words are not matched by the simple filter');
  assert.equal(containsProfanity('you are a bastard'), true);
  assert.equal(containsProfanity('BASTARD!'), true);
  assert.equal(containsProfanity(''), false);
});
```

- [ ] **Step 3: Run both** → FAIL (modules missing).

- [ ] **Step 4: Implement `src/utils/discussions.js`**

```js
const { DEFAULT_AVATAR_ID } = require('./identity');

const EDIT_WINDOW_MS = 15 * 60 * 1000;
const AUTO_HIDE_REPORTS = 3;
const MUTE_THRESHOLD = 3;
const MUTE_DAYS = 7;
const MUTE_LOOKBACK_DAYS = 30;
const REPORT_REASONS = Object.freeze(['spam', 'abuse', 'wrong', 'other']);
const BODY_MIN = 2;
const BODY_MAX = 2000;

// Spec §4.3. Students get the snapshot (or "Anonymous"); moderators get the
// same plus who really wrote it. author_id is deliberately absent for
// students so an anonymous author can't be correlated across posts.
function displayIdentity(post, { viewerIsModerator, author }) {
  const base = post.is_anonymous
    ? { display_name: 'Anonymous', avatar_id: DEFAULT_AVATAR_ID, is_anonymous: true }
    : {
      display_name: post.author_snapshot?.display_name || 'Student',
      avatar_id: post.author_snapshot?.avatar_id || DEFAULT_AVATAR_ID,
      is_anonymous: false,
    };
  if (!viewerIsModerator) return base;
  return {
    ...base,
    author_id: String(post.author_id),
    real_name: author?.full_name || '',
    email: author?.email || '',
    nickname: author?.nickname || '',
  };
}

// Pinned answer, then teacher replies, then by upvotes, then oldest first.
function sortThread(posts) {
  return [...posts].sort((a, b) =>
    Number(!!b.is_pinned) - Number(!!a.is_pinned)
    || Number(!!b.is_teacher_reply) - Number(!!a.is_teacher_reply)
    || (b.upvotes?.length || 0) - (a.upvotes?.length || 0)
    || new Date(a.created_date) - new Date(b.created_date));
}

function canEditPost(post, userId, now = Date.now()) {
  if (String(post.author_id) !== String(userId)) return false;
  return now - new Date(post.created_date).getTime() <= EDIT_WINDOW_MS;
}

function shouldAutoHide(reports) {
  return new Set((reports || []).map((r) => String(r.user_id))).size >= AUTO_HIDE_REPORTS;
}

// hiddenDates: created_date of the author's posts hidden by a moderator or
// by reports. Returns the new mute expiry, or null if under the threshold.
function nextMuteUntil(hiddenDates, now = Date.now()) {
  const cutoff = now - MUTE_LOOKBACK_DAYS * 86400000;
  const recent = (hiddenDates || []).filter((d) => new Date(d).getTime() >= cutoff);
  return recent.length >= MUTE_THRESHOLD ? new Date(now + MUTE_DAYS * 86400000) : null;
}

module.exports = {
  displayIdentity, sortThread, canEditPost, shouldAutoHide, nextMuteUntil,
  EDIT_WINDOW_MS, AUTO_HIDE_REPORTS, MUTE_THRESHOLD, MUTE_DAYS, MUTE_LOOKBACK_DAYS, REPORT_REASONS, BODY_MIN, BODY_MAX,
};
```

- [ ] **Step 5: Implement `src/utils/profanity.js`** — a short list (English + common Hindi transliterations; ~30 words), whole-word, case-insensitive:

```js
// Deliberately small and whole-word: this stops the obvious, not the
// determined. Anatomy terms must never trip it. Moderators handle the rest.
const WORDS = ['bastard', 'bitch', 'asshole', 'fuck', 'fucking', 'shit', 'dick', 'cunt', 'slut', 'whore', 'motherfucker',
  'chutiya', 'bhosdike', 'madarchod', 'behenchod', 'gandu', 'randi', 'harami', 'kutte', 'kamina', 'saala'];
const PATTERN = new RegExp(`\\b(${WORDS.join('|')})\\b`, 'i');
const containsProfanity = (text) => PATTERN.test(String(text || ''));
module.exports = { containsProfanity, WORDS };
```

- [ ] **Step 6: Model `src/models/DiscussionPost.js`** — exactly the spec §5 schema, collection name `discussion_posts`, `timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' }`, the three indexes, and `report_count` kept equal to `reports.length` by the controller (`$push` + `$inc` in one update).

- [ ] **Step 7: Run** `npm test` → green (coverage test satisfied via `pendingLaterTasks`). **Commit:**

```bash
git add src/models/DiscussionPost.js src/utils/discussions.js src/utils/profanity.js src/rbac/permissions.js src/rbac/legacyMap.js test/discussions.test.js test/profanity.test.js test/rbacCoverage.test.js test/rbacLegacyMap.test.js test/rbacMigration.test.js
git commit -m "feat(discussions): model, pure rules, profanity filter and permissions"
```

---

### Task 3: Discussions API (backend)

**Files:**
- Create: `src/controllers/discussionsController.js`, `src/routes/discussionsRoutes.js`
- Modify: `src/server.js` (mount), `src/controllers/videosController.js` (export `loadVideoForPlayback` from the factory; delete a lecture's posts in `permanentlyDeleteVideo`), `test/rbacCoverage.test.js` (empty `pendingLaterTasks`), `test/rbacRoutesContent.test.js`
- Test: `test/discussionsController.test.js`

**Interfaces:**
- Consumes: Task 2 rules; `createVideosController().loadVideoForPlayback(user, id)`; `createNotification` from `server.js`; `recordAudit`; `createRateLimiter` + `userOrIpKey`; `reportError`; `can`.
- Produces the routes in spec §6. Response shapes:
  - `GET /discussions` → `{ posts: [ { _id, body, video_time, created_date, edited_at, upvote_count, upvoted_by_me, is_teacher_reply, is_pinned, is_hidden?, reply_count, identity: {…displayIdentity}, replies: [ …same shape ] } ], muted_until: Date|null }`
  - `POST /discussions` → `{ post }` (same shape, 201)
  - `POST /discussions/:id/upvote` → `{ upvoted: boolean, upvote_count }`
  - `POST /discussions/:id/report` → `{ ok: true, hidden: boolean }`
  - `PATCH /discussions/:id` → `{ post }`
  - `GET /discussions/reports` → `{ posts: [...] }` with moderator identities and `report_count`, `reports`.

- [ ] **Step 1: Expose the gate** — in `videosController`, add `loadVideoForPlayback` to the object returned by `createVideosController()` (it is already defined inside the factory). In `permanentlyDeleteVideo`, after `VideoProgress.deleteMany`, add `const discussions = await DiscussionPost.deleteMany({ 'anchor.type': 'lecture', 'anchor.id': video._id });` and include `discussions_deleted: discussions.deletedCount` in the audit `before` and the response. Extend the existing hard-delete tests' `stubCleanup` with `stub(DiscussionPost, 'deleteMany', async () => ({ deletedCount: 0 }))`.

- [ ] **Step 2: Failing controller tests** — `test/discussionsController.test.js`, stub style of `test/rbacMediaControllers.test.js` (`stub`, `q`, `mockRes`, `makeUser`, `AuditLog.create` no-op). Construct the controller with `createDiscussionsController({ createNotification: async () => {}, loadVideoForPlayback })` where `loadVideoForPlayback` is a stub you control per test. Tests to write (each with real stubs and assertions):

  1. `listThread: gate mirrors playback — when loadVideoForPlayback returns {error,status:404}, respond 404 and never query posts`
  2. `listThread: students receive snapshot identities only; moderators receive real_name/email and hidden posts`
  3. `createPost: 403 with the date while muted; 400 on profanity; 400 outside 2–2000; 201 sets author_snapshot from the user and is_teacher_reply from CanModerateDiscussions`
  4. `createPost: a reply to a reply is re-parented to the top-level post`
  5. `createPost: replying notifies the parent author (not yourself), with "Teacher" prefix for moderators`
  6. `upvote: toggles, refuses own post`
  7. `report: one per user; third distinct reporter hides with reason auto_reports and audits discussion.hidden`
  8. `updatePost: author may edit body within 15 min, not after; moderator may pin/hide; student cannot pin`
  9. `updatePost: a moderator hide that makes the author's third hidden post in 30 days sets discussion_muted_until and notifies`
  10. `listReports: only posts with reports or hidden, newest first, moderator identities`

- [ ] **Step 3: Run** → FAIL (module missing).

- [ ] **Step 4: Implement `src/controllers/discussionsController.js`**

Skeleton (fill every handler; keep each in the try/`reportError`/500 shape used elsewhere):

```js
const mongoose = require('mongoose');
const DiscussionPost = require('../models/DiscussionPost');
const User = require('../models/User');
const { can } = require('../rbac/can');
const { recordAudit } = require('../utils/audit');
const { reportError } = require('../lib/errorReporter');
const { isValidObjectId } = require('../utils/security');
const { displayNameFor, DEFAULT_AVATAR_ID } = require('../utils/identity');
const { containsProfanity } = require('../utils/profanity');
const {
  displayIdentity, sortThread, canEditPost, shouldAutoHide, nextMuteUntil, REPORT_REASONS, BODY_MIN, BODY_MAX,
} = require('../utils/discussions');

const ANCHOR_TYPES = new Set(['lecture']); // 'question' is modelled, not yet served

function createDiscussionsController({ createNotification, loadVideoForPlayback }) {
  const isModerator = (user) => can(user, 'CanModerateDiscussions');

  // Resolves the anchor and applies the lecture gate. Returns { lecture } or { status, error }.
  async function gate(user, anchorType, anchorId) {
    if (!ANCHOR_TYPES.has(anchorType) || !isValidObjectId(String(anchorId))) return { status: 400, error: 'Invalid anchor' };
    const { video, error, status } = await loadVideoForPlayback(user, anchorId);
    if (!video) return { status: status || 404, error: error || 'Not found' };
    return { lecture: video };
  }

  // Shapes one post for the caller; `authors` is a Map(userId -> user) loaded once per request.
  function shape(post, { user, moderator, authors }) {
    const identity = displayIdentity(post, { viewerIsModerator: moderator, author: authors.get(String(post.author_id)) });
    const mine = String(post.author_id) === String(user._id);
    return {
      _id: post._id, body: post.body, video_time: post.video_time, created_date: post.created_date, edited_at: post.edited_at,
      upvote_count: post.upvotes?.length || 0,
      upvoted_by_me: (post.upvotes || []).some((u) => String(u) === String(user._id)),
      is_teacher_reply: !!post.is_teacher_reply, is_pinned: !!post.is_pinned,
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

  async function listThread(req, res) { /* gate → find anchor posts (hidden filtered unless moderator) → group replies under parents → sortThread replies, top-level newest first → shape → { posts, muted_until } */ }
  async function createPost(req, res) { /* muted? 403 { error: `Posting is paused until ${date}`, muted_until } ; validate body/anchor/parent (re-parent reply-to-reply) ; gate ; profanity → 400 'Please rephrase your post' ; create with author_snapshot { display_name: displayNameFor(user), avatar_id: user.avatar_id || DEFAULT_AVATAR_ID } and is_teacher_reply: isModerator(user) ; notify parent author via createNotification ; 201 { post } */ }
  async function toggleUpvote(req, res) { /* own post → 400 ; $addToSet or $pull ; { upvoted, upvote_count } */ }
  async function reportPost(req, res) { /* reason in REPORT_REASONS ; if already reported by user → 200 { ok:true, hidden: post.is_hidden } ; $push reports + $inc report_count atomically ; if shouldAutoHide → set is_hidden/hidden_reason 'auto_reports', audit, maybeMute(author) ; { ok:true, hidden } */ }
  async function updatePost(req, res) { /* moderator: is_pinned (unpin siblings in the same thread), is_hidden (+hidden_by/hidden_reason 'moderator', audit discussion.hidden/unhidden, maybeMute on hide) ; author: body within window, edited_at ; else 403 */ }
  async function listReports(req, res) { /* { $or: [{ report_count: { $gt: 0 } }, { is_hidden: true }] } sort report_count desc, created_date desc, limit 200, moderator shape + reports */ }

  async function maybeMute(req, authorId, lectureTitle) {
    const hidden = await DiscussionPost.find({ author_id: authorId, is_hidden: true, hidden_reason: { $in: ['moderator', 'auto_reports'] } }).select('created_date').lean();
    const until = nextMuteUntil(hidden.map((p) => p.created_date));
    if (!until) return;
    const author = await User.findByIdAndUpdate(authorId, { $set: { discussion_muted_until: until } }, { new: true }).lean();
    await recordAudit(req, { action: 'discussion.user_muted', target_type: 'user', target_id: authorId, target_label: author?.email, after: { muted_until: until } });
    await createNotification({ userEmail: author?.email, title: 'Posting paused', message: `Posting in discussions is paused until ${until.toDateString()} after several posts were hidden.`, type: 'warning', link: '/Videos' });
  }

  return { listThread, createPost, toggleUpvote, reportPost, updatePost, listReports };
}
module.exports = { createDiscussionsController };
```

The pseudo-comments above are the contract; write the real code for each handler with the exact status codes and messages named in the tests.

- [ ] **Step 5: Routes `src/routes/discussionsRoutes.js`**

```js
const express = require('express');
const { createDiscussionsController } = require('../controllers/discussionsController');
const { validateObjectIdParams } = require('../middlewares/validateObjectId');
const { authorize } = require('../rbac/authorize');
const { createRateLimiter, userOrIpKey } = require('../middlewares/rateLimit');

function createDiscussionsRoutes({ authMiddleware, createNotification, loadVideoForPlayback }) {
  const router = express.Router();
  validateObjectIdParams(router, ['id']);
  const controller = createDiscussionsController({ createNotification, loadVideoForPlayback });
  const postLimiter = createRateLimiter({ name: 'discussion-post', windowMs: 60 * 1000, max: 10, keyGenerator: userOrIpKey, message: 'You are posting too fast. Please wait a minute.' });

  // /discussions/reports before /discussions/:id (validateObjectIdParams would 400 "reports").
  router.get('/discussions/reports', authMiddleware, authorize('CanModerateDiscussions'), controller.listReports);
  router.get('/discussions', authMiddleware, authorize('CanAccessDiscussions'), controller.listThread);
  router.post('/discussions', authMiddleware, authorize('CanAccessDiscussions'), postLimiter, controller.createPost);
  router.post('/discussions/:id/upvote', authMiddleware, authorize('CanAccessDiscussions'), controller.toggleUpvote);
  router.post('/discussions/:id/report', authMiddleware, authorize('CanAccessDiscussions'), controller.reportPost);
  router.patch('/discussions/:id', authMiddleware, authorize.any('CanAccessDiscussions', 'CanModerateDiscussions'), controller.updatePost);
  return router;
}
module.exports = createDiscussionsRoutes;
```

Mount in `server.js` next to the doubts router: `app.use(createDiscussionsRoutes({ authMiddleware, createNotification, loadVideoForPlayback: videosController.loadVideoForPlayback }))` — obtain `videosController` the way `createVideosRoutes` builds it (if the routes file constructs its own controller, construct one here with `createVideosController()`; it is stateless).

- [ ] **Step 6: RBAC tests** — in `test/rbacRoutesContent.test.js` add a `discussions routes` test with the six `expectRule` lines matching the markers above; clear `pendingLaterTasks` back to `new Set()` in `test/rbacCoverage.test.js`.

- [ ] **Step 7: Run** `npm test` → green. **Commit:**

```bash
git add src/controllers/discussionsController.js src/routes/discussionsRoutes.js src/server.js src/controllers/videosController.js test/discussionsController.test.js test/rbacRoutesContent.test.js test/rbacCoverage.test.js test/rbacMediaControllers.test.js
git commit -m "feat(discussions): thread, post, upvote, report, moderate and report-queue routes"
```

---

### Task 4: Avatars and the Profile identity section (frontend)

**Files:**
- Create: `src/assets/avatars/avatar-01.svg` … `avatar-24.svg`, `avatar-default.svg`; `src/lib/avatars.js`; `src/components/common/Avatar.jsx`
- Modify: `src/enums/permissions.js` (add `'CanAccessDiscussions'`, `'CanModerateDiscussions'`), `src/pages/Profile.jsx`, `src/api/authClient.js` (`nicknameAvailable`)

**Interfaces:**
- Produces: `AVATARS: [{ id, src }]`, `avatarSrc(id) → url`, `<Avatar id size className />`, `authClient.nicknameAvailable(nickname) → { available, reason?, value? }`.

- [ ] **Step 1: Generate the avatar set** — run this once from the frontend folder (the generator itself is not committed; the 25 SVGs are):

```js
// node scripts/gen-avatars.mjs  (create, run, delete)
import { mkdirSync, writeFileSync } from 'node:fs';
const dir = 'src/assets/avatars'; mkdirSync(dir, { recursive: true });
const bg = ['#2563EB', '#0EA5E9', '#7C3AED', '#DB2777', '#F59E0B', '#10B981', '#14B8A6', '#E11D48', '#F97316', '#6366F1', '#84CC16', '#A855F7'];
const eyes = [(y) => `<circle cx="48" cy="${y}" r="6"/><circle cx="80" cy="${y}" r="6"/>`, (y) => `<rect x="42" y="${y - 3}" width="12" height="6" rx="3"/><rect x="74" y="${y - 3}" width="12" height="6" rx="3"/>`];
const mouths = [`<path d="M46 84 q18 16 36 0" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round"/>`, `<circle cx="64" cy="86" r="7" fill="#fff"/>`, `<rect x="50" y="82" width="28" height="5" rx="2.5" fill="#fff"/>`];
const hats = ['', `<path d="M30 46 h68 l-8 -14 h-52 z" fill="rgba(0,0,0,.25)"/>`, `<circle cx="96" cy="32" r="10" fill="rgba(255,255,255,.35)"/>`, `<path d="M34 40 q30 -22 60 0" stroke="rgba(0,0,0,.25)" stroke-width="8" fill="none"/>`];
for (let i = 1; i <= 24; i += 1) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><circle cx="64" cy="64" r="64" fill="${bg[(i - 1) % bg.length]}"/>${hats[i % hats.length]}<g fill="#fff">${eyes[i % 2](60)}</g>${mouths[i % 3]}</svg>`;
  writeFileSync(`${dir}/avatar-${String(i).padStart(2, '0')}.svg`, svg);
}
writeFileSync(`${dir}/avatar-default.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><circle cx="64" cy="64" r="64" fill="#CBD5E1"/><circle cx="64" cy="52" r="22" fill="#94A3B8"/><path d="M22 116 q42 -44 84 0 z" fill="#94A3B8"/></svg>`);
console.log('wrote 25 avatars');
```

Then confirm `ls src/assets/avatars | wc -l` prints 25 and each file starts with `<svg` (they are ~400 bytes each).

- [ ] **Step 2: `src/lib/avatars.js`**

```js
const modules = import.meta.glob('../assets/avatars/*.svg', { eager: true, query: '?url', import: 'default' });
export const AVATARS = Object.entries(modules)
  .map(([path, src]) => ({ id: path.split('/').pop().replace('.svg', ''), src }))
  .filter((a) => a.id !== 'avatar-default')
  .sort((a, b) => a.id.localeCompare(b.id));
const DEFAULT_SRC = modules['../assets/avatars/avatar-default.svg'];
export const avatarSrc = (id) => AVATARS.find((a) => a.id === id)?.src || DEFAULT_SRC;
```

`src/components/common/Avatar.jsx`: `<img src={avatarSrc(id)} alt="" className={`rounded-full ${sizeClass} ${className}`} />` with `size` ∈ `'sm'|'md'|'lg'` → `h-6 w-6 | h-9 w-9 | h-16 w-16`.

- [ ] **Step 3: Profile section** — in `Profile.jsx` add a Card "How you appear to other students": the 24-avatar grid (button per avatar, ring on the selected one, "Default" option), a Nickname `Input` (maxLength 20) with a debounced (400 ms) call to `authClient.nicknameAvailable` showing "Available" / the reason, a preview row (`<Avatar>` + nickname or first name), and Save calling `authClient.updateMe({ nickname, avatar_id })`. Show the 409 message from the server inline.

- [ ] **Step 4: Verify** — `npx eslint src/pages/Profile.jsx src/lib/avatars.js src/components/common/Avatar.jsx src/api/authClient.js src/enums/permissions.js`; `npm run build`. State in the report that no browser run was done. **Commit:**

```bash
git add src/assets/avatars src/lib/avatars.js src/components/common/Avatar.jsx src/pages/Profile.jsx src/api/authClient.js src/enums/permissions.js
git commit -m "feat(profile): choose an avatar and a nickname"
```

---

### Task 5: DiscussionPanel in the student lecture view (frontend)

**Files:**
- Create: `src/api/discussionsClient.js`, `src/components/discussions/DiscussionPanel.jsx`, `src/components/discussions/PostItem.jsx`, `src/components/discussions/Composer.jsx`
- Modify: `src/pages/Videos.jsx` (render the panel under the player column, below the Prev/Next row; pass `videoRef`)

**Interfaces:**
- Consumes: Task 3 API shapes; `useCan(PERMISSIONS.CanAccessDiscussions)`; `videoRef` (the `<video>` element) for "Ask at mm:ss" and seeking.
- Produces: `<DiscussionPanel anchorType="lecture" anchorId={id} lectureTitle videoRef moderator={false} />`.

- [ ] **Step 1: `discussionsClient`** — `list(anchorType, anchorId)`, `create(payload)`, `upvote(id)`, `report(id, reason)`, `update(id, patch)`, `listReports()`; `normalizeId` on posts and replies.

- [ ] **Step 2: Components**
  - `Composer`: textarea (2000, counter), optional time chip — when `videoRef?.current` exists a button "Ask at {mm:ss}" toggles `video_time = Math.floor(currentTime)`; an "Post anonymously" `Switch`; disabled with the server's `muted_until` message when muted; submit → `create`.
  - `PostItem`: `<Avatar>` + display name (+ "Anonymous" style), teacher badge, "Answer" badge when pinned, time chip (click → `videoRef.current.currentTime = video_time`), body (whitespace-pre-wrap), upvote button with count (optimistic toggle), Reply (opens a nested `Composer` with `parent_id`), overflow menu: Report (reason picker), Edit (own, `can_edit`). For `moderator`: Pin/Unpin, Hide/Unhide, and the real name/email line under the display name.
  - `DiscussionPanel`: header "Discussion (N)", `useQuery(['discussions', anchorType, anchorId])`, empty state, the list, error state "Unable to load the discussion" (never crashes the lecture page — wrap in the existing `AppErrorBoundary`-style fallback if needed).

- [ ] **Step 3: Mount in `Videos.jsx`** — inside the left column `<div className="space-y-4">`, after the Previous/Next row, add:

```jsx
{canDiscuss && selectedVideo?.id && (
  <DiscussionPanel anchorType="lecture" anchorId={selectedVideo.id} lectureTitle={selectedVideo.title} videoRef={videoRef} />
)}
```

with `const canDiscuss = useCan(PERMISSIONS.CanAccessDiscussions);` near the other hooks. Do not touch the hls/chat/progress blocks; confirm by reading the diff that only an import, one hook and this block changed.

- [ ] **Step 4: Verify** — eslint on the new files + `Videos.jsx`; `npm run build`; report the click-paths a human must run (post, reply, anonymous, time chip seeks, upvote, report, edit within 15 min). **Commit:**

```bash
git add src/api/discussionsClient.js src/components/discussions src/pages/Videos.jsx
git commit -m "feat(student): discussion thread under each lecture"
```

---

### Task 6: Moderator surfaces (frontend)

**Files:**
- Modify: `src/pages/AdminLectures.jsx` (Preview dialog: render `<DiscussionPanel moderator />` under the player), `src/components/admin/PlaylistItemEditor.jsx` (same in its inline preview), `src/pages/AdminDoubts.jsx` (new "Reported discussion posts" Card above the tabs, only when `useCan(CanModerateDiscussions)`), `src/pages/AdminManagement.jsx` (user detail: show nickname + `<Avatar>`; "Clear nickname" button → `usersClient.update(id, { nickname: '' })` with confirm)

- [ ] **Step 1:** AdminLectures / PlaylistItemEditor previews: pass `moderator={useCan(PERMISSIONS.CanModerateDiscussions)}` and the preview's `videoRef` if available (else omit; the time chip simply doesn't seek).
- [ ] **Step 2:** AdminDoubts report queue: `useQuery(['discussion-reports'])` → list of `PostItem`s in moderator mode with Hide / Unhide / Dismiss (Dismiss = `update(id, { is_hidden: false })` and we keep the reports; acceptable for round one), plus lecture title link.
- [ ] **Step 3:** AdminManagement: nickname display + Clear nickname (permission `CanEditUsers`, which the page already checks for edits).
- [ ] **Step 4: Verify** eslint + build. **Commit:**

```bash
git add src/pages/AdminLectures.jsx src/components/admin/PlaylistItemEditor.jsx src/pages/AdminDoubts.jsx src/pages/AdminManagement.jsx
git commit -m "feat(admin): moderate discussions from previews, doubts page and user management"
```

---

### Task 7: Docs and hand-off

**Files:**
- Modify: `docs/ops/2026-09-22-playlist-rollout-runbook.md` (a short "Discussions" note: two new permissions sync on restart; tick them for student/teacher roles on an existing database or run `scripts/migrateRbac.js --reset-defaults` knowingly), `C:\SoulMedAi\myBranch\docs\Pending-and-Needs-Review.docx` is regenerated by the controller (not this task).

- [ ] **Step 1:** Add the runbook note. **Commit:** `docs(ops): discussions permissions on rollout`.

## Operator actions (not performed by this plan)

1. On the live database: Roles → student → tick *Discuss lectures*; Roles → teacher → tick *Discuss lectures* and *Moderate discussions*.
2. Untick *Use community* on the student role (owner's decision, already planned).
