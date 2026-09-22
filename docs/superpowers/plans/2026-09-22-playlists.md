# Playlists — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate the lecture *asset* from the *product*. Lectures live in Lecture Library; playlists are curated in Video Management, gated by subscription plan, and are what students browse and play.

**Architecture:** A new `Playlist` collection holds ordered references to lectures plus entitlement (`allowed_plans`, `is_free`) and publication state. `Video` (the asset) loses `allowed_plans`, `is_free`, `is_published` and `order`. A lecture is playable iff it is active **and** the student can reach at least one published, active playlist containing it — replacing `canAccessVideo` as the single gate. Deactivating a lecture is a read-time filter, never a write to playlists, which is what makes watch history survive for free.

**Tech Stack:** Node 22 + Express 5 (CommonJS), Mongoose 9, `node:test` + `node:assert/strict`; React 18 + Vite + TanStack Query + shadcn/Radix.

**Spec:** `docs/superpowers/specs/2026-09-22-lecture-library-and-playlists-design.md`

**Depends on:** `docs/superpowers/plans/2026-09-22-subject-reference-for-lectures.md` Tasks 1-4 (lectures carry `subject_id`).

## Global Constraints

- Backend is **CommonJS**. No ESM. No new dependencies in either repo.
- Tests: `npm test` → `node --test "test/**/*.test.js"`, `node:test` + `node:assert/strict`, style per `test/grading.test.js`. The suite must stay green and pristine after every task.
- Frontend has **no unit suite**; verify with `npx eslint <changed files>` (no NEW errors) and `npm run build` (exit 0).
- **Never execute a production data migration.** Migration scripts are written and may be run with `--dry-run` (read-only) only. Executing them is the operator's decision.
- **Preserve `_id`s.** `VideoProgress.video_id` must stay valid — no lecture may be recreated with a new id.
- Every route must declare exactly one access-control marker (`test/rbacCoverage.test.js`).
- Token minting, `buildPlaybackToken`, the Bunny webhook and `nextProcessingStatus` are verified against live Bunny — do not modify them.
- Preserve each file's existing line endings; do not reformat.

## Review Focus

Failure modes the spec implies that no happy path exercises. Each is pinned by a test in the task that owns it.

1. **A lecture in no playlist becomes unplayable.** After migration, an unpublished lecture belongs to no playlist — the playback gate must return a clean 403/404, never a thrown error or an unsigned token. Task 5.
2. **A deactivated lecture must vanish for students but keep its progress.** Its playlist item stays; only reads filter it. A write that removes items would destroy history. Task 4.
3. **"Also in" must not leak playlists the student cannot open.** It lists other playlists — each must pass the same entitlement check. Task 6.
4. **Entitlement via *any* playlist.** A lecture in a free playlist and a paid one is reachable by anyone entitled to the free one — intended, and must be pinned so a later "tighten this" refactor is a deliberate choice. Task 2.
5. **Ordering must be stable.** Two items with equal `order` must not swap between requests, or students see lectures reshuffle. Task 2.

---

### Task 1: `Playlist` model

**Files:** Create `src/models/Playlist.js`; Test `test/playlistModel.test.js`

**Interfaces:** Produces the `Playlist` model per spec §4.

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Playlist = require('../src/models/Playlist');

test('a minimal playlist is valid and defaults sensibly', () => {
  const p = new Playlist({ name: 'ENT revision' });
  assert.equal(p.validateSync(), undefined);
  assert.equal(p.is_published, false);
  assert.equal(p.is_active, true);
  assert.equal(p.is_free, false);
  assert.deepEqual(p.allowed_plans.toObject ? p.allowed_plans.toObject() : [...p.allowed_plans], []);
  assert.deepEqual([...p.subject_ids], []);
  assert.deepEqual([...p.items], []);
});

test('a playlist requires a name', () => {
  assert.ok(new Playlist({}).validateSync()?.errors?.name);
});

test('a playlist may span several subjects', () => {
  const a = new mongoose.Types.ObjectId();
  const b = new mongoose.Types.ObjectId();
  const p = new Playlist({ name: 'Final year crash course', subject_ids: [a, b] });
  assert.equal(p.validateSync(), undefined);
  assert.equal(p.subject_ids.length, 2);
});

test('an item requires a lecture_id', () => {
  const p = new Playlist({ name: 'X', items: [{ order: 1 }] });
  assert.ok(p.validateSync());
});
```

- [ ] **Step 2: Run it; confirm it fails** — `npm test 2>&1 | grep -A5 playlistModel` → module not found.

- [ ] **Step 3: Implement**

```js
const mongoose = require('mongoose');

