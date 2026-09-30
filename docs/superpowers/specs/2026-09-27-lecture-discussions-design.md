# Lecture discussions, nicknames and avatars

Date: 2026-09-27
Status: Approved in conversation; awaiting implementation plan.

## 1. Problem

The Student Community page is a stand-alone social network — a student
directory, connection requests, self-made groups with posts. On the live
database it holds zero groups, zero resources and zero connection
requests. A social space with no density feels dead, and open groups with
free-text posts and links create a moderation queue nobody has budgeted
for. The product owner is hiding it via the `CanAccessCommunity` permission.

What students actually want to do is ask about the thing in front of them:
"I didn't get the part at 12:40", "why is option B wrong". That already has
a place with a teacher on the other end — Doubts — but Doubts is private and
one-to-one, so one good answer helps one student.

**Put discussion where the content is.** A thread under every lecture,
open to the students who can watch it and to teachers, with peer answers,
teacher answers highlighted, and upvotes. Density is automatic (everyone
watching the lecture lands in the same thread), context is built in, and
the same thread becomes searchable knowledge instead of a private message.

Alongside it, a light identity layer students have asked for elsewhere: a
chosen avatar and a nickname, so a student can ask a "stupid" question
without their real name on it, while staff always know who wrote what.

## 2. Decisions

All settled with the product owner.

| Question | Decision |
| --- | --- |
| Scope of this round | Discussion threads only. Leaderboards/cohorts, public Q&A from Doubts, and streaks are later projects. |
| Where threads live | Lectures now. The anchor is stored as `{ type, id }` so **test questions** can be added later with no migration; the question UI is out of scope. |
| Who may post | Any student who can play the lecture, plus teachers/admins. Teacher replies are badged and sort first; students upvote. |
| Identity | Real first name + default avatar until the student sets a **nickname** and picks an **avatar** from a curated set. A per-post **anonymous** toggle hides both from students. **Teachers and admins always see the real identity.** |
| Avatars | A fixed set of illustrated SVGs shipped with the app. No uploads. |
| Moderation | Hide, never delete. Reports go to teachers; auto-hide after 3 reports pending review; repeat offenders are muted for 7 days; simple profanity filter on submit. No new admin queue page. |
| Existing Doubts / Feedback | Unchanged. They keep showing what they show today. |

## 3. Non-goals

- Threads on test questions (data model ready; UI and the review-screen
  gating are a later task).
- Leaderboards, cohorts, streaks.
- Rich text, images or attachments in posts; @mentions; email digests.
- Private/direct messages between students.
- Deleting the Community pages or their data. Hidden by permission only.

## 4. Identity

### 4.1 Profile fields

`User` gains:

```js
nickname:    { type: String, default: '' },        // as typed, 2–20 chars
nickname_lc: { type: String, index: { unique: true, sparse: true } }, // lower-cased, for uniqueness
avatar_id:   { type: String, default: '' },        // one of AVATAR_IDS, or '' = default
```

Validation (pure, tested): nickname trimmed, 2–20 characters, letters,
digits and single spaces only, not on the reserved list (`admin`,
`teacher`, `soulmed`, `moderator`, `anonymous`, `staff`, `support`),
unique case-insensitively. `avatar_id` must be in the shipped list.

### 4.2 The avatar set

`frontend/src/assets/avatars/*.svg`, 24 files, ids `avatar-01` …
`avatar-24`, plus `avatar-default`. The backend holds only the list of
valid ids (`src/utils/avatars.js`) — it never serves the files.

### 4.3 What each viewer sees

`displayIdentity(post, viewerIsModerator)` — pure:

| Post | Student sees | Moderator sees |
| --- | --- | --- |
| normal | avatar + nickname (or first name if no nickname) | the same, **plus** `real_name`, `email` |
| anonymous | default avatar + "Anonymous" | "Anonymous" badge **plus** `real_name`, `email`, nickname |

The snapshot `author_snapshot` (display name + avatar at post time) is what
students see, so a later nickname change does not rewrite history. Staff
fields are resolved live from the user document.

### 4.4 Admin control

