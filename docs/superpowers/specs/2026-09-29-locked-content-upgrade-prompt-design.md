# Locked content with an upgrade prompt

Date: 2026-09-29
Status: Approved in conversation (owner delegated the three open decisions); implementation plan follows.

## 1. Problem

Plan-gated content is invisible to the students it is meant to sell to.
Playlists and live classes a student's plan does not include are filtered
out server-side, so a free student browsing Videos sees only free
playlists and has no idea what a paid plan adds. Tests are shown but their
lock is computed from a plan list **hard-coded in two places** (backend
`PLAN_RANKS`, frontend `Tests.jsx`), so a plan the owner creates on the
Plans page — "Elite", "Pro" — ranks as free, and a locked test can still be
started (only the question fetch is gated).

The owner wants what every coaching app does: locked items stay on the
page with a lock, and clicking one opens an upgrade prompt that names the
plan and sells it, with a button to the pricing page.

## 2. Decisions

| Question | Decision |
| --- | --- |
| Which content | Playlists (and their lectures), tests, live classes. |
| Locked playlist detail | Shows the lecture **titles**, greyed, as a teaser — plus one "Unlock with <Plan>" bar. |
| Popup copy | Per plan, edited on the admin Plans page ("Upgrade pitch": headline, up to 6 highlights with an icon, optional banner image). Seeded defaults so it is never empty. |
| Ordering of plans | A numeric **`tier`** on each plan, set by the admin. A student whose plan tier is ≥ the required tier is entitled. Higher plans include everything below — this replaces both today's exact-match `allowed_plans` and the hard-coded rank list. |
| Which plan a lock names | The lowest-tier active plan that unlocks the item ("cheapest way in"). |
| Locked test | Also **cannot be started** any more (403), closing today's gap. |
| Expired subscription | Already downgraded to `free` by `expireSubscriptionIfNeeded` on every request; nothing new. |
| Staff | Unchanged: CanViewVideos / CanViewTests / CanViewClasses holders bypass locks as they do today. |

## 3. Non-goals

- Changing how plans are bought (Razorpay flow, Subscription model).
- Per-feature entitlements or limits (doubts per month, AI questions per day) — a later project ("plan grants permissions"), discussed separately.
- Replacing `allowed_plans` / `required_plan` on content documents. The fields stay; only the comparison changes.
- Discussions on locked lectures — they already follow playback (gate = `loadVideoForPlayback`), so a locked lecture has no thread for that student.

## 4. Data model

`SubscriptionPlan` gains:

```js
tier: { type: Number, default: 0, min: 0 },            // ordering for entitlement; free = 0
pitch: {
  headline:   { type: String, default: '' },           // ≤ 120 chars
  highlights: [{ icon: String, text: String }],        // ≤ 6 items; text ≤ 120 chars; icon ∈ PITCH_ICONS
  banner_url: { type: String, default: '' },
},
```

`PITCH_ICONS = ['video', 'notes', 'questions', 'live', 'doubt', 'ai', 'analytics', 'star', 'check']`
(backend validates the key; the frontend maps keys to lucide icons).

Startup (idempotent, next to `ensureDefaultSubscriptionPlans`):
- `ensurePlanTiers()`: every plan without a `tier` gets `tier = sort_order`
  (`updateMany({ tier: { $exists: false } }, [{ $set: { tier: '$sort_order' } }])`).
- Seeded default plans carry `tier` (free 0, basic 1, premium 2, ultimate 3) and a default pitch each.

No other schema change. Content keeps `is_free` + `allowed_plans` (playlists, live classes) and `is_free` + `required_plan` (tests).

## 5. Entitlement (one rule, one file)

`src/utils/entitlement.js` — pure functions plus one cached loader:

```js
getActivePlans()                       // SubscriptionPlan.find({ is_active: true }).lean(), 60 s in-memory cache; invalidatePlansCache() on plan create/update/delete
planTier(planName, plans)              // tier of the named active plan; unknown or '' → 0. Legacy aliases: medium → premium, advance → ultimate
requiredPlanFor(item, plans)           // null when free / open to all; else the lowest-tier plan among item.allowed_plans (or the one named by item.required_plan)
buildViewer(user, plans)               // { planName, tier, plansByName } — built once per request (viewerFor(user) loads the cached plans)
lockState(item, viewer)                // null (entitled) | { required_plan, required_label, required_tier }
```

Rules:
- `item.is_free === true` → not locked.
- `allowed_plans` empty (or `required_plan` missing/'free') → not locked.
- Otherwise required tier = min tier over the named plans that exist and are active; if none of the named plans exists any more, required tier = **1** with label "a paid plan" (never silently unlock because a plan was renamed).
- Locked iff `viewer.tier < required_tier`.
- `canAccessPlaylist(playlist, viewer)` and `canAccessClass(liveClass, viewer)` become thin wrappers over `lockState`; `getPlanRank`/`PLAN_RANKS` in testsController are deleted in favour of the viewer's tier.

Uniform refusal body wherever a plan blocks an action (`playback`, `createAttempt`, class join / recording / summary / chat):

```json
{ "error": "Upgrade required", "code": "UPGRADE_REQUIRED", "lock": { "required_plan": "elite", "required_label": "Elite", "required_tier": 2 } }
```

## 6. API behaviour changes (students only; staff paths unchanged)