const playlistItemSchema = new mongoose.Schema(
  { lecture_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Video', required: true },
    order: { type: Number, default: 0 } },
  { _id: true }
);

const playlistSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    description: { type: String, default: '' },
    // Optional browse tags; a playlist may legitimately span subjects.
    subject_ids: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Subject' }], default: [] },
    allowed_plans: { type: [String], default: [] },   // empty = all plans
    is_free: { type: Boolean, default: false },
    is_published: { type: Boolean, default: false },
    is_active: { type: Boolean, default: true },
    items: { type: [playlistItemSchema], default: [] },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updated_by_at: { type: Date },
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

playlistSchema.index({ is_published: 1, is_active: 1 });
playlistSchema.index({ subject_ids: 1 });
playlistSchema.index({ 'items.lecture_id': 1 });

module.exports = mongoose.model('Playlist', playlistSchema);
```

- [ ] **Step 4: Run; confirm green.**
- [ ] **Step 5: Commit** — `git add src/models/Playlist.js test/playlistModel.test.js && git commit -m "feat(playlist): add the Playlist model"`

---

### Task 2: Entitlement and ordering helpers (pure)

**Files:** Create `src/utils/playlistAccess.js`; Test `test/playlistAccess.test.js`

**Interfaces:** Produces
- `canAccessPlaylist(playlist, planName)` → boolean
- `visibleItems(playlist, lecturesById)` → ordered array of active lectures
- `isLecturePlayable(lecture, playlists, planName)` → boolean

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { canAccessPlaylist, visibleItems, isLecturePlayable } = require('../src/utils/playlistAccess');

test('is_free wins over allowed_plans', () => {
  assert.equal(canAccessPlaylist({ is_free: true, allowed_plans: ['gold'] }, 'free'), true);
});

test('empty allowed_plans means every plan', () => {
  assert.equal(canAccessPlaylist({ allowed_plans: [] }, 'free'), true);
});

test('a listed plan is allowed and an unlisted one is not', () => {
  assert.equal(canAccessPlaylist({ allowed_plans: ['gold'] }, 'gold'), true);
  assert.equal(canAccessPlaylist({ allowed_plans: ['gold'] }, 'free'), false);
});

// Review Focus #4 — intended, pinned so tightening it is deliberate.
test('a lecture in a free playlist is playable even if also in a paid one', () => {
  const lecture = { _id: 'L1', is_active: true };
  const playlists = [
    { is_published: true, is_active: true, is_free: false, allowed_plans: ['gold'], items: [{ lecture_id: 'L1' }] },
    { is_published: true, is_active: true, is_free: true, allowed_plans: [], items: [{ lecture_id: 'L1' }] },
  ];
  assert.equal(isLecturePlayable(lecture, playlists, 'free'), true);
});

// Review Focus #1
test('a lecture in no playlist is not playable', () => {
  assert.equal(isLecturePlayable({ _id: 'L1', is_active: true }, [], 'gold'), false);
});

test('an inactive lecture is never playable', () => {
  const playlists = [{ is_published: true, is_active: true, is_free: true, items: [{ lecture_id: 'L1' }] }];
  assert.equal(isLecturePlayable({ _id: 'L1', is_active: false }, playlists, 'free'), false);
});

test('an unpublished or inactive playlist does not grant access', () => {
  const l = { _id: 'L1', is_active: true };
  assert.equal(isLecturePlayable(l, [{ is_published: false, is_active: true, is_free: true, items: [{ lecture_id: 'L1' }] }], 'free'), false);
  assert.equal(isLecturePlayable(l, [{ is_published: true, is_active: false, is_free: true, items: [{ lecture_id: 'L1' }] }], 'free'), false);
});

// Review Focus #2
test('visibleItems drops inactive lectures without touching the playlist', () => {
  const playlist = { items: [{ lecture_id: 'A', order: 0 }, { lecture_id: 'B', order: 1 }] };
  const byId = new Map([['A', { _id: 'A', is_active: true }], ['B', { _id: 'B', is_active: false }]]);
  const out = visibleItems(playlist, byId);
  assert.deepEqual(out.map((l) => l._id), ['A']);
  assert.equal(playlist.items.length, 2, 'the playlist itself must not be mutated');
});

// Review Focus #5
test('equal order values keep a stable, repeatable sequence', () => {
  const playlist = { items: [{ lecture_id: 'B', order: 0 }, { lecture_id: 'A', order: 0 }] };
  const byId = new Map([['A', { _id: 'A', is_active: true }], ['B', { _id: 'B', is_active: true }]]);
  const first = visibleItems(playlist, byId).map((l) => l._id);
  const second = visibleItems(playlist, byId).map((l) => l._id);
  assert.deepEqual(first, second);
  assert.deepEqual(first, ['B', 'A'], 'ties fall back to insertion order');
});

test('a missing lecture is skipped rather than throwing', () => {
  const playlist = { items: [{ lecture_id: 'GONE', order: 0 }] };
  assert.deepEqual(visibleItems(playlist, new Map()), []);
});
```

