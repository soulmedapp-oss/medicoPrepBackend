# Watch Tabs, Plan Features, Class Audit Columns — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tabs under the student player (Discussion | AI Tutor | AI Summary | Transcript), the AI/Transcript features gated per plan with the existing lock + upgrade dialog, and "Scheduled by / Last modified" on Manage Live Class.

**Architecture:** `SubscriptionPlan.features[]` + a pure `featureLock(feature, viewer)` in `src/utils/entitlement.js`; the three video endpoints refuse with the uniform `UPGRADE_REQUIRED` body; `/auth/me` ships `feature_locks` so the client renders locked tabs with no extra call. `LiveClass` gains actor fields stamped by the controller, resolved to names by a shared `attachActorNames`. Frontend: `WatchLecture` tab strip, `TranscriptPanel`, Plans **Features** checkboxes, two table columns.

**Tech Stack:** Node 22 / Express 5 / Mongoose 9 / node:test (stubbed models) — React 18 / Vite / TanStack Query v5 / shadcn / lucide.

**Spec:** `docs/superpowers/specs/2026-09-30-watch-tabs-plan-features-design.md` (backend repo).

**Repos:** backend `C:\SoulMedAi\myBranch\backend\medicoPrepBackend` (feature/dkrSeptAPI, `npm test` must stay green — 800/800 now); frontend `C:\SoulMedAi\myBranch\frontend\soulmed` (feature/dkrSept, `npx eslint src` 0 errors — 34 warnings baseline — and `npm run build`).

## Global Constraints

- `PLAN_FEATURES = ['ai_tutor', 'ai_summary', 'transcript']`; labels `AI Tutor`, `AI Summary`, `Transcript`.
- Lock object `{ required_plan, required_label, required_tier }` | null; refusal `{ error:'Upgrade required', code:'UPGRADE_REQUIRED', lock }` via `upgradeRefusal`.
- Feature lock names the lowest-tier ACTIVE plan listing the feature; none → `{ required_plan:'', required_label:'a paid plan', required_tier:1 }`.
- Staff bypass `can(user,'CanViewVideos')` on the video endpoints; `feature_locks` are all `null` for staff.
- `transcript_text` never joins `STUDENT_LECTURE_FIELDS`; only `GET /videos/:id/transcript` returns it, after the playback gate.
- Every route keeps exactly one access marker; new route pinned in `test/rbacRoutesMedia.test.js`.
- Seeds: free `['transcript']`, basic `['transcript','ai_summary']`, premium/ultimate all three; `ensurePlanFeatures()` idempotent (only plans with no `features` field).
- Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; never push.

## Review Focus

1. A student whose plan has `features` undefined (pre-deploy plan the seed did not recognise by name) must see locks, never a crash — pinned in Task 1 (`featureLock` with a plan lacking `features`).
2. The transcript endpoint must not leak for a lecture the student cannot play — pinned in Task 2 (gate refused → transcript never read).
3. A locked tab must never fire its request — pinned by design in Task 3 (queries `enabled` on `!lock`), browser checklist.
4. Old live classes with no actor fields render `—`, not "undefined" — pinned in Task 4 (attachActorNames with missing ids).
5. Unticking a feature on a plan must take effect for students within the 60 s cache and on re-login — `invalidateEntitlementPlans` on plan writes (existing), browser checklist.

---

### Task 1: Backend — plan features, `featureLock`, seeds, validation

**Files:**
- Create: `src/utils/planFeatures.js` (`PLAN_FEATURES`, `PLAN_FEATURE_LABELS`, `normalizeFeatures(list) → { ok, value | error }`)
- Modify: `src/models/SubscriptionPlan.js` (`features: { type: [String], default: undefined }` — leave absent when not set so the seed can detect it), `src/utils/planPitch.js` (`validatePlanFields` validates `features` via `normalizeFeatures`), `src/utils/entitlement.js` (`getActivePlans` selects `features`; add `featureLock`, `featureLocksFor`), `src/server.js` (seed defaults on the four default plans; `ensurePlanFeatures()` after `ensurePlanTiers()`)
- Test: `test/planFeatures.test.js` (new), `test/entitlement.test.js` (+3), `test/planPitch.test.js` (+1)

**Interfaces produced:** `featureLock(feature, viewer)`, `featureLocksFor(viewer)`, `PLAN_FEATURES`, `PLAN_FEATURE_LABELS`, `normalizeFeatures`.

