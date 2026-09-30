# Subject Reference for Lectures — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `Video.subject` (a plain string) with `subject_id`, a real reference to the existing `Subject` collection, so renaming a subject can no longer orphan a lecture or break student access.

**Architecture:** `Subject` already exists with unique `name` and `slug` and 21 production rows; `src/utils/subjects.js` already resolves a name to a subject by slug. This plan adds `subject_id` to `Video`, backfills it from the existing strings, switches reads and writes to the reference, and keeps a denormalised `subject_name` on API responses so no client has to resolve ids for display. The string column is dropped only after the backfill is verified.

**Tech Stack:** Node 22 + Express 5 (CommonJS), Mongoose 9, `node:test` + `node:assert/strict`; React 18 + Vite on the frontend.

**Spec:** `docs/superpowers/specs/2026-09-22-lecture-library-and-playlists-design.md` (§2.3, §4, §6)

## Global Constraints

- Backend is **CommonJS** (`require`/`module.exports`). No ESM.
- Tests run with `npm test` → `node --test "test/**/*.test.js"`, using `node:test` + `node:assert/strict`, matching `test/grading.test.js`. The suite is **541/541 green and pristine** and must stay so.
- **Scope is lectures only.** `Doubt`, `Feedback`, `LiveClass`, `Question`, tests, classes and the AI ingestion pipeline keep their `subject` strings. Do not touch them.
- The frontend has **no unit test suite**; verify with `npx eslint <changed files>` and `npm run build`.
- `validateSubjectIfConfigured` and `slugify` in `src/utils/subjects.js` already exist and must be reused, not reimplemented.
- **API responses must keep exposing a human-readable subject name.** Clients display subjects; none of them should have to resolve an id.
- No new dependencies in either repo.
- Preserve each file's existing line endings; do not reformat.

## Review Focus

Failure modes the spec implies that no task's happy path exercises. Each has a test attached to the task that owns it.

1. **A lecture whose subject string matches no Subject row.** Production has zero today, but the migration must report and skip rather than assign a default — a silently mis-filed lecture is worse than an unmigrated one. Covered in Task 2.
2. **Case and whitespace drift.** `"ENT "`, `"ent"` and `"ENT"` must resolve to the same subject via `slugify`, or the backfill splits one subject into three. Covered in Task 2.
3. **Re-running the migration.** It must be idempotent — a second run must not duplicate, re-resolve, or clobber rows already carrying `subject_id`. Covered in Task 2.
4. **A client sending `subject_id` for an inactive or non-existent subject.** Must be rejected, not stored. Covered in Task 3.
5. **Subject filtering on the student list.** `GET /videos?subject=…` is a live query parameter; changing the stored shape must not silently return an empty list. Covered in Task 4.

---

### Task 1: Add `subject_id` to the Video model

Additive only — nothing reads it yet, so this is safe to deploy alone.

**Files:**
- Modify: `src/models/Video.js`
- Test: `test/videoSubjectRef.test.js` (create)

**Interfaces:**
- Produces: `Video.subject_id` — `ObjectId` ref `Subject`, optional at this stage, indexed.

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Video = require('../src/models/Video');

test('a video accepts a subject_id referencing Subject', () => {
  const id = new mongoose.Types.ObjectId();
  const doc = new Video({
    title: 'T', subject: 'ENT', teacher_name: 'Dr A',
    video_url: 'https://y/1', subject_id: id,
  });
  assert.equal(doc.validateSync(), undefined);
  assert.equal(String(doc.subject_id), String(id));
});