- [ ] **Step 2: Run; confirm it fails.**

- [ ] **Step 3: Implement**

```js
function canAccessPlaylist(playlist, planName) {
  if (!playlist) return false;
  if (playlist.is_free) return true;
  const allowed = Array.isArray(playlist.allowed_plans) ? playlist.allowed_plans : [];
  if (allowed.length === 0) return true;
  return allowed.includes(planName);
}

// Read-time filter, never a write: a deactivated lecture disappears for
// students while its playlist item — and every VideoProgress row — survives.
// Ties in `order` fall back to the item's position, so the sequence a student
// sees never reshuffles between requests.
function visibleItems(playlist, lecturesById) {
  const items = Array.isArray(playlist?.items) ? playlist.items : [];
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (a.item.order ?? 0) - (b.item.order ?? 0) || a.index - b.index)
    .map(({ item }) => lecturesById.get(String(item.lecture_id)))
    .filter((lecture) => lecture && lecture.is_active !== false);
}

function isLecturePlayable(lecture, playlists, planName) {
  if (!lecture || lecture.is_active === false) return false;
  return (playlists || []).some((playlist) =>
    playlist.is_published &&
    playlist.is_active !== false &&
    canAccessPlaylist(playlist, planName) &&
    (playlist.items || []).some((item) => String(item.lecture_id) === String(lecture._id))
  );
}

module.exports = { canAccessPlaylist, visibleItems, isLecturePlayable };
```

- [ ] **Step 4: Run; confirm green (10 tests).**
- [ ] **Step 5: Commit** — `git commit -m "feat(playlist): add pure entitlement and ordering helpers"`

---

### Task 3: Admin playlist CRUD

**Files:** Create `src/controllers/playlistsController.js`, `src/routes/playlistsRoutes.js`; Modify `src/server.js` (mount); Test `test/playlistsController.test.js`

**Interfaces:** Produces `GET/POST /playlists`, `PATCH/DELETE /playlists/:id`, `POST /playlists/:id/items`, `PATCH /playlists/:id/items` (reorder). Auth: `authorize.any('CanAddVideos','CanEditVideos')` for writes, `authorize.any('CanViewVideos','CanAddVideos')` for the staff read. Mount with `validateObjectIdParams(router, ['id'])`.

- [ ] **Step 1: Write the failing test** — target the pure request-shaping helpers, not the DB:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPlaylistPayload, normaliseItems } = require('../src/controllers/playlistsController');

test('payload keeps only the fields a client may set', () => {
  const out = buildPlaylistPayload({ name: 'X', description: 'd', subject_ids: ['s1'], allowed_plans: ['gold'], is_free: true, is_published: true, created_by: 'HACK', items: [] });
  assert.deepEqual(Object.keys(out).sort(), ['allowed_plans', 'description', 'is_free', 'is_published', 'name', 'subject_ids']);
});

test('allowed_plans is trimmed and de-duplicated', () => {
  assert.deepEqual(buildPlaylistPayload({ name: 'X', allowed_plans: [' gold ', 'gold', ''] }).allowed_plans, ['gold']);
});

test('items are renumbered contiguously from zero, preserving given order', () => {
  assert.deepEqual(
    normaliseItems([{ lecture_id: 'B' }, { lecture_id: 'A' }, { lecture_id: 'C' }]),
    [{ lecture_id: 'B', order: 0 }, { lecture_id: 'A', order: 1 }, { lecture_id: 'C', order: 2 }]
  );
});

test('duplicate lectures are collapsed, keeping the first position', () => {
  assert.deepEqual(
    normaliseItems([{ lecture_id: 'A' }, { lecture_id: 'B' }, { lecture_id: 'A' }]),
    [{ lecture_id: 'A', order: 0 }, { lecture_id: 'B', order: 1 }]
  );
});