- [ ] Tests first:
```js
// test/planFeatures.test.js
const { PLAN_FEATURES, normalizeFeatures } = require('../src/utils/planFeatures');
test('normalizeFeatures: dedupes, keeps catalogue order, rejects unknown keys and non-arrays', () => {
  assert.deepEqual(normalizeFeatures(['transcript', 'ai_tutor', 'transcript']).value, ['ai_tutor', 'transcript']);
  assert.deepEqual(normalizeFeatures([]).value, []);
  assert.match(normalizeFeatures(['downloads']).error, /Unknown feature/);
  assert.equal(normalizeFeatures('ai_tutor').ok, false);
  assert.deepEqual(PLAN_FEATURES, ['ai_tutor', 'ai_summary', 'transcript']);
});
// test/entitlement.test.js
const PLANS_F = [
  { plan_name: 'free', display_name: 'Free', tier: 0, price: 0, is_active: true, features: ['transcript'] },
  { plan_name: 'basic', display_name: 'Basic', tier: 1, price: 199, is_active: true, features: ['transcript', 'ai_summary'] },
  { plan_name: 'premium', display_name: 'Premium', tier: 2, price: 499, is_active: true, features: ['ai_tutor', 'ai_summary', 'transcript'] },
  { plan_name: 'legacy', display_name: 'Legacy', tier: 1, price: 99, is_active: true }, // no features field
];
test('featureLock: included → null; otherwise the cheapest active plan listing it; none → a paid plan tier 1', () => {
  assert.equal(featureLock('transcript', buildViewer({ subscription_plan: 'free' }, PLANS_F)), null);
  assert.deepEqual(featureLock('ai_summary', buildViewer({ subscription_plan: 'free' }, PLANS_F)), { required_plan: 'basic', required_label: 'Basic', required_tier: 1 });
  assert.deepEqual(featureLock('ai_tutor', buildViewer({ subscription_plan: 'basic' }, PLANS_F)), { required_plan: 'premium', required_label: 'Premium', required_tier: 2 });
  assert.deepEqual(featureLock('ai_tutor', buildViewer({ subscription_plan: 'legacy' }, PLANS_F)).required_plan, 'premium', 'a plan with no features field includes nothing');
  assert.deepEqual(featureLock('ai_tutor', buildViewer({ subscription_plan: 'free' }, PLANS_F.filter((p) => p.plan_name !== 'premium'))), { required_plan: '', required_label: 'a paid plan', required_tier: 1 });
  assert.equal(featureLock('bogus', buildViewer({ subscription_plan: 'premium' }, PLANS_F)).required_label, 'a paid plan', 'unknown feature is never open');
});
test('featureLocksFor: one entry per catalogue feature', () => {
  const locks = featureLocksFor(buildViewer({ subscription_plan: 'basic' }, PLANS_F));
  assert.deepEqual(Object.keys(locks).sort(), ['ai_summary', 'ai_tutor', 'transcript']);
  assert.equal(locks.ai_summary, null); assert.equal(locks.ai_tutor.required_plan, 'premium');
});
```
- [ ] Implement `planFeatures.js`; `featureLock`: `const own = viewer.plansByName.get(viewer.planName); if (own?.features?.includes(feature)) return null; const candidates = [...viewer.plansByName.values()].filter(p => Array.isArray(p.features) && p.features.includes(feature)).sort((a,b) => tierOf(a) - tierOf(b)); if (!candidates.length) return { required_plan:'', required_label:'a paid plan', required_tier:1 }; return { required_plan: normalizePlanName(c.plan_name), required_label: c.display_name || c.plan_name, required_tier: tierOf(c) }` (note: `tierOf` applies the paid-at-tier-0 floor). `featureLocksFor` maps `PLAN_FEATURES`. `getActivePlans` select adds `features` (pin it in the existing price-projection test by extending the regex).
- [ ] `validatePlanFields`: when `features` is present → `normalizeFeatures`; 400 on error. Seeds + `ensurePlanFeatures()` (`updateOne({ plan_name, features: { $exists: false } }, { $set: { features } })` per default name).
- [ ] `npm test` green; commit `feat(plans): per-plan features with featureLock`.

### Task 2: Backend — gate the video endpoints, transcript route, `feature_locks` on auth payloads

**Files:**
- Modify: `src/controllers/videosController.js` (`getVideoSummary`, `chatAboutVideo`; new `getVideoTranscript`), `src/routes/videosRoutes.js` (new route), `src/controllers/authController.js` (`withFeatureLocks(user)` applied in `getMe`, login/`issueSession`, refresh responses — wherever `{ user: sanitizeUser(user) }` is returned to the browser)
- Test: `test/videoFeatures.test.js` (new), `test/rbacRoutesMedia.test.js` (+1 pin), auth test file that covers `getMe` (+1)

**Interfaces:** `GET /videos/:id/transcript → { transcript }`; `/auth/me` → `user.feature_locks`.

- [ ] Tests: for each of ai-summary / ai-chat / transcript: student on `free` (no feature) → 403 uniform body and the AI/transcript work is never invoked (stub `requestVideoSummary`/`requestVideoChat` via the existing injection pattern; for transcript assert `Video.findById(...).select` is not called with `transcript_text` after refusal); student on `premium` → 200; staff (`CanViewVideos`) → 200 regardless of plan; transcript for an unplayable lecture → the playback gate's own 404/403 and the transcript never read. `getMe` test: `feature_locks` present with three keys; staff → all null.
- [ ] Implement: after `loadVideoForPlayback` succeeds, `if (!can(req.user,'CanViewVideos')) { const lock = featureLock('ai_summary', await viewerFor(req.user)); if (lock) return res.status(403).json(upgradeRefusal(lock)); }` (same for `ai_tutor`, `transcript`). `getVideoTranscript`: `Video.findById(id).select('transcript_text').lean()` only after the gate → `{ transcript: doc?.transcript_text || '' }`. Route: `router.get('/videos/:id/transcript', authMiddleware, authorize.any('CanAccessVideos','CanViewVideos'), controller.getVideoTranscript)`; pin it.
- [ ] `withFeatureLocks(user)`: staff (`can(user,'CanViewVideos')`) → all null; else `featureLocksFor(await viewerFor(user))`; attach as `feature_locks` on the sanitized user in `getMe`, login, refresh.
- [ ] `npm test` green; commit `feat(videos): plan-gated AI summary/tutor and transcript; feature_locks on auth payloads`.

