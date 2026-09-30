# Locked Content with Upgrade Prompt — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plan-locked playlists, tests and live classes stay visible to students with a lock badge; clicking opens an upgrade dialog whose copy each plan carries; one tier-based entitlement rule replaces three inconsistent ones.

**Architecture:** A pure `src/utils/entitlement.js` computes `lockState(item, viewer)` from a `viewer` built once per request from the cached active plans (`tier` per plan). Student list/detail handlers return locked items with a `lock` object instead of dropping them; action handlers refuse with a uniform `UPGRADE_REQUIRED` body. The frontend mounts one `UpgradeDialog` behind a provider; `httpClient` opens it on any `UPGRADE_REQUIRED` 403, pages open it from lock badges. Admins set `tier` and a `pitch` per plan on the Plans page.

**Tech Stack:** Backend Node 22 / Express 5 / Mongoose 9 / node:test with stubbed models. Frontend React 18 / Vite 6 / TanStack Query v5 / shadcn (Radix) / lucide-react / sonner.

**Spec:** `docs/superpowers/specs/2026-09-29-locked-content-upgrade-prompt-design.md` (backend repo). Read it first; it is the authority.

**Repos:** backend `C:\SoulMedAi\myBranch\backend\medicoPrepBackend` (branch `feature/dkrSeptAPI`), frontend `C:\SoulMedAi\myBranch\frontend\soulmed` (branch `feature/dkrSept`). Tests: backend `npm test` (must stay 100 % green); frontend `npx eslint src` (0 errors) and `npm run build`.

## Global Constraints