| Route | Today | New |
| --- | --- | --- |
| `GET /playlists` (browse) | drops unentitled playlists | returns them too; every playlist carries `lock` (`null` or the lock object). Same projection (`studentPlaylistView`) plus `lock`. |
| `GET /playlists/:id` | 404 when unentitled | when published+active but locked: `{ playlist: view + lock, lectures: [teaser…], locked: true }` where a teaser row is `{ _id, title, subtopic, duration_seconds, thumbnail_url, card_thumbnail_url }` (no `video_url`, no provider fields). Unpublished/inactive/missing stay 404. |
| `GET /videos/:id/playback` | 403 `Upgrade required` | 403 with the uniform body. |
| `GET /tests` | all published tests, no lock info | each test carries `lock`; `required_plan`/`is_free` still present. |
| `POST /tests/:id/attempts` (createAttempt) | no plan check | 403 uniform body when locked (staff bypass as elsewhere). |
| `GET /tests/:id/questions` | filters questions by rank | unchanged mechanism, now `planTier`-based. |
| `GET /classes` | drops unentitled classes | returns them with `lock`; locked rows additionally lose `youtube_url`, `has_join_link`, `has_recording` set to `false`. |
| class join / recording / summary / chat | 403 `Upgrade required` | 403 with the uniform body. |
| `GET /subscription-plans` (public) | plan docs | now includes `tier` and `pitch` (the document already goes out whole). |
| `POST/PATCH /subscription-plans` | no validation of these fields | validates `tier` (integer ≥ 0) and `pitch` shape; invalidates the entitlement cache. |
| `POST /uploads/plan-banners` | — | new; `authorize.any('CanAddSubscriptionPlans', 'CanEditSubscriptionPlans')`, image only, same `handleUpload` as thumbnails. |

Route rule tests (`test/rbacRoutesFinal.test.js`, `test/rbacCoverage.test.js`) keep one marker per route.

## 7. UI

### Shared
- `LockBadge` — pill with a lock icon and the plan label ("Elite"). Rendered wherever `item.lock` is set.
- `UpgradeDialog` + `UpgradePromptProvider` / `useUpgradePrompt()` — one dialog mounted once in `App.jsx`; any page calls `promptUpgrade(lock)`. The dialog reads the public plans query (`['subscriptionPlans']`) to find the required plan's `pitch`: banner (or a gradient with the plan icon when none), "This is a <Plan> feature", headline, highlights with icons, **Maybe later** / **View plans**. View plans navigates to `/Subscription?plan=<plan_name>`.
- `httpClient`: a 403 whose body has `code === 'UPGRADE_REQUIRED'` attaches `error.lock` and calls the registered upgrade handler, so any API refusal opens the dialog without per-call wiring.
- `Subscription.jsx` reads `?plan=` and scrolls to / highlights that card.

### Videos (student)
- Grid: locked playlist card shows `LockBadge` instead of the plan badges; the button reads "Preview" and opens the detail.
- Detail (locked): header with `LockBadge`; a full-width bar "Unlock this playlist with Elite — View plans" (opens the dialog); lecture rows greyed, no progress bar, lock icon instead of Watch; clicking a row opens the dialog.
- Watch view: a deep link to a lecture in a locked playlist renders the locked detail (never the player).

### Tests
- `TestCard` uses `test.lock` (the local `planRanks` copy is deleted); "Upgrade to Access" → `promptUpgrade(test.lock)`; the plan name on the badge comes from `lock.required_label`.

### Live classes
- `ClassCard` shows `LockBadge` for `liveClass.lock`; Join / Watch buttons become "Unlock" → `promptUpgrade(liveClass.lock)`; the local `canAccessClass` copy is deleted.

### Admin Plans page
- **Tier** number field next to Sort order, with a hint: "Higher tiers include everything below. Free = 0."
- **Upgrade pitch** section: headline, banner (URL or upload via `/uploads/plan-banners`), highlights list (add/remove up to 6; icon select + text). Live preview card of the dialog on the right.

## 8. Errors and edge cases

- A plan referenced by content but deactivated/renamed → item locks at tier 1 with label "a paid plan"; the dialog falls back to the lowest-tier paid plan's pitch.
- No active paid plans at all → nothing can be locked at tier ≥ 1 except the "a paid plan" fallback; dialog shows generic copy and View plans.
- `tier` missing on an old plan → treated as `sort_order` by the startup backfill; the helper treats `undefined` as 0 defensively.
- Staff opening a locked playlist in previews: unaffected (staff paths do not call the student handlers).
- The playback 403 in `WatchLecture` (e.g. plan expired mid-session) opens the dialog via the httpClient hook; the player shows "Upgrade required".

## 9. Testing

Backend (node:test, stubbed models):
- `entitlement.test.js`: tier lookup incl. aliases and unknown; `requiredPlanFor` picks the cheapest; empty list / `is_free` → open; missing plan → tier 1 fallback; higher tier includes lower; equal tier entitled; `undefined` tier.
- Playlists: browse returns locked with `lock` and the same projection; get returns teaser rows without `video_url`; unpublished stays 404.
- Tests: `listTests` carries `lock`; `createAttempt` 403 uniform body when locked, staff bypass.
- Classes: `listClasses` returns locked rows stripped; join 403 uniform body.
- Plans: `tier`/`pitch` validation (bad icon, 7 highlights, negative tier → 400); cache invalidated on update.
- Route pins for the new upload route.

Frontend: eslint + build per task; browser checklist in the plan (grid lock, detail teaser, dialog copy, View plans deep link, test start refusal, class unlock, admin pitch editor, expired plan).

## 10. Rollout

No data migration. On first start after deploy, `ensurePlanTiers` copies `sort_order` into `tier`. Operator: open Plans and confirm tiers (free 0 < … ), fill in a pitch per paid plan. Because "higher includes lower" is new, a playlist ticked only for `premium` becomes visible to `ultimate` too — the intended reading.