test('subject_id is optional while the backfill has not run', () => {
  const doc = new Video({ title: 'T', subject: 'ENT', teacher_name: 'Dr A', video_url: 'https://y/1' });
  assert.equal(doc.validateSync(), undefined);
  assert.equal(doc.subject_id, undefined);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test 2>&1 | grep -A5 videoSubjectRef`
Expected: FAIL — `subject_id` is stripped by Mongoose because it is not in the schema.

- [ ] **Step 3: Add the field**

In `src/models/Video.js`, alongside `subject`:

```js
    // Real reference to Subject. `subject` (the string) remains until the
    // backfill has run and been verified; Task 5 drops it.
    subject_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Subject', index: true },
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npm test 2>&1 | grep -A5 videoSubjectRef` → PASS, and the full suite still green.

- [ ] **Step 5: Commit**

```bash
git add src/models/Video.js test/videoSubjectRef.test.js
git commit -m "feat(video): add subject_id reference alongside the subject string"
```

---

### Task 2: Backfill script

**Files:**
- Create: `src/scripts/backfill-video-subject-ids.js`
- Create: `src/utils/subjectResolution.js`
- Test: `test/subjectResolution.test.js` (create)

**Interfaces:**
- Produces: `resolveSubjectIds(videos, subjects)` → `{ updates: [{_id, subject_id}], unresolved: [{_id, subject}] }`. Pure — takes plain arrays, does no I/O, so the decision logic is testable without a database.

- [ ] **Step 1: Write the failing test**

Create `test/subjectResolution.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveSubjectIds } = require('../src/utils/subjectResolution');

const subjects = [
  { _id: 's1', name: 'ENT', slug: 'ent' },
  { _id: 's2', name: 'Pharmacology', slug: 'pharmacology' },
];

test('resolves a subject string to its subject id', () => {
  const out = resolveSubjectIds([{ _id: 'v1', subject: 'ENT' }], subjects);
  assert.deepEqual(out.updates, [{ _id: 'v1', subject_id: 's1' }]);
  assert.deepEqual(out.unresolved, []);
});

// Review Focus #2: casing and whitespace must not split one subject into three.
test('resolves regardless of case and surrounding whitespace', () => {
  const out = resolveSubjectIds(
    [{ _id: 'a', subject: 'ent' }, { _id: 'b', subject: '  ENT  ' }, { _id: 'c', subject: 'ENT' }],
    subjects
  );
  assert.deepEqual(out.updates.map((u) => u.subject_id), ['s1', 's1', 's1']);
});

// Review Focus #1: an unmatched subject is reported, never defaulted.
test('reports an unmatched subject instead of assigning a default', () => {
  const out = resolveSubjectIds([{ _id: 'v9', subject: 'Astrology' }], subjects);
  assert.deepEqual(out.updates, []);
  assert.deepEqual(out.unresolved, [{ _id: 'v9', subject: 'Astrology' }]);
});

// Review Focus #3: idempotent.
test('skips videos that already carry a subject_id', () => {
  const out = resolveSubjectIds([{ _id: 'v1', subject: 'ENT', subject_id: 's1' }], subjects);
  assert.deepEqual(out.updates, []);
  assert.deepEqual(out.unresolved, []);
});

test('reports a video with no subject string rather than throwing', () => {
  const out = resolveSubjectIds([{ _id: 'v0', subject: '' }], subjects);
  assert.deepEqual(out.updates, []);
  assert.deepEqual(out.unresolved, [{ _id: 'v0', subject: '' }]);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test 2>&1 | grep -A5 subjectResolution` → FAIL, module not found.

- [ ] **Step 3: Write the resolver**

Create `src/utils/subjectResolution.js`:

```js
const { slugify } = require('./subjects');

// Pure: decides which videos get which subject_id, and which cannot be
// resolved at all. Kept free of I/O so the migration's judgement can be
// tested without a database — the part that would otherwise only be
// exercised by running it against production data.
function resolveSubjectIds(videos, subjects) {
  const bySlug = new Map(subjects.map((subject) => [subject.slug, subject]));
  const updates = [];
  const unresolved = [];

  videos.forEach((video) => {
    // Already migrated: never re-resolve or clobber.
    if (video.subject_id) return;
    const subject = bySlug.get(slugify(video.subject));
    if (subject) updates.push({ _id: video._id, subject_id: subject._id });
    else unresolved.push({ _id: video._id, subject: video.subject });
  });

  return { updates, unresolved };
}

module.exports = { resolveSubjectIds };
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npm test 2>&1 | grep -A5 subjectResolution` → PASS (five tests).

- [ ] **Step 5: Write the script around it**

Create `src/scripts/backfill-video-subject-ids.js`, following the shape of the existing scripts in `src/scripts/` (read one first for the connection/teardown convention):

- connect, load all `Subject` rows and all `Video` rows (`_id subject subject_id`, lean)
- call `resolveSubjectIds`
- apply `updates` with one `bulkWrite` of `updateOne` operations — not a write per video
- print a summary: counts of updated, already-migrated and unresolved
- **print every unresolved row's `_id` and subject string**, and exit non-zero if any exist, so the operator cannot miss them
- support `--dry-run` that reports without writing

- [ ] **Step 6: Dry-run against the real database**

Run: `node src/scripts/backfill-video-subject-ids.js --dry-run`
Expected, per the spec's §6 survey: three distinct subjects (`Demo subject`, `ENT`, `Pharmacology`), **zero unresolved**. If anything is unresolved, stop and report it rather than proceeding.

- [ ] **Step 7: Commit**

```bash
git add src/utils/subjectResolution.js src/scripts/backfill-video-subject-ids.js test/subjectResolution.test.js
git commit -m "feat(video): add an idempotent subject_id backfill with a pure resolver"
```

---

### Task 3: Write `subject_id` on create and update

**Files:**
- Modify: `src/controllers/videosController.js` (`createVideo`, `updateVideo`, `UPDATABLE_VIDEO_FIELDS`)
- Modify: `src/utils/subjects.js`
- Test: `test/subjectResolution.test.js` (extend)

**Interfaces:**
- Consumes: `resolveSubjectIds` is not used here; this is the live path.
- Produces: `resolveSubjectForWrite(subjectName)` in `src/utils/subjects.js` → `{ _id, name }` for an active subject, throwing the existing `SUBJECT_INACTIVE` error otherwise. `createVideo` and `updateVideo` store **both** `subject_id` and `subject` until Task 5.

- [ ] **Step 1: Write the failing test**

Append to `test/subjectResolution.test.js` — test the pure decision, not the DB call:

```js
const { subjectWriteFields } = require('../src/utils/subjectResolution');

test('a resolved subject writes both the id and the canonical name', () => {
  assert.deepEqual(
    subjectWriteFields({ _id: 's1', name: 'ENT' }),
    { subject_id: 's1', subject: 'ENT' }
  );
});

// Review Focus #4: an unresolved subject must not be written at all.
test('an unresolved subject yields no write fields', () => {
  assert.deepEqual(subjectWriteFields(null), {});
  assert.deepEqual(subjectWriteFields(undefined), {});
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test 2>&1 | grep -A5 "write fields"` → FAIL, not a function.

- [ ] **Step 3: Implement**

Add to `src/utils/subjectResolution.js`:

```js
// The canonical name is stored alongside the id until the string column is
// dropped, so a rollback needs no data repair.
function subjectWriteFields(subject) {
  if (!subject || !subject._id) return {};
  return { subject_id: subject._id, subject: subject.name };
}
```

Add `resolveSubjectForWrite(name)` to `src/utils/subjects.js`, built on the existing `validateSubjectIfConfigured` logic but returning the whole subject document rather than just its name. Reuse the slug lookup already there; do not duplicate it.

In `createVideo` and `updateVideo`, replace the `validateSubjectIfConfigured` call with `resolveSubjectForWrite` and spread `subjectWriteFields(...)` into the document. Add `subject_id` to `UPDATABLE_VIDEO_FIELDS` **only if** the update path needs it; prefer setting it from the resolved subject rather than trusting `req.body`, so a client cannot write an arbitrary id.

- [ ] **Step 4: Run and confirm green**

Run: `npm test` → all green, including the existing video tests.

- [ ] **Step 5: Commit**

```bash
git add src/utils/subjects.js src/utils/subjectResolution.js src/controllers/videosController.js test/subjectResolution.test.js
git commit -m "feat(video): resolve and store subject_id on create and update"
```

---

### Task 4: Read by `subject_id`, keep returning a name

**Files:**
- Modify: `src/controllers/videosController.js` (`listVideos`)
- Test: `test/subjectResolution.test.js` (extend)

**Interfaces:**
- Produces: `GET /videos?subject=<name>` continues to work, resolving the name to an id and filtering on `subject_id`. Every returned video carries `subject` (the display name) exactly as before — no client change is required by this task.

- [ ] **Step 1: Write the failing test**

```js
const { buildSubjectFilter } = require('../src/utils/subjectResolution');

// Review Focus #5: a filter that silently matches nothing is worse than an error.
test('subject filter uses subject_id when the subject resolves', () => {
  assert.deepEqual(buildSubjectFilter({ _id: 's1', name: 'ENT' }), { subject_id: 's1' });
});

test('an unresolvable subject filter matches nothing explicitly, not everything', () => {
  assert.deepEqual(buildSubjectFilter(null), { _id: null });
});
```

- [ ] **Step 2: Run and confirm it fails**

- [ ] **Step 3: Implement**

```js
// An unresolvable subject must match NOTHING. Returning {} would drop the
// filter and silently show a student every lecture in the library.
function buildSubjectFilter(subject) {
  return subject && subject._id ? { subject_id: subject._id } : { _id: null };
}
```

Wire it into `listVideos`: when `req.query.subject` is present, resolve it and apply `buildSubjectFilter`. The rest of the filter and both response paths are unchanged.

- [ ] **Step 4: Run and confirm green**

- [ ] **Step 5: Manual check against the real database**

Run the server and request `GET /videos?all=true&subject=ENT` with a staff token. Confirm it returns the same rows as before the change. This is the one behaviour a passing unit test cannot confirm, because the filter's correctness depends on the backfill having run.

- [ ] **Step 6: Commit**

```bash
git add src/controllers/videosController.js src/utils/subjectResolution.js test/subjectResolution.test.js
git commit -m "feat(video): filter lectures by subject_id while still returning subject names"
```

---

### Task 5: Make `subject_id` required and retire the string

**Do not start this task until the backfill has been run against production and reported zero unresolved rows.** It is the irreversible step.

**Files:**
- Modify: `src/models/Video.js`
- Modify: `src/controllers/videosController.js`
- Test: `test/videoSubjectRef.test.js` (extend)

- [ ] **Step 1: Confirm the backfill is complete**

Run: `node src/scripts/backfill-video-subject-ids.js --dry-run`
Expected: zero rows needing update, zero unresolved. If either is non-zero, stop.

- [ ] **Step 2: Write the failing test**

```js
test('a video without subject_id is now invalid', () => {
  const doc = new Video({ title: 'T', teacher_name: 'Dr A', video_url: 'https://y/1' });
  const err = doc.validateSync();
  assert.ok(err && err.errors.subject_id, 'subject_id should be required');
});
```

- [ ] **Step 3: Run and confirm it fails**

- [ ] **Step 4: Implement**

Make `subject_id` `required: true`. Remove the `subject` string field from the schema and from `UPDATABLE_VIDEO_FIELDS`. Keep returning a `subject` **name** on API responses — derive it from the referenced subject rather than a stored column, so clients are unaffected.

Update the two `test/videoSubjectRef.test.js` cases from Task 1 that construct a video with only `subject`, and say in the commit message which ones changed and why.

- [ ] **Step 5: Run and confirm green**

Run: `npm test` → all green.

- [ ] **Step 6: Commit**

```bash
git add src/models/Video.js src/controllers/videosController.js test/videoSubjectRef.test.js
git commit -m "feat(video): require subject_id and retire the subject string column"
```

---

## Deferred

**Frontend** needs no change in this plan: `subject` continues to be sent and received as a display name throughout. If a later plan moves clients onto ids, that is a separate piece of work with its own review.

**The other models** — `Doubt`, `Feedback`, `LiveClass`, `Question` and the tests/classes/AI-ingestion paths — keep their `subject` strings, per spec §2.3. Converting them is a platform-wide project of its own and deliberately out of scope here.