### Task 3: Backend — live class actor fields

**Files:**
- Create: `src/utils/actorNames.js` (move `attachActorNames` out of videosController; videosController imports it)
- Modify: `src/models/LiveClass.js` (`created_by`, `updated_by`, `updated_by_at`), `src/controllers/classesController.js` (stamp on create/update/delete/publish paths; staff `listClasses` resolves names with one `User.find({_id:{$in}}).select('full_name')`)
- Test: `test/classesActors.test.js` (new); existing videos tests keep passing after the move.

- [ ] Tests: create stamps `created_by`/`updated_by`/`updated_by_at` = req.user; update stamps `updated_by`/`updated_by_at` and leaves `created_by`; staff list carries `created_by_name`/`updated_by_name` (null for missing users, never throws); student list does NOT carry the ids or names (sanitizer strips `created_by`, `updated_by`, `updated_by_at` — add them to `STUDENT_HIDDEN_CLASS_FIELDS`).
- [ ] Implement; `npm test`; commit `feat(classes): record who scheduled and last modified a live class`.

### Task 4: Frontend — watch tabs, transcript, locked features, Plans checkboxes, class columns

**Files:**
- Modify: `src/components/videos/WatchLecture.jsx` (tab strip under the player: Discussion | AI Tutor | AI Summary | Transcript, + Lectures below `xl`; rail = lectures only), `src/pages/Videos.jsx` (pass `featureLocks` from `useAuth().user?.feature_locks || {}`; summary cache stays)
- Create: `src/components/videos/TranscriptPanel.jsx` (`parseTranscript(text) → { cues:[{start, text}] } | { paragraphs:[…] }` pure, handles WebVTT and SRT timestamps `hh:mm:ss.mmm` / `hh:mm:ss,mmm`; search box; click cue → `videoRef.current.currentTime = start`), `src/components/videos/LockedFeaturePanel.jsx` (`{ feature, label, lock }` → lock icon, "{label} is included in {lock.required_label}", View plans → `promptUpgrade(lock)`)
- Modify: `src/api/videosClient.js` (`getTranscript(id)`), `src/lib/AuthContext.jsx` (nothing if the user object is passed through whole — verify `feature_locks` survives `normalizeUser`/`sanitize` on the client), `src/pages/AdminSubscriptionPlans.jsx` (+ **Features** checkbox block, `features` in formData/edit seeding/save; `src/lib/planFeatures.js` mirrors the catalogue with labels + hints), `src/pages/AdminClasses.jsx` (two columns after Published, `formatLastModifiedAt` copied from AdminLectures or moved to `src/lib/format.js`)

- [ ] Tabs: `Tabs` value state per lecture; a locked tab trigger shows `<LockBadge lock size="sm">` after its label; selecting it renders `LockedFeaturePanel`; the AI Tutor chat, summary query (`enabled: tab==='summary' && !locks.ai_summary`), transcript query (`enabled: tab==='transcript' && !locks.transcript`) never run when locked. Summary tab: existing cache via `onSummary`. Discussion count in the tab label is optional (DiscussionPanel owns its header — leave the header inside the panel).
- [ ] Transcript: `parseTranscript` unit-testable pure function (no test runner in the repo — keep it pure and small); render cues as rows with a mono timestamp button; plain text as `<p>` per blank-line block; search filters rows (cues) or highlights (paragraphs); empty → "No transcript for this lecture yet."
- [ ] Plans page Features block + save; Manage Live Class columns.
- [ ] eslint 0 errors, build; commit `feat(student): watch-page tabs with plan-gated AI tutor/summary/transcript; plan features; class audit columns`.

### Task 5: Docs

- [ ] Runbook: "Plan features (added 2026-09-30)" — `ensurePlanFeatures` seeds by plan name once; Plans page → tick Features per plan; the three features and what a student sees when locked. Commit `docs(ops): plan features rollout`.

## Browser checklist
1. Free student: Transcript tab works (cues clickable), AI Tutor / AI Summary tabs show 🔒 Basic/Premium → locked panel → View plans → dialog.
2. Premium student: all four tabs work; summary loads only when its tab is opened.
3. Admin: Plans → untick AI Summary on Premium → student refreshes → tab locked.
4. Manage Live Class: create/edit a class → Scheduled by / Last modified columns filled; old classes show —.
5. Below 1280 px: tabs include Lectures; rail hidden.
