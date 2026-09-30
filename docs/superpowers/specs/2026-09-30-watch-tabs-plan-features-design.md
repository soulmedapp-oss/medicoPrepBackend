# Watch-page tabs, plan features, and class audit columns

Date: 2026-09-30
Status: Approved in conversation ("Yes go ahead", Transcript tab included).

## 1. What and why

Three owner requests, one small design:

1. **Manage Live Class** shows who scheduled a class and who last changed it — the same two columns the Lecture Library already has. Live classes record neither today.
2. **Student watch page**: the area under the player becomes tabs — **Discussion | AI Tutor | AI Summary | Transcript** — so the student switches between them; the right rail keeps only the lecture list. AI Summary and Transcript load only when their tab is opened (today the summary is generated on every lecture open).
3. **Plan features**: a plan lists which of these features it includes. A student whose plan lacks one sees the tab with a lock and gets the upgrade dialog; the backend refuses the endpoint the same way. This is the first step of "plan grants features" on top of the tier/lock machinery from 2026-09-29.

## 2. Decisions

| Question | Decision |
| --- | --- |
| Feature catalogue | `PLAN_FEATURES = ['ai_tutor', 'ai_summary', 'transcript']` (backend `src/utils/planFeatures.js`; labels `AI Tutor`, `AI Summary`, `Transcript`). Extensible; nothing else is feature-gated yet. |
| Where a plan says what it includes | `SubscriptionPlan.features: [String]` (validated against the catalogue). Plans page: a **Features** section with one checkbox per feature. |
| Rule | A feature is available when the student's active plan lists it. Staff (`CanViewVideos`) always have it. The lock names the **cheapest (lowest-tier) active plan that lists the feature**; if no active plan lists it → `required_plan: ''`, `required_label: 'a paid plan'`, `required_tier: 1`. Same lock object shape as content locks. |
| Seeded defaults | free: `['transcript']`; basic: `['transcript','ai_summary']`; premium & ultimate: all three. Existing plans on a live DB: `features` absent → treated as `[]` (nothing included) until the admin ticks — **and** `ensurePlanFeatures()` seeds the defaults above by `plan_name` once for plans that have no `features` field, so the first deploy does not lock everyone out. |
| Refusal | `403 { error:'Upgrade required', code:'UPGRADE_REQUIRED', lock }` from `GET /videos/:id/ai-summary`, `POST /videos/:id/ai-chat`, `GET /videos/:id/transcript` when the feature is not in the plan (after the existing playback gate; staff bypass). |
| How the client knows | `GET /auth/me` (and the login/refresh payloads that return the user) add `feature_locks: { ai_tutor: lock|null, ai_summary: lock|null, transcript: lock|null }` (staff → all null). |
| Transcript source | `Video.transcript_text` (already stored, ≤200k chars; VTT/SRT or plain text). New `GET /videos/:id/transcript` returns `{ transcript: string }`; the client parses VTT/SRT into cues (click → seek) or shows paragraphs, with a search box. Never part of `STUDENT_LECTURE_FIELDS`. |
| Class audit fields | `LiveClass.created_by`, `updated_by`, `updated_by_at` (ObjectId/Date, like `Video`). Set on create, update, publish/unpublish, deactivate. Staff list (`all=true`) resolves `created_by_name`, `updated_by_name` via the shared `attachActorNames` helper (moved to `src/utils/actorNames.js`). Old rows show `—`. |

## 3. Non-goals

- Feature limits/quantities (N doubts per month) — later.
- Gating anything other than the three features above (live classes, tests, downloads stay on content locks).
- Changing the AI service, prompts, or transcript upload.
- Notes tab, Resources tab, "Ask teacher" button — noted as ideas only.

## 4. API

| Route | Change |
| --- | --- |
| `GET /videos/:id/ai-summary`, `POST /videos/:id/ai-chat` | after the playback gate: non-staff → `featureLock('ai_summary'|'ai_tutor', viewer)` → 403 uniform body when locked. |
| `GET /videos/:id/transcript` (new) | marker `authorize.any('CanAccessVideos','CanViewVideos')`; playback gate; non-staff feature `transcript`; returns `{ transcript }` (empty string when none). |
| `GET /auth/me` | adds `feature_locks`. `POST /auth/login`, `POST /auth/refresh` user payloads add it too (same helper `withFeatureLocks(user)`), so the client has it after sign-in without a second call. |
| `POST/PATCH /subscription-plans` | `features` validated: array of unique catalogue keys; unknown key → 400. Invalidates the entitlement cache. `GET /subscription-plans` (public) exposes `features`. |
| `GET /classes?all=true` | rows carry `created_by_name`, `updated_by_name`, `updated_by_at`. |
| `POST/PATCH/DELETE /classes` | set `created_by` (create) / `updated_by` + `updated_by_at` (every write). |

`src/utils/entitlement.js` gains:
```js
featureLock(feature, viewer)        // null | { required_plan, required_label, required_tier }
featureLocksFor(viewer)             // { ai_tutor, ai_summary, transcript } — each null | lock
```
`getActivePlans()` selects `features` as well. `viewer.plansByName` values therefore carry `features`; the viewer's own plan is `viewer.plansByName.get(viewer.planName)`.

## 5. UI

### Watch page (`WatchLecture.jsx`)
- Under the player: `Tabs` — **Discussion (N)** (default when allowed) | **AI Tutor** | **AI Summary** | **Transcript**. Below `xl` the **Lectures** tab joins them (as today). The right rail on `xl` shows only the lecture list ("Also in" at its bottom).
- A locked tab renders its trigger with a `LockBadge` (plan label) and, when selected, a locked panel: lock icon, "AI Tutor is included in Premium", **View plans** → `promptUpgrade(lock)`. The endpoints are never called for a locked feature.
- AI Summary: fetched on first open of the tab, cached per lecture (existing `summaryByVideo`). Transcript: fetched on first open; VTT/SRT cues render as rows `[12:40] text` (click seeks the player); plain text renders as paragraphs; a search box filters rows/highlights matches.
- Feature locks come from `useAuth().user.feature_locks` (no extra request).

### Plans page
- **Features** block (checkboxes, one per catalogue entry, with the label and a one-line hint) between Settings and the Upgrade pitch. Saved as `features`.

### Manage Live Class
- Two columns after **Published**: **Scheduled by** (`created_by_name` + `created_date`) and **Last modified** (`updated_by_name` + `updated_by_at`), formatted like Lecture Library's `formatLastModifiedAt`.

## 6. Testing

Backend: `featureLock` pure tests (plan includes → null; cheapest plan wins; none → 'a paid plan' tier 1; staff not involved here); handler tests: ai-summary/ai-chat/transcript 403 uniform body for a plan without the feature, 200 with it, staff bypass, transcript never in `STUDENT_LECTURE_FIELDS`; `getMe` carries `feature_locks`; plan validation rejects unknown feature; classes create/update stamp actors and the staff list carries names; route pins for the new transcript route.
Frontend: eslint + build; browser checklist: free student → Transcript works, AI tabs locked → dialog; premium → all tabs; admin ticks/unticks a feature → student sees the change after re-login or refresh; Manage Live Class columns fill in after an edit.

## 7. Rollout

`ensurePlanFeatures()` runs at startup (idempotent, only plans without `features`). Operator: Plans page → confirm the Features ticks per plan. Runbook section added.