`PATCH /users/:id` (CanEditUsers) may set `nickname: ''` to clear an
offensive nickname. The student receives a notification ("Your nickname was
removed by a moderator") and reverts to first name. Audited as
`user.nickname_cleared`.

## 5. Data model

```js
// discussion_posts
{
  anchor:        { type: { type: String, enum: ['lecture', 'question'], required: true },
                   id:   { type: ObjectId, required: true } },
  parent_id:     { type: ObjectId, ref: 'DiscussionPost', default: null }, // null = top-level
  author_id:     { type: ObjectId, ref: 'User', required: true, index: true },
  author_snapshot: { display_name: String, avatar_id: String },
  is_anonymous:  { type: Boolean, default: false },
  body:          { type: String, required: true },              // 2–2000 chars, plain text
  video_time:    { type: Number, default: null },               // seconds; lecture anchors only
  upvotes:       { type: [ObjectId], default: [] },             // user ids, toggle
  is_teacher_reply: { type: Boolean, default: false },          // author held CanModerateDiscussions at post time
  is_pinned:     { type: Boolean, default: false },             // one per thread; set by a moderator
  is_hidden:     { type: Boolean, default: false },
  hidden_by:     { type: ObjectId, ref: 'User' },
  hidden_reason: { type: String, default: '' },                 // 'moderator' | 'auto_reports' | 'filter'
  reports:       [{ user_id: ObjectId, reason: String, at: Date }],
  report_count:  { type: Number, default: 0, index: true },      // = reports.length, kept in step atomically
  edited_at:     Date,
}
// timestamps: created_date / updated_date
// indexes: { 'anchor.type': 1, 'anchor.id': 1, parent_id: 1, created_date: -1 }
//          { author_id: 1, created_date: -1 }
//          { report_count: -1, created_date: -1 }  (the report queue)
```

`User` additionally gains `discussion_muted_until: Date` for the mute rule.

Depth is one level: a reply's `parent_id` must point at a top-level post
(a reply to a reply becomes a sibling). This keeps rendering and counting
simple and matches how the lecture panel is laid out.

## 6. Access control

Two new catalogue permissions, added the standard way (see
`docs/adding-a-permission-protected-page` guide):

- `CanAccessDiscussions` — resource `StudentPages`; in the default student
  and teacher bundles.
- `CanModerateDiscussions` — resource `Discussions`; in the default teacher
  bundle (with `manage_doubts`), admins have it implicitly.

The lecture gate is the existing one: a caller may read or post on a
lecture thread **iff `isLecturePlayable(lecture, playlists, plan)` or
the caller is staff** (`CanViewVideos`) — exactly the playback rule. No new
entitlement logic.

### Routes

| Route | Marker | Behaviour |
| --- | --- | --- |
| `GET /discussions?anchor_type=lecture&anchor_id=<id>` | `authorize('CanAccessDiscussions')` | 404 if the lecture is not playable for the caller (same as playback). Returns top-level posts newest-first with their replies (teacher/pinned first, then upvotes, then oldest). Hidden posts omitted for students; included with `is_hidden` for moderators. Identities projected per §4.3. |
| `POST /discussions` | `authorize('CanAccessDiscussions')` | body `{ anchor_type, anchor_id, parent_id?, body, is_anonymous?, video_time? }`. Same gate. Refused 403 while muted. Rate-limited 10/min per user. Body 2–2000 chars, profanity filter → 400. Sets `is_teacher_reply` from the caller's permissions. |
| `POST /discussions/:id/upvote` | `authorize('CanAccessDiscussions')` | Toggle; cannot upvote own post. |
| `POST /discussions/:id/report` | `authorize('CanAccessDiscussions')` | One per user per post; reason from a fixed list (`spam`, `abuse`, `wrong`, `other`). Third distinct report sets `is_hidden` with reason `auto_reports`. |
| `PATCH /discussions/:id` | `authorize.any('CanAccessDiscussions', 'CanModerateDiscussions')` | Author: `body` only, within 15 minutes of `created_date`. Moderator: `is_pinned`, `is_hidden` (+`hidden_reason: 'moderator'`). Anything else 403. |
| `GET /discussions/reports` | `authorize('CanModerateDiscussions')` | Posts with ≥1 report or `is_hidden`, newest first, with real identities. |
| `PATCH /auth/me` | `selfService` (existing) | now accepts `nickname`, `avatar_id`. |
| `GET /auth/nickname-available?nickname=` | `selfService` | live uniqueness check for the profile form. |

Every route keeps exactly one marker (`test/rbacCoverage.test.js`).

### Mute rule (pure, tested)

When a post is hidden by a moderator or by auto-reports, count the author's
hidden posts in the last 30 days; at 3 or more set
`discussion_muted_until = now + 7 days`. A muted student can read but
`POST /discussions` returns 403 with the date. Notification sent once.

## 7. UI

### Student — lecture view (`Videos.jsx`, under the player next to the AI chat)

- Header "Discussion (N)" where N counts visible top-level posts.
- Composer: textarea (2000 chars with counter), **"Ask at 12:40"** chip
  that captures the player's current time (click on a post's time seeks
  the player), **"Post anonymously"** toggle, Post button. Disabled with the
  reason when muted.