test('malformed items are dropped rather than stored', () => {
  assert.deepEqual(normaliseItems([{ lecture_id: '' }, null, 'x', { order: 3 }]), []);
});
```

- [ ] **Step 2: Run; confirm it fails.**
- [ ] **Step 3: Implement the controller and routes.** `buildPlaylistPayload` uses an allowlist so `created_by`/`updated_by` cannot be spoofed via `req.body`, mirroring `UPDATABLE_VIDEO_FIELDS`. Writes set `updated_by`/`updated_by_at` as a pair, matching the lecture convention. `normaliseItems` renumbers contiguously so reordering never leaves gaps or ties.
- [ ] **Step 4: Run; confirm green, and `test/rbacCoverage.test.js` still passes** (the new routes must each declare exactly one marker).
- [ ] **Step 5: Commit** — `git commit -m "feat(playlist): add admin CRUD for playlists"`

---

### Task 4: Student playlist reads

**Files:** Modify `src/controllers/playlistsController.js`, `src/routes/playlistsRoutes.js`; Test extend

**Interfaces:** Produces `GET /playlists/browse` (published + active + entitled, optional `subject_id` filter) and `GET /playlists/:id` for students, returning lectures via `visibleItems`.

- [ ] **Step 1: Write the failing test** — a pure `browseFilter(planName, subjectId)` helper:

```js
const { browseFilter } = require('../src/controllers/playlistsController');

test('browse filter always constrains to published and active', () => {
  const f = browseFilter(null);
  assert.equal(f.is_published, true);
  assert.deepEqual(f.is_active, { $ne: false });
});

test('a subject filter narrows by subject_ids', () => {
  assert.deepEqual(browseFilter('s1').subject_ids, 's1');
});

test('no subject filter leaves subject_ids unconstrained', () => {
  assert.ok(!('subject_ids' in browseFilter(null)));
});
```

- [ ] **Step 2-4:** implement, run, confirm green. Entitlement is applied in code via `canAccessPlaylist` after the query — not in the filter — because `is_free` and an empty `allowed_plans` both mean "everyone" and expressing that in Mongo is error-prone. **Review Focus #2:** a deactivated lecture must be absent from `GET /playlists/:id` while its `VideoProgress` row is untouched; assert both.
- [ ] **Step 5: Commit** — `git commit -m "feat(playlist): add entitled student browsing and detail reads"`

---

### Task 5: Playback entitlement via playlists

**Files:** Modify `src/controllers/videosController.js` (`loadVideoForUser`, `playbackResponse` call path); Test `test/videoPlayback.test.js` extend

**Interfaces:** Consumes `isLecturePlayable`. `GET /videos/:id/playback` resolves entitlement through playlists instead of `canAccessVideo`. Token minting is unchanged.

- [ ] **Step 1: Write the failing test** — Review Focus #1: a lecture in no playlist returns a clean refusal, never a thrown error and never a token.
- [ ] **Step 2-4:** implement, run, confirm green. Load the candidate playlists with one query (`{ 'items.lecture_id': lectureId, is_published: true, is_active: { $ne: false } }`) — never one query per playlist. Keep `canAccessVideo` in place but unused by this path until Task 8 removes it, so the change is revertible.
- [ ] **Step 5: Commit** — `git commit -m "feat(playlist): gate playback on playlist entitlement"`

---

### Task 6: "Also in" endpoint

**Files:** Modify `src/controllers/playlistsController.js`, routes; Test extend

**Interfaces:** Produces `GET /lectures/:id/playlists` → published, active playlists containing the lecture **that the student can access**, as `{ _id, name }` only.

- [ ] **Step 1: Write the failing test** — Review Focus #3: a playlist the student cannot access must not appear; assert on a mixed set.
- [ ] **Step 2-4:** implement, run, confirm green. Resolve lazily — this must not add a query to the main playlist read.
- [ ] **Step 5: Commit** — `git commit -m "feat(playlist): list other playlists containing a lecture"`

---

### Task 7: Migration script (write only — do not execute)

**Files:** Create `src/scripts/migrate-videos-to-playlists.js`, `src/utils/playlistMigration.js`; Test `test/playlistMigration.test.js`

**Interfaces:** Produces `planPlaylistsFromVideos(videos)` → `{ playlists: [...], unmigrated: [...] }`. Pure — the migration's judgement is testable without a database.

- [ ] **Step 1: Write the failing test**

```js
test('one playlist per subject, from published videos only', () => { /* … */ });

test('plans are UNIONED across member lectures, never intersected', () => {
  const out = planPlaylistsFromVideos([
    { _id: 'a', subject_id: 's1', is_published: true, allowed_plans: ['gold'], order: 0 },
    { _id: 'b', subject_id: 's1', is_published: true, allowed_plans: ['silver'], order: 1 },
  ]);
  assert.deepEqual(out.playlists[0].allowed_plans.sort(), ['gold', 'silver']);
});