- Every route declares exactly one access marker (`test/rbacCoverage.test.js`); new routes get an `expectRule` pin in `test/rbacRoutesFinal.test.js`.
- Uniform refusal body when a plan blocks an action: `{ error: 'Upgrade required', code: 'UPGRADE_REQUIRED', lock: { required_plan, required_label, required_tier } }`.
- Lock object shape everywhere: `{ required_plan: string, required_label: string, required_tier: number }`; an unlocked item carries `lock: null`.
- Legacy plan aliases: `medium → premium`, `advance → ultimate` (both when reading a user's plan and a content field).
- Missing/deactivated required plan → `required_tier: 1`, `required_plan: ''`, `required_label: 'a paid plan'`.
- `PITCH_ICONS = ['video', 'notes', 'questions', 'live', 'doubt', 'ai', 'analytics', 'star', 'check']`; headline ≤ 120 chars; ≤ 6 highlights; highlight text ≤ 120 chars.
- Staff bypasses are unchanged: `can(user,'CanViewVideos')` (videos/playlists), `canAny(user,['CanViewTests','CanViewQuestions'])` (tests), `can(user,'CanViewClasses')` (classes).
- Student projections never widen: locked playlist teasers carry only `_id title subtopic duration_seconds thumbnail_url card_thumbnail_url`; locked classes lose `youtube_url` and report `has_join_link:false`, `has_recording:false`.
- Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never push.

## Review Focus

1. A user whose `subscription_plan` names a plan that was deactivated (e.g. an old "advance" subscriber) must be treated as tier 0, not crash and not be granted tier of a wrong plan — pinned in Task 2 (`planTier` unknown → 0, alias → mapped).
2. A playlist whose `allowed_plans` names only a deleted plan must stay locked (never silently open) — pinned in Task 2 (`requiredPlanFor` fallback tier 1).
3. A locked playlist's teaser must not leak `video_url`, `provider` or Bunny ids — pinned in Task 3 (deep-equal on teaser keys).
4. `createAttempt` on a locked test must refuse BEFORE writing an attempt — pinned in Task 4 (assert `TestAttempt.create` not called).
5. The upgrade dialog with no pitch configured (fresh plan) must still render headline + View plans — pinned by the fallback copy in Task 5 and the browser checklist.

---

### Task 1: Plan model — `tier`, `pitch`, validation, seeds, banner upload

**Files:**
- Modify: `src/models/SubscriptionPlan.js`
- Create: `src/utils/planPitch.js`
- Modify: `src/controllers/subscriptionsController.js:51-94` (createPlan / updatePlan)
- Modify: `src/server.js` (seed defaults ~578-675; new `ensurePlanTiers`; new upload route next to `/uploads/playlists` ~897-928)
- Test: `test/planPitch.test.js` (new), `test/rbacRoutesFinal.test.js` (upload route is an `app.post` in server.js → covered by `rbacCoverage`, no pin file change; verify by running the suite)

**Interfaces:**
- Produces: `SubscriptionPlan.tier: Number`, `SubscriptionPlan.pitch: { headline, highlights: [{icon,text}], banner_url }`.
- Produces: `validatePlanFields(body) → { ok: true, value } | { ok: false, error }` in `src/utils/planPitch.js`, exported with `PITCH_ICONS`, `PITCH_MAX_HIGHLIGHTS = 6`, `PITCH_TEXT_MAX = 120`.

- [ ] **Step 1: Failing tests for the validator**

`test/planPitch.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePlanFields, PITCH_ICONS } = require('../src/utils/planPitch');

test('validatePlanFields: passes through a body without tier/pitch untouched', () => {
  const r = validatePlanFields({ display_name: 'Elite', price: 999 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { display_name: 'Elite', price: 999 });
});

test('validatePlanFields: tier must be an integer >= 0', () => {
  assert.equal(validatePlanFields({ tier: -1 }).ok, false);
  assert.equal(validatePlanFields({ tier: 1.5 }).ok, false);
  assert.equal(validatePlanFields({ tier: 'x' }).ok, false);
  const r = validatePlanFields({ tier: '2' });
  assert.equal(r.ok, true);
  assert.equal(r.value.tier, 2, 'numeric strings from a form are coerced');
});

test('validatePlanFields: pitch shape — headline length, <=6 highlights, known icons, trimmed text', () => {
  const good = validatePlanFields({ pitch: {
    headline: '  Everything you need  ',
    highlights: [{ icon: 'video', text: ' 500+ lectures ' }, { icon: 'live', text: 'Weekly live classes' }],
    banner_url: 'https://cdn/x.png',
  } });
  assert.equal(good.ok, true, good.error);
  assert.equal(good.value.pitch.headline, 'Everything you need');
  assert.deepEqual(good.value.pitch.highlights[0], { icon: 'video', text: '500+ lectures' });

  assert.match(validatePlanFields({ pitch: { headline: 'x'.repeat(121) } }).error, /headline/i);
  assert.match(validatePlanFields({ pitch: { highlights: Array.from({ length: 7 }, () => ({ icon: 'star', text: 'a' })) } }).error, /6/);
  assert.match(validatePlanFields({ pitch: { highlights: [{ icon: 'rocket', text: 'a' }] } }).error, /icon/i);
  assert.match(validatePlanFields({ pitch: { highlights: [{ icon: 'star', text: '' }] } }).error, /text/i);
  assert.match(validatePlanFields({ pitch: { highlights: [{ icon: 'star', text: 'x'.repeat(121) }] } }).error, /text/i);
  assert.equal(validatePlanFields({ pitch: 'nope' }).ok, false);
  assert.ok(PITCH_ICONS.includes('check'));
});
```

- [ ] **Step 2: Run** `node --test test/planPitch.test.js` → FAIL (module not found).

- [ ] **Step 3: Implement `src/utils/planPitch.js`**

```js
// The per-plan "upgrade pitch" shown in the student Upgrade dialog, and the
// tier that orders plans for entitlement (spec §4). Pure validation so the
// controller stays a thin pass-through.
const PITCH_ICONS = ['video', 'notes', 'questions', 'live', 'doubt', 'ai', 'analytics', 'star', 'check'];
const PITCH_MAX_HIGHLIGHTS = 6;
const PITCH_TEXT_MAX = 120;

function validatePlanFields(body) {
  const value = { ...(body || {}) };
  if (Object.prototype.hasOwnProperty.call(value, 'tier')) {
    const tier = Number(value.tier);
    if (!Number.isInteger(tier) || tier < 0) return { ok: false, error: 'tier must be a whole number of 0 or more' };
    value.tier = tier;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'pitch')) {
    const pitch = value.pitch;
    if (!pitch || typeof pitch !== 'object' || Array.isArray(pitch)) return { ok: false, error: 'pitch must be an object' };
    const headline = String(pitch.headline || '').trim();
    if (headline.length > PITCH_TEXT_MAX) return { ok: false, error: `pitch headline must be ${PITCH_TEXT_MAX} characters or fewer` };
    const rawHighlights = Array.isArray(pitch.highlights) ? pitch.highlights : [];
    if (rawHighlights.length > PITCH_MAX_HIGHLIGHTS) return { ok: false, error: `pitch may have at most ${PITCH_MAX_HIGHLIGHTS} highlights` };
    const highlights = [];
    for (const item of rawHighlights) {
      const icon = String(item?.icon || '');
      const text = String(item?.text || '').trim();
      if (!PITCH_ICONS.includes(icon)) return { ok: false, error: `Unknown highlight icon "${icon}"` };
      if (!text || text.length > PITCH_TEXT_MAX) return { ok: false, error: `Each highlight needs text of 1–${PITCH_TEXT_MAX} characters` };
      highlights.push({ icon, text });
    }
    value.pitch = { headline, highlights, banner_url: String(pitch.banner_url || '').trim() };
  }
  return { ok: true, value };
}

module.exports = { PITCH_ICONS, PITCH_MAX_HIGHLIGHTS, PITCH_TEXT_MAX, validatePlanFields };
```

- [ ] **Step 4: Run the test** → PASS.

- [ ] **Step 5: Schema fields** in `src/models/SubscriptionPlan.js`, after `sort_order`:

```js
    // Entitlement order (spec §4): a student whose plan tier is >= an item's
    // required tier may open it. Free = 0. Set by the admin; backfilled from
    // sort_order once by ensurePlanTiers() in server.js.
    tier: { type: Number, default: 0, min: 0 },
    // Copy for the student Upgrade dialog when this plan is the cheapest way
    // into a locked item.
    pitch: {
      headline: { type: String, default: '' },
      highlights: { type: [{ icon: { type: String }, text: { type: String }, _id: false }], default: [] },
      banner_url: { type: String, default: '' },
    },
```

- [ ] **Step 6: Controller validation.** In `subscriptionsController.js` add `const { validatePlanFields } = require('../utils/planPitch');`. In `createPlan`, after the `plan_name`/`display_name` check:
```js
      const checked = validatePlanFields(data);
      if (!checked.ok) return res.status(400).json({ error: checked.error });
      ...SubscriptionPlan.create(checked.value)
```
In `updatePlan`, replace `const updates = req.body || {};` with:
```js
      const checked = validatePlanFields(req.body || {});
      if (!checked.ok) return res.status(400).json({ error: checked.error });
      const updates = checked.value;
```
Also call `invalidateEntitlementPlans()` (from Task 2's `src/utils/entitlement.js`) next to every `clearPlansCache()` — **Task 2 creates it; in this task add the require line and calls, with `src/utils/entitlement.js` created as a stub exporting `invalidateEntitlementPlans() {}` if Task 2 has not landed yet** (Task 2 replaces the stub).

- [ ] **Step 7: Seeds + backfill in `src/server.js`.** In `ensureDefaultSubscriptionPlans` add to each default plan: free `tier: 0`, basic `tier: 1`, premium `tier: 2`, ultimate `tier: 3`, and a default pitch, e.g. premium:
```js
      pitch: {
        headline: 'Everything in Basic, plus the full lecture library and live classes.',
        highlights: [
          { icon: 'video', text: 'All recorded lectures, organised by subject' },
          { icon: 'live', text: 'Live classes every week with recordings' },
          { icon: 'questions', text: 'Full question bank and mock tests' },
          { icon: 'doubt', text: 'Ask doubts and get a teacher’s answer' },
        ],
        banner_url: '',
      },
```
(free: headline 'Start for free', highlights video/questions; basic: video/questions/check; ultimate: everything + `ai`, `analytics`, `star`.) Add, called right after `ensureDefaultSubscriptionPlans()` at startup:
```js
// One-time, idempotent: plans created before `tier` existed order by sort_order.
async function ensurePlanTiers() {
  await SubscriptionPlan.updateMany(
    { tier: { $exists: false } },
    [{ $set: { tier: { $ifNull: ['$sort_order', 0] } } }]
  );
}
```
Upload route, next to `/uploads/playlists`:
```js
app.post('/uploads/plan-banners', authMiddleware, authorize.any('CanAddSubscriptionPlans', 'CanEditSubscriptionPlans'), upload.single('file'), (req, res) => handleUpload(res, req.file, 'image'));
```

- [ ] **Step 8: Run `npm test`** → all green (rbacCoverage picks up the new route: one marker, known codes).

- [ ] **Step 9: Commit** `feat(plans): tier and upgrade pitch on subscription plans`.

---

### Task 2: Entitlement helper and rewiring of the three access rules

**Files:**
- Create: `src/utils/entitlement.js`
- Modify: `src/utils/playlistAccess.js` (canAccessPlaylist / isLecturePlayable take a viewer)
- Modify: `src/controllers/classesController.js:109-114` (canAccessClass), `src/controllers/testsController.js:24-41,86-96,177-180` (PLAN_RANKS/normalizePlan/getPlanRank/buildQuestionFilter)
- Test: `test/entitlement.test.js` (new), `test/playlistAccess.test.js` (update fixtures to pass a viewer)

**Interfaces:**
- Produces (all in `src/utils/entitlement.js`):
  - `normalizePlanName(name) → string` (lower-cased, aliases mapped, '' for falsy)
  - `buildViewer(user, plans) → { planName, tier, plansByName: Map<name, plan> }`
  - `planTier(planName, plans) → number`
  - `requiredPlanFor(item, plans) → null | { plan_name, display_name, tier }`
  - `lockState(item, viewer) → null | { required_plan, required_label, required_tier }` (null = unlocked)
  - `isEntitled(item, viewer) → boolean` (`lockState(...) === null`)
  - `upgradeRefusal(lock) → { error:'Upgrade required', code:'UPGRADE_REQUIRED', lock }`
  - `getActivePlans() → Promise<plan[]>` (60 s cache), `viewerFor(user) → Promise<viewer>`, `invalidateEntitlementPlans()`
- Produces: `canAccessPlaylist(playlist, viewer)`, `isLecturePlayable(lecture, playlists, viewer)` (playlistAccess.js); `canAccessClass(liveClass, viewer)` (classesController); `buildQuestionFilter(testId, user, viewer)` (testsController) — later tasks pass `viewer`.

- [ ] **Step 1: Failing tests** `test/entitlement.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePlanName, buildViewer, planTier, requiredPlanFor, lockState, isEntitled, upgradeRefusal } = require('../src/utils/entitlement');

const PLANS = [
  { plan_name: 'free', display_name: 'Free', tier: 0, is_active: true },
  { plan_name: 'premium', display_name: 'Premium', tier: 2, is_active: true },
  { plan_name: 'elite', display_name: 'Elite', tier: 3, is_active: true },
  { plan_name: 'basic', display_name: 'Basic', tier: 1, is_active: true },
];
const viewer = (plan) => buildViewer({ subscription_plan: plan }, PLANS);

test('normalizePlanName: lower-cases, maps legacy aliases, empty for nothing', () => {
  assert.equal(normalizePlanName('Premium'), 'premium');
  assert.equal(normalizePlanName('medium'), 'premium');
  assert.equal(normalizePlanName('advance'), 'ultimate');
  assert.equal(normalizePlanName(undefined), '');
});

test('planTier: known plan → its tier; unknown, deactivated or missing → 0; undefined tier → 0', () => {
  assert.equal(planTier('elite', PLANS), 3);
  assert.equal(planTier('gold', PLANS), 0);
  assert.equal(planTier('', PLANS), 0);
  assert.equal(planTier('x', [{ plan_name: 'x', is_active: true }]), 0);
});

test('requiredPlanFor: free/open items → null; otherwise the cheapest named plan; missing plans → tier-1 fallback', () => {
  assert.equal(requiredPlanFor({ is_free: true, allowed_plans: ['elite'] }, PLANS), null);
  assert.equal(requiredPlanFor({ allowed_plans: [] }, PLANS), null);
  assert.equal(requiredPlanFor({ required_plan: 'free' }, PLANS), null);
  assert.deepEqual(requiredPlanFor({ allowed_plans: ['elite', 'premium'] }, PLANS), { plan_name: 'premium', display_name: 'Premium', tier: 2 });
  assert.deepEqual(requiredPlanFor({ required_plan: 'medium' }, PLANS), { plan_name: 'premium', display_name: 'Premium', tier: 2 }, 'alias on content');
  assert.deepEqual(requiredPlanFor({ allowed_plans: ['gold'] }, PLANS), { plan_name: '', display_name: 'a paid plan', tier: 1 }, 'never silently unlock');
});

test('lockState: higher tier includes lower; equal tier entitled; below → lock object', () => {
  const item = { allowed_plans: ['premium'] };
  assert.equal(lockState(item, viewer('elite')), null);
  assert.equal(lockState(item, viewer('premium')), null);
  assert.deepEqual(lockState(item, viewer('basic')), { required_plan: 'premium', required_label: 'Premium', required_tier: 2 });
  assert.deepEqual(lockState(item, viewer('free')), { required_plan: 'premium', required_label: 'Premium', required_tier: 2 });
  assert.equal(isEntitled(item, viewer('free')), false);
  assert.equal(lockState({ is_free: true }, viewer('free')), null);
});

test('lockState: a viewer on a deactivated/unknown plan is tier 0', () => {
  assert.equal(lockState({ allowed_plans: ['basic'] }, viewer('advance')).required_plan, 'basic', 'advance → ultimate, but ultimate is not an active plan here → tier 0');
  assert.equal(lockState({ allowed_plans: ['basic'] }, viewer(undefined)).required_tier, 1);
});

test('upgradeRefusal: the uniform 403 body', () => {
  assert.deepEqual(upgradeRefusal({ required_plan: 'elite', required_label: 'Elite', required_tier: 3 }),
    { error: 'Upgrade required', code: 'UPGRADE_REQUIRED', lock: { required_plan: 'elite', required_label: 'Elite', required_tier: 3 } });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement `src/utils/entitlement.js`**

```js
// One entitlement rule for every plan-gated thing (spec §5). Content keeps
// its own fields — `is_free` + `allowed_plans` (playlists, live classes) or
// `is_free` + `required_plan` (tests) — and this file decides, from the
// plans' admin-set `tier`, whether a viewer may open it and, if not, which
// plan is the cheapest way in.
const SubscriptionPlan = require('../models/SubscriptionPlan');

const ALIASES = { medium: 'premium', advance: 'ultimate' };
const FALLBACK_REQUIRED = Object.freeze({ plan_name: '', display_name: 'a paid plan', tier: 1 });
const PLANS_TTL_MS = 60 * 1000;
let cache = { value: null, expiresAt: 0 };

function normalizePlanName(name) {
  const lower = String(name || '').trim().toLowerCase();
  return ALIASES[lower] || lower;
}

function plansByName(plans) {
  return new Map((plans || []).filter((p) => p && p.is_active !== false).map((p) => [normalizePlanName(p.plan_name), p]));
}

function tierOf(plan) {
  const t = Number(plan?.tier);
  return Number.isFinite(t) && t >= 0 ? t : 0;
}

function planTier(planName, plans) {
  const plan = plansByName(plans).get(normalizePlanName(planName));
  return plan ? tierOf(plan) : 0;
}

function buildViewer(user, plans) {
  const planName = normalizePlanName(user?.subscription_plan);
  return { planName, tier: planTier(planName, plans), plansByName: plansByName(plans) };
}

function namedPlans(item) {
  if (Array.isArray(item?.allowed_plans)) return item.allowed_plans.map(normalizePlanName).filter(Boolean);
  const single = normalizePlanName(item?.required_plan);
  return single && single !== 'free' ? [single] : [];
}

function requiredPlanFor(item, plans) {
  if (!item || item.is_free === true) return null;
  const names = namedPlans(item);
  if (names.length === 0) return null;
  const byName = plans instanceof Map ? plans : plansByName(plans);
  const found = names.map((n) => byName.get(n)).filter(Boolean);
  if (found.length === 0) return { ...FALLBACK_REQUIRED };
  const cheapest = found.reduce((a, b) => (tierOf(b) < tierOf(a) ? b : a));
  return { plan_name: normalizePlanName(cheapest.plan_name), display_name: cheapest.display_name || cheapest.plan_name, tier: tierOf(cheapest) };
}

function lockState(item, viewer) {
  const required = requiredPlanFor(item, viewer?.plansByName || new Map());
  if (!required) return null;
  if ((viewer?.tier || 0) >= required.tier) return null;
  return { required_plan: required.plan_name, required_label: required.display_name, required_tier: required.tier };
}

const isEntitled = (item, viewer) => lockState(item, viewer) === null;

function upgradeRefusal(lock) {
  return { error: 'Upgrade required', code: 'UPGRADE_REQUIRED', lock };
}

async function getActivePlans() {
  if (cache.value && cache.expiresAt > Date.now()) return cache.value;
  const plans = await SubscriptionPlan.find({ is_active: true }).select('plan_name display_name tier is_active').lean();
  cache = { value: plans, expiresAt: Date.now() + PLANS_TTL_MS };
  return plans;
}

function invalidateEntitlementPlans() {
  cache = { value: null, expiresAt: 0 };
}

async function viewerFor(user) {
  return buildViewer(user, await getActivePlans());
}

module.exports = {
  normalizePlanName, buildViewer, planTier, requiredPlanFor, lockState, isEntitled, upgradeRefusal,
  getActivePlans, viewerFor, invalidateEntitlementPlans,
};
```

- [ ] **Step 4: Run** `node --test test/entitlement.test.js` → PASS.

- [ ] **Step 5: Rewire `src/utils/playlistAccess.js`:**
```js
const { isEntitled } = require('./entitlement');
// `viewer` comes from entitlement.viewerFor(req.user) / buildViewer.
function canAccessPlaylist(playlist, viewer) {
  if (!playlist) return false;
  return isEntitled(playlist, viewer);
}
function isLecturePlayable(lecture, playlists, viewer) { /* same body, pass viewer */ }
```
Update `test/playlistAccess.test.js`: build a `viewer` with `buildViewer({ subscription_plan: 'premium' }, PLANS)` fixtures and pass it where a plan name was passed; keep every existing expectation, adjusting any that relied on exact-match (`ultimate` user on a `premium` playlist is now allowed — update that expectation and say why in the test name).

- [ ] **Step 6: Rewire classes and tests helpers.**
`classesController.js:109-114`:
```js
  const { isEntitled } = require('../utils/entitlement'); // top of file
  function canAccessClass(liveClass, viewer) { return isEntitled(liveClass, viewer); }
```
Every caller inside classesController (`listClasses`, `getClassRecording`, `getClassJoinLink`, `getClassSummary`, `chatAboutClass`) builds `const viewer = await viewerFor(req.user);` where it built `planName`, and passes `viewer`. Keep the 403 bodies as they are for now (Task 4 makes them uniform).

`testsController.js`: delete `PLAN_RANKS`, `getPlanRank`; keep `normalizePlan` for CSV import but implement it as `normalizePlanName(value) || 'free'`. `buildQuestionFilter(testId, user, viewer)`:
```js
  if (!canAny(user, ['CanViewTests', 'CanViewQuestions'])) {
    filter.is_active = true;
    // Questions at or below the viewer's tier: those whose required_plan is
    // free/absent, or names an active plan with tier <= viewer.tier.
    const allowedNames = ['free', '', null, undefined, ...[...viewer.plansByName.values()].filter((p) => Number(p.tier || 0) <= viewer.tier).map((p) => p.plan_name)];
    filter.required_plan = { $in: allowedNames };
  }
```
Callers of `buildQuestionFilter` (`listTestQuestions`, the grading path) do `const viewer = await viewerFor(req.user);` first. Note legacy `medium`/`advance` strings stored on old questions: add them to `allowedNames` when their alias target is allowed (`if allowed has 'premium' push 'medium'; if 'ultimate' push 'advance'`).

- [ ] **Step 7: Run `npm test`** → green. Fix any test that constructed `subscription_plan` expectations by exact match (state the new rule in the test name).

- [ ] **Step 8: Commit** `refactor(entitlement): one tier-based rule for playlists, classes and tests`.

---

### Task 3: Playlists and playback return locks instead of hiding

**Files:**
- Modify: `src/controllers/playlistsController.js:418-457` (browsePlaylists), `:466-500` (getPlaylist)
- Modify: `src/controllers/videosController.js:187-199` (resolvePlaybackAccess), `~300-319` (listVideos)
- Modify: `src/utils/studentProjection.js` (add `STUDENT_TEASER_FIELDS`)
- Test: `test/playlistsLocked.test.js` (new; stubbed-model handler tests in the style of `test/rbacMediaControllers.test.js`)

**Interfaces:**
- Consumes: `viewerFor`, `lockState`, `upgradeRefusal` from Task 2.
- Produces: browse rows `studentPlaylistView(...) + { lock }`; detail `{ playlist: view + lock, lectures, locked: boolean }`; playback 403 uniform body.

- [ ] **Step 1: Failing tests** (`test/playlistsLocked.test.js`; copy the `q/mockRes/stub` helpers from `test/rbacMediaControllers.test.js`):

```js
const PLANS = [
  { plan_name: 'free', display_name: 'Free', tier: 0, is_active: true },
  { plan_name: 'elite', display_name: 'Elite', tier: 2, is_active: true },
];
// stub SubscriptionPlan.find → q(PLANS) in every test (getActivePlans), and call invalidateEntitlementPlans() in afterEach.

test('browsePlaylists: a locked playlist is returned with lock, same projection as an open one', async () => {
  const open = { _id: oid(), name: 'Free ENT', is_published: true, is_active: true, is_free: true, items: [], subject_ids: [] };
  const locked = { _id: oid(), name: 'Elite ENT', is_published: true, is_active: true, allowed_plans: ['elite'], items: [{ lecture_id: oid() }], subject_ids: [] };
  stub(Playlist, 'find', () => q([open, locked]));
  stub(Video, 'find', () => q([]));
  const res = mockRes();
  await controller().browsePlaylists({ query: {}, user: { _id: oid(), subscription_plan: 'free', effective_permissions: [] } }, res);
  assert.equal(res.body.playlists.length, 2);
  const row = res.body.playlists.find((p) => p.name === 'Elite ENT');
  assert.deepEqual(row.lock, { required_plan: 'elite', required_label: 'Elite', required_tier: 2 });
  assert.equal(res.body.playlists.find((p) => p.name === 'Free ENT').lock, null);
  assert.deepEqual(Object.keys(row).sort(), ['_id', 'allowed_plans', 'description', 'is_free', 'lecture_count', 'lock', 'name', 'subject_ids', 'thumbnail_url']);
});

test('getPlaylist: locked → teaser lectures without video_url/provider, locked:true; unpublished stays 404', async () => {
  const lectureId = oid();
  const playlist = { _id: oid(), name: 'Elite ENT', is_published: true, is_active: true, allowed_plans: ['elite'], items: [{ lecture_id: lectureId, order: 1 }] };
  stub(Playlist, 'findById', () => q(playlist));
  let selected;
  stub(Video, 'find', () => { const c = q([{ _id: lectureId, title: 'Otitis', subtopic: 'Ear', duration_seconds: 600, thumbnail_url: '', card_thumbnail_url: '', is_active: true, video_url: 'SECRET', provider: 'bunny' }]); const s = c.select; c.select = (f) => { selected = f; return s(f); }; return c; });
  const res = mockRes();
  await controller().getPlaylist({ params: { id: String(playlist._id) }, user: { _id: oid(), subscription_plan: 'free', effective_permissions: [] } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.locked, true);
  assert.equal(res.body.playlist.lock.required_plan, 'elite');
  assert.equal(selected, '_id title subtopic duration_seconds thumbnail_url card_thumbnail_url is_active');
  assert.deepEqual(Object.keys(res.body.lectures[0]).sort(), ['_id', 'card_thumbnail_url', 'duration_seconds', 'subtopic', 'thumbnail_url', 'title']);

  stub(Playlist, 'findById', () => q({ ...playlist, is_published: false }));
  const res2 = mockRes();
  await controller().getPlaylist({ params: { id: String(playlist._id) }, user: { _id: oid(), subscription_plan: 'free', effective_permissions: [] } }, res2);
  assert.equal(res2.statusCode, 404);
});

test('resolvePlaybackAccess: locked lecture → 403 with the uniform UPGRADE_REQUIRED body', () => { /* call the exported pure helper with viewer('free') and a playlist allowed_plans ['elite'] → { allowed:false, status:403, body: upgradeRefusal(lock) } */ });
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.**
`studentProjection.js`: `const STUDENT_TEASER_FIELDS = '_id title subtopic duration_seconds thumbnail_url card_thumbnail_url is_active';` and a `teaserLectureView(lecture)` that returns exactly `{ _id, title, subtopic, duration_seconds, thumbnail_url, card_thumbnail_url }`. Export both.

`browsePlaylists`:
```js
      const viewer = await viewerFor(req.user);
      const entitledOrLocked = playlists; // nothing dropped any more (spec §6)
      ... lecture count query unchanged over ALL playlists ...
      const rows = playlists.map((playlist) => ({
        ...studentPlaylistView(playlist, { lecture_count: countVisibleItems(playlist, activeLectureIds) }),
        lock: lockState(playlist, viewer),
      }));
```
`getPlaylist`:
```js
      if (!playlist.is_published || playlist.is_active === false) return res.status(404).json({ error: 'Playlist not found' });
      const viewer = await viewerFor(req.user);
      const lock = lockState(playlist, viewer);
      const lectureIds = (playlist.items || []).map((item) => item.lecture_id);
      if (lock) {
        // Spec §2: a locked playlist is a teaser, never a 404 — titles only.
        const lectures = lectureIds.length ? await Video.find({ _id: { $in: lectureIds } }).select(STUDENT_TEASER_FIELDS).lean() : [];
        const lecturesById = new Map(lectures.map((l) => [String(l._id), l]));
        return res.json({ playlist: { ...studentPlaylistView(playlist), lock }, lectures: visibleItems(playlist, lecturesById).map(teaserLectureView), locked: true });
      }
      ... existing entitled path, returning { playlist: { ...studentPlaylistView(playlist), lock: null }, lectures: visibleLectures, locked: false }
```
Update the comment block above `getPlaylist` (lines 459-465) — the "must never learn a playlist exists" rule is deliberately reversed by spec §1.

`videosController.resolvePlaybackAccess({ lecture, playlists, viewer, isStaff })`: when not playable, compute the cheapest lock across the playlists that carry the lecture (`playlists.filter(carries).map(p => lockState(p, viewer)).filter(Boolean)` → min `required_tier`; if none carry it → 404 'Video not found' as today) and return `{ allowed: false, status: 403, body: upgradeRefusal(lock) }`; the caller sends `res.status(status).json(body || { error })`. `loadVideoForPlayback` and `listVideos` build `viewer` via `viewerFor(req.user)` instead of `planName`. `listVideos` keeps filtering (it feeds staff/legacy callers; students browse via playlists).

- [ ] **Step 4: Run `npm test`** → green (update `test/rbacMediaControllers.test.js` expectations that asserted the old `{ error: 'Upgrade required' }` body: they now expect the uniform body).

- [ ] **Step 5: Commit** `feat(playlists): locked playlists stay visible with a lock; uniform upgrade refusal on playback`.

---

### Task 4: Tests and live classes — locks in lists, uniform refusals

**Files:**
- Modify: `src/controllers/testsController.js` (`listTests` ~223-244, `createAttempt` ~1207-1236)
- Modify: `src/controllers/classesController.js` (`listClasses` 116-194, `sanitizeClassForStudent` 73-82, four 403 sites 448-451 / 502-505 / 533-536 / 569-572)
- Test: `test/testsLocked.test.js` (new), `test/classesLocked.test.js` (new)

**Interfaces:**
- Consumes: `viewerFor`, `lockState`, `upgradeRefusal`.
- Produces: `GET /tests` rows carry `lock`; `POST /tests/:id/attempts` 403 uniform body; `GET /classes` rows carry `lock` (locked rows: `youtube_url` removed, `has_join_link:false`, `has_recording:false`); class 403s uniform.

- [ ] **Step 1: Failing tests**

`test/testsLocked.test.js`:
```js
test('listTests: every row carries lock; a required_plan the student is below locks it', async () => {
  stub(SubscriptionPlan, 'find', () => q(PLANS));
  stub(Test, 'find', () => q([{ _id: oid(), title: 'Free mock', is_free: true, required_plan: 'free' }, { _id: oid(), title: 'Elite mock', is_free: false, required_plan: 'elite' }]));
  const res = mockRes();
  await controller().listTests({ query: {}, user: { _id: oid(), subscription_plan: 'free', effective_permissions: [] } }, res);
  assert.equal(res.body.tests[0].lock, null);
  assert.deepEqual(res.body.tests[1].lock, { required_plan: 'elite', required_label: 'Elite', required_tier: 2 });
});

test('createAttempt: locked test → 403 UPGRADE_REQUIRED and no attempt written; staff bypass', async () => {
  stub(SubscriptionPlan, 'find', () => q(PLANS));
  stub(Test, 'findById', () => q({ _id: oid(), is_published: true, is_active: true, is_free: false, required_plan: 'elite', total_marks: 10 }));
  let created = false;
  stub(TestAttempt, 'create', async () => { created = true; return { _id: oid() }; });
  const res = mockRes();
  await controller().createAttempt({ params: { id: String(oid()) }, user: { _id: oid(), email: 's@x.com', subscription_plan: 'free', effective_permissions: [] } }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'UPGRADE_REQUIRED');
  assert.equal(res.body.lock.required_plan, 'elite');
  assert.equal(created, false, 'refuse before writing');
  const staff = mockRes();
  await controller().createAttempt({ params: { id: String(oid()) }, user: { _id: oid(), email: 't@x.com', subscription_plan: 'free', effective_permissions: ['CanViewTests'] } }, staff);
  assert.equal(staff.statusCode, 201);
});
```

`test/classesLocked.test.js`:
```js
test('listClasses: locked classes are returned with lock and stripped of join/recording hints', async () => {
  stub(SubscriptionPlan, 'find', () => q(PLANS));
  stub(LiveClass, 'find', () => q([
    { _id: oid(), title: 'Free class', is_published: true, is_active: true, is_free: true, zoom_join_url: 'z', recording_url: 'r', youtube_url: 'y' },
    { _id: oid(), title: 'Elite class', is_published: true, is_active: true, allowed_plans: ['elite'], zoom_join_url: 'z', recording_url: 'r', youtube_url: 'y' },
  ]));
  const res = mockRes();
  await controller().listClasses({ query: {}, user: { _id: oid(), subscription_plan: 'free', effective_permissions: [] } }, res);
  const [open, locked] = res.body.classes;
  assert.equal(open.lock, null); assert.equal(open.has_join_link, true); assert.equal(open.has_recording, true);
  assert.equal(locked.lock.required_plan, 'elite');
  assert.equal(locked.has_join_link, false); assert.equal(locked.has_recording, false);
  assert.equal(locked.youtube_url, undefined);
  assert.equal(locked.zoom_join_url, undefined, 'student sanitizer still applies');
});

test('getClassJoinLink: locked → uniform UPGRADE_REQUIRED body', async () => { /* stub LiveClass.findById locked; student user; assert 403 + code + lock */ });
```
(`listClasses` runs a Zoom status refresh loop before filtering — stub whatever it touches the way `test/rbacMediaControllers.test.js` does for `listClasses`.)

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.**
`listTests` (student branch): `const viewer = await viewerFor(req.user); return res.json({ tests: tests.map((t) => ({ ...t, lock: lockState(t, viewer) })) });` (staff `all=true` branch: `lock: null` on each row for a stable shape).
`createAttempt`: after the schedule check,
```js
      if (!isStaff) {
        const lock = lockState(test, await viewerFor(req.user));
        if (lock) return res.status(403).json(upgradeRefusal(lock));
      }
```
`classesController`: in `listClasses` student branch replace the filter with
```js
        const viewer = await viewerFor(req.user);
        visibleClasses = classes.map((liveClass) => {
          const lock = lockState(liveClass, viewer);
          const row = sanitizeClassForStudent(liveClass);
          if (lock) { delete row.youtube_url; row.has_join_link = false; row.has_recording = false; }
          return { ...row, lock };
        });
```
and at the four 403 sites: `const lock = lockState(liveClass, viewer); if (lock) return res.status(403).json(upgradeRefusal(lock));`.

- [ ] **Step 4: `npm test`** → green (update any test asserting the old 403 body or the filtered-out behaviour, naming the new rule).

- [ ] **Step 5: Commit** `feat(tests,classes): locks in student lists; locked tests cannot be started; uniform upgrade refusals`.

---

### Task 5: Frontend infrastructure — LockBadge, UpgradeDialog, provider, httpClient hook, Subscription deep link

**Files:**
- Create: `src/components/common/LockBadge.jsx`, `src/components/upgrade/UpgradeDialog.jsx`, `src/lib/UpgradePromptContext.jsx`, `src/lib/pitchIcons.js`
- Modify: `src/api/httpClient.js` (~lines 141-155: decorate `UPGRADE_REQUIRED` and call the registered handler), `src/App.jsx:92-101` (mount provider), `src/pages/Subscription.jsx` (read `?plan=`), `src/components/subscription/PricingCard.jsx:97-128` (`highlighted` prop)

**Interfaces:**
- Produces: `useUpgradePrompt() → { promptUpgrade(lock) }`; `<LockBadge lock size="sm"|"md" />`; `setUpgradeHandler(fn)` in httpClient; `PITCH_ICONS` map `{ video: PlayCircle, notes: FileText, questions: ListChecks, live: Radio, doubt: HelpCircle, ai: Sparkles, analytics: BarChart3, star: Star, check: CheckCircle2 }`.
- Consumes: public plans query `['subscriptionPlans']` via `subscriptionPlansClient.listActive()`.

- [ ] **Step 1: `src/lib/pitchIcons.js`** — the map above plus `export const PITCH_ICON_OPTIONS = Object.keys(PITCH_ICONS)`.

- [ ] **Step 2: `LockBadge.jsx`**
```jsx
import { Lock } from 'lucide-react';
export default function LockBadge({ lock, size = 'sm', className = '' }) {
  if (!lock) return null;
  const label = lock.required_label || 'Paid plan';
  return (
    <span title={`Included in ${label}`} className={`inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 text-amber-800 font-medium ${size === 'md' ? 'px-2.5 py-1 text-sm' : 'px-2 py-0.5 text-xs'} ${className}`}>
      <Lock className={size === 'md' ? 'h-4 w-4' : 'h-3 w-3'} />{label}
    </span>
  );
}
```

- [ ] **Step 3: `UpgradeDialog.jsx`** — props `{ lock, open, onOpenChange }`. Reads `useQuery({ queryKey: ['subscriptionPlans'], queryFn: () => subscriptionPlansClient.listActive() })`, picks `plans.find(p => p.plan_name === lock.required_plan)` else the lowest-tier plan with `tier >= (lock.required_tier || 1)` else null. Layout (your screenshot): banner area `aspect-[2.4/1]` showing `pitch.banner_url` or a purple→pink gradient with a large `Sparkles`; `<DialogTitle>` "This is a {label} feature"; headline paragraph (`pitch.headline` or fallback `Upgrade to ${label} to unlock this and everything else in the plan.`); highlights list (icon in a coloured circle + text; when none, three generic lines: all lectures / all tests / live classes); footer: `Button variant="outline"` "Maybe later" and `Button` "View plans" → `navigate(\`${createPageUrl('Subscription')}?plan=${plan?.plan_name || ''}\`)` then `onOpenChange(false)`. Uses `Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle` from shadcn; `DialogContent className="max-w-md p-0 overflow-hidden"`.

- [ ] **Step 4: `UpgradePromptContext.jsx`**
```jsx
const Ctx = createContext({ promptUpgrade: () => {} });
export function UpgradePromptProvider({ children }) {
  const [lock, setLock] = useState(null);
  const promptUpgrade = useCallback((next) => setLock(next || { required_plan: '', required_label: 'a paid plan', required_tier: 1 }), []);
  useEffect(() => { setUpgradeHandler(promptUpgrade); return () => setUpgradeHandler(null); }, [promptUpgrade]);
  return (<Ctx.Provider value={{ promptUpgrade }}>{children}<UpgradeDialog lock={lock} open={Boolean(lock)} onOpenChange={(o) => { if (!o) setLock(null); }} /></Ctx.Provider>);
}
export const useUpgradePrompt = () => useContext(Ctx);
```
Mount in `App.jsx` inside `RealtimeProvider` (it needs the query client and router).

- [ ] **Step 5: `httpClient.js`** — module-level `let upgradeHandler = null; export function setUpgradeHandler(fn) { upgradeHandler = fn; }`. In the non-ok branch, before the generic error is thrown: `if (response.status === 403 && data?.code === 'UPGRADE_REQUIRED') { error.code = data.code; error.lock = data.lock || null; if (upgradeHandler) upgradeHandler(error.lock); }` (do not toast "Permission denied" for this case — the existing 403 toast is keyed on `data.error === 'Permission denied'`, so it already stays quiet).

- [ ] **Step 6: Subscription deep link.** In `Subscription.jsx`: `const [searchParams] = useSearchParams(); const focusPlan = searchParams.get('plan') || '';` pass `highlighted={planKey === focusPlan}` to `PricingCard` and, in an effect when plans load, `document.getElementById(\`plan-${focusPlan}\`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })`. `PricingCard`: add `highlighted` prop → `id={\`plan-${planKey}\`}` on the Card and `highlighted && 'ring-2 ring-purple-500 ring-offset-2'` in its `cn(...)`.

- [ ] **Step 7:** `npx eslint src` (0 errors) and `npm run build`. Commit `feat(upgrade): lock badge, upgrade dialog, global UPGRADE_REQUIRED handling, plan deep link`.

---

### Task 6: Student pages — Videos, Tests, Live classes use locks

**Files:**
- Modify: `src/pages/Videos.jsx` (grid card 464-518; detail header/list 320-406; watch branch), `src/components/videos/WatchLecture.jsx` (none expected; the page never reaches it for a locked playlist)
- Modify: `src/pages/Tests.jsx:44-51,123-136`, `src/components/test/TestCard.jsx:10-35,66-86`
- Modify: `src/pages/LiveClasses.jsx:66-72,321-336,420-460`, `src/components/classes/ClassCard.jsx:47,116-125,157,173,199-217`

**Interfaces:**
- Consumes: `playlist.lock`, `test.lock`, `liveClass.lock`, detail `{ locked, lectures(teaser) }`; `useUpgradePrompt`, `LockBadge`.

- [ ] **Step 1: Videos grid.** In the card: when `playlist.lock`, render `<LockBadge lock={playlist.lock} />` in place of `renderPlanBadge(playlist)`; button label `Preview` (still opens the detail via `setSearchParams`). Card gets `className="… opacity-95"` and the thumbnail an overlay `<Lock>` icon bottom-right.

- [ ] **Step 2: Videos detail (locked).** `const detailLocked = Boolean(playlistDetail?.locked); const detailLock = openPlaylist?.lock || null;` Header: `LockBadge size="md"` next to the name; under the description a bar:
```jsx
{detailLocked && (
  <div className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 sm:flex-row sm:items-center sm:justify-between">
    <div><p className="font-medium text-amber-900">Unlock this playlist with {detailLock?.required_label}</p><p className="text-sm text-amber-800">{lectures.length} lectures, live classes and more are included.</p></div>
    <Button onClick={() => promptUpgrade(detailLock)}>View plans</Button>
  </div>
)}
```
Lecture rows when locked: no progress bar, `opacity-70`, the Watch button becomes `<Button variant="outline" onClick={() => promptUpgrade(detailLock)}><Lock className="h-4 w-4 mr-2" />Unlock</Button>`; clicking the row title also prompts. `openVideo` early-returns to `promptUpgrade(detailLock)` when `detailLocked`, so `?lecture=` deep links into a locked playlist show the detail + dialog, never the player: in the `if (lectureParam)` branch add `if (detailLocked) { /* fall through to the playlist view */ }` by treating `selectedVideo` as null when locked (`const selectedVideo = useMemo(() => detailLocked ? null : …)`), and render the playlist view with the dialog opened once via an effect keyed on `detailLocked && lectureParam`.

- [ ] **Step 3: Tests.** Delete `planRanks`, `userRank`, `hasTestAccess` from `Tests.jsx`; `const { promptUpgrade } = useUpgradePrompt();` `handleStartTest = (test) => test.lock ? promptUpgrade(test.lock) : navigate(createPageUrl(\`TakeTest?id=${test.id}\`))`; pass `canAccess={!test.lock}` and `lock={test.lock}` to `TestCard`. In `TestCard`, the premium badge (25-35) becomes `<LockBadge lock={lock} />` when `lock`, "Free" badge unchanged; button text stays "Upgrade to Access" when locked.

- [ ] **Step 4: Live classes.** Delete the local `canAccessClass`; `canAccess={!liveClass.lock}` on both `ClassCard` usages (420, 446); inline Join buttons (321-336) → when `liveClass.lock`, `promptUpgrade(liveClass.lock)` instead. `ClassCard`: new prop `lock`; badge block 116-125 renders `<LockBadge lock={lock} />` when present; the Join/Watch buttons at 157/173/199 render instead a single `<Button variant="outline" onClick={() => onUnlock?.(liveClass)}><Lock/>Unlock with {lock.required_label}</Button>` when `lock` (new `onUnlock` prop wired to `promptUpgrade` in `LiveClasses.jsx` and `Dashboard.jsx` if it renders `ClassCard`).

- [ ] **Step 5:** eslint 0 errors, build. Commit `feat(student): locked playlists, tests and classes open the upgrade dialog`.

---

### Task 7: Admin Plans page — tier and pitch editor

**Files:**
- Create: `src/components/common/UrlOrUploadField.jsx` (copy of the local component in `src/pages/AdminClasses.jsx:78-104`, unchanged API `{ label, value, onChange, placeholder, accept, uploading, error, onPick, onClearError }`; do not refactor the other pages' copies)
- Create: `src/components/admin/PlanPitchEditor.jsx`
- Modify: `src/pages/AdminSubscriptionPlans.jsx:48-70` (formData gains `tier: 0, pitch: { headline: '', highlights: [], banner_url: '' }`), settings block (~470-500: add Tier input beside Sort order with hint "Higher tiers include everything below. Free = 0."), and a new "Upgrade pitch" block before `<DialogFooter>`
- Modify: `src/api/subscriptionPlansClient.js` (`uploadBanner(file)` → `POST /uploads/plan-banners`, returns absolute url like AdminClasses' `uploadThumbnail`)

**Interfaces:**
- `PlanPitchEditor({ value, onChange, planLabel })` — value is the pitch object; renders headline input (maxLength 120 + counter), `UrlOrUploadField` for banner (accept `image/*`, `onPick` → `subscriptionPlansClient.uploadBanner`), highlights list (rows: `Select` of `PITCH_ICON_OPTIONS` rendering the icon + text `Input` maxLength 120 + remove button; "Add highlight" disabled at 6), and on the right a live preview rendered with the same markup as `UpgradeDialog`'s body (extract that body into `UpgradePitchPreview` in `src/components/upgrade/UpgradeDialog.jsx` and reuse it here).

- [ ] **Step 1:** Extract `UpgradePitchPreview({ plan, lock })` from Task 5's dialog (banner + title + headline + highlights) and have the dialog render it.
- [ ] **Step 2:** Build `PlanPitchEditor` and wire it into the Plans dialog; form save sends `tier` and `pitch` (the backend validates; surface its 400 message with `toast.error`).
- [ ] **Step 3:** `subscriptionPlansClient.uploadBanner`.
- [ ] **Step 4:** eslint, build. Commit `feat(admin): plan tier and upgrade pitch editor with live preview`.

---

### Task 8: Docs and tracker

**Files:**
- Modify: `docs/ops/2026-09-22-playlist-rollout-runbook.md` — new section "Plan tiers and upgrade pitch": after deploy, open Plans, confirm tiers (free 0 < basic 1 < premium 2 < ultimate 3 or your own), fill in a pitch per paid plan; note the semantic change (higher tier includes lower).
- Modify: `docs/adding-a-permission-protected-page.md` (if present) — one line: plan-gated content uses `lockState`, not permissions.

- [ ] **Step 1:** Write the sections. Commit `docs(ops): plan tiers and upgrade pitch rollout`.

## Browser checklist (after all tasks)

1. Free student → Videos: paid playlist shows amber lock badge + "Preview"; open it → greyed lecture titles, "Unlock with Premium" bar → dialog with that plan's banner/headline/highlights → View plans lands on Subscription with the Premium card highlighted.
2. Deep link `/Videos?lecture=<locked lecture id>` → detail + dialog, no player.
3. Tests: locked card "Upgrade to Access" → dialog; the API refuses `POST /tests/:id/attempts` with `UPGRADE_REQUIRED` if called directly.
4. Live Classes: locked class card shows badge, "Unlock with …" button → dialog.
5. Premium student sees Premium content unlocked AND Basic content unlocked (higher includes lower); Ultimate sees everything.
6. Admin → Plans: set Tier, fill pitch (headline, 3 highlights, banner upload) → save → student dialog reflects it within 60 s (cache).
7. Deactivate the only plan a playlist names → students see it locked as "a paid plan"; dialog still offers View plans.