- List: newest questions first; each shows avatar, display name (or
  "Anonymous"), time, body, upvote count/button, reply count, "Reply".
  Replies expand inline; teacher replies carry a **Teacher** badge and sort
  first; a pinned reply carries **Answer** and sorts above everything.
- "Report" in an overflow menu; "Edit" on own posts for 15 minutes.
- Empty state: "No questions yet — be the first to ask."

### Teacher / admin

- The same panel appears in the Lecture Library **Preview** dialog and in
  the Video Management lecture preview, with **Pin as answer**, **Hide**,
  **Unhide**, and real identities shown under each display name.
- **Manage Doubts** gains a "Reported discussion posts" section (no new
  menu item): the report queue with Hide / Dismiss.

### Profile

- "How you appear to other students": avatar grid (24 + default), nickname
  field with live availability check, preview card. Saves through
  `PATCH /auth/me`.

### User Management

- User detail shows nickname + avatar; **Clear nickname** action
  (CanEditUsers) with a reason prompt.

### Notifications (existing model and WebSocket)

- Someone replies to your post → "X replied to your question on *ENT basics*".
- A teacher replies → same, prefixed "Teacher".
- Your post was hidden → "A moderator hid your post on *ENT basics*: <reason>".
- You were muted → "Posting is paused until <date>".
All link to the lecture page.

## 8. Error handling and abuse

- All text through the existing `bodyLimits` net plus the 2–2000 rule.
- Profanity filter: a small word list in `src/utils/profanity.js`, tested;
  a match returns 400 "Please rephrase" and never stores the post.
- Reports are idempotent per user; upvotes are a toggle; both are atomic
  `$addToSet`/`$pull`.
- Deleting a lecture permanently (existing hard delete) also removes its
  discussion posts; deactivating a lecture leaves them (read-time filtered
  with the lecture).
- The lecture gate reuses `isLecturePlayable`, so a lecture removed from
  every accessible playlist makes its thread 404 for that student, exactly
  like playback.

## 9. Testing

Backend, all pure and DB-free where the rule lives:
`displayIdentity` (four viewer/post combinations), nickname validation and
reserved list, avatar id validation, thread ordering (pinned → teacher →
upvotes → oldest), edit window, auto-hide at the third distinct reporter,
mute threshold, profanity filter, the lecture gate delegating to
`isLecturePlayable`. Route markers in `test/rbacRoutes*.test.js`; controller
allow/deny tests in the existing stubbed-model style. The suite stays green
and pristine.

Frontend: eslint + build after every task; a browser checklist in the plan
(post, reply, anonymous, seek from time chip, upvote, report → third report
hides, teacher pin, nickname uniqueness, cleared nickname, notifications).

## 10. Rollout

No data migration. Two new permission codes sync on the next backend
start; the default student/teacher bundles are updated for new databases,
and on the live database an admin ticks `CanAccessDiscussions` for the
student role and `CanModerateDiscussions` for teacher on the Roles page
(or runs `scripts/migrateRbac.js --reset-defaults`, knowing it re-applies
defaults). Hiding Community is a separate, already-planned permission
change by the owner.