test('a video marked is_free makes its playlist free', () => { /* … */ });

test('items are ordered by order then created_date', () => { /* … */ });

test('unpublished videos join no playlist and are reported', () => { /* … */ });
```

The union is deliberate: it never removes access a student already had. Narrowing is an editorial act, not a migration side effect.

- [ ] **Step 2-4:** implement, run, confirm green.
- [ ] **Step 5: Dry-run only** — `node src/scripts/migrate-videos-to-playlists.js --dry-run`, printing what *would* be created. **Do not execute the write.** Executing is the operator's decision (spec §6, and this plan's Global Constraints).
- [ ] **Step 6: Commit** — `git commit -m "feat(playlist): add a videos-to-playlists migration with a pure planner"`

---

### Task 8: Narrow the lecture model — **BLOCKED on the operator running Task 7**

Do not start until the migration has run against the real database and every previously-published video is represented in a playlist. This is the irreversible step.

**Files:** Modify `src/models/Video.js`, `src/controllers/videosController.js`

- [ ] **Step 1:** Confirm the migration ran and reconciles — every video that was `is_published` appears in exactly one playlist.
- [ ] **Step 2:** Remove `allowed_plans`, `is_free`, `is_published`, `order` from the schema and from `UPDATABLE_VIDEO_FIELDS`; delete `canAccessVideo` and its now-dead call sites.
- [ ] **Step 3:** Run the full suite; update any test that asserted the old fields, naming each in the commit message.
- [ ] **Step 4: Commit** — `git commit -m "feat(playlist): retire per-video entitlement in favour of playlists"`

---

### Task 9: Lecture Library — drop entitlement controls

**Files:** Modify `frontend/soulmed/src/pages/AdminLectures.jsx`, `src/api/lecturesClient.js`

- [ ] Remove the Plans field and the Published toggle and their column(s); the publish gate logic goes with them. Upload, status, refresh, edit and deactivate stay.
- [ ] Verify: `npx eslint`, `npm run build`.
- [ ] Commit — `git commit -m "feat(admin): lecture library no longer decides entitlement"`

---

### Task 10: Video Management becomes playlist management

**Files:** Modify `frontend/soulmed/src/pages/AdminVideos.jsx`; Create `src/api/playlistsClient.js`

The largest frontend task. Build it as: a playlist list (name, subjects, plans, item count, published, last modified, Actions first to match the current layout); a create/edit dialog with name, description, subject tags (multi-select), plans, publish toggle; an item editor that searches Lecture Library, adds lectures, supports paste-a-YouTube-URL (creating a lecture via `POST /videos` then adding it), reorders, and shows deactivated members struck through.

- [ ] Verify: `npx eslint`, `npm run build`. State plainly in the report that it was not exercised in a browser.
- [ ] Commit — `git commit -m "feat(admin): turn video management into playlist curation"`

---

### Task 11: Student playlist browsing

**Files:** Modify `frontend/soulmed/src/pages/Videos.jsx`

Browse published playlists (optionally filtered by subject), open one, play its lectures in order. The existing player — hls.js with the Bunny auth loader, the `Hls.isSupported()` branch order, progress tracking and the AI chat panel — must be preserved exactly; only what wraps it changes.

**This is the riskiest task in the plan.** Prototype the navigation against a real browser before building it fully; four defects survived a full suite and a dozen reviews on the Bunny work because everything was verified against assumptions rather than a running client.

- [ ] Verify: `npx eslint`, `npm run build`, and confirm by reading that `selectedVideoIdRef`, the `isError` chat filter and the hls.js effect are untouched.
- [ ] Commit — `git commit -m "feat(student): browse and play playlists"`

---

### Task 12: "Also in" in the student UI

**Files:** Modify `frontend/soulmed/src/pages/Videos.jsx`, `src/api/videosClient.js`

- [ ] Show other accessible playlists containing the current lecture, fetched lazily when the lecture view opens. Secondary placement — it must not compete with the playlist the student is in.
- [ ] Verify: `npx eslint`, `npm run build`.
- [ ] Commit — `git commit -m "feat(student): show other playlists containing a lecture"`

---

## Operator actions (not performed by this plan)

1. Run `src/scripts/backfill-video-subject-ids.js` against the real database.
2. Run `src/scripts/migrate-videos-to-playlists.js` against the real database.
3. Only then, Task 8 (retiring per-video entitlement) and the subject plan's Task 5 (dropping the `subject` string).

Each is a production data change and is deliberately left to a human.
