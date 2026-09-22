# Lecture assets and playlists

Date: 2026-09-22
Status: Finalised. Awaiting review of the implementation plan before any code.

## 1. Problem

`Video` conflates two different things:

- **the asset** — a lecture file (on Bunny, or a YouTube link), with an encode
  state, a duration, a teacher, a transcript
- **the product** — what a student browses and pays for, with an ordering and a
  subscription-plan entitlement

Because they are one record, a lecture cannot appear in two places without being
duplicated, uploading is coupled to publishing, and plan entitlement is smeared
across individual videos instead of sitting on the thing actually sold.

**Lecture Library becomes the asset store — the single place every lecture is
uploaded to Bunny. Video Management becomes a curation surface where playlists
are assembled from those assets and published to students by plan.**

## 2. Decisions

All settled with the product owner.

| Question | Decision |
| --- | --- |
| Where does subject live? | **On the lecture only, as a real reference.** A playlist does not require a subject. |
| May a playlist span subjects? | **Yes.** A "Final year crash course" is legitimate. Playlists carry optional subject tags for browsing, never a required single subject. |
| Where does plan gating live? | **Playlist only**, set at creation. Lectures carry no entitlement. |
| Progress tracking | **Per asset.** Watching a lecture in one playlist marks it watched in every playlist containing it. |
| Mixed sources in a playlist | **Yes.** Bunny-hosted and YouTube lectures together. |
| Deactivating a lecture | **Silently removed from what students see**, in every published playlist. Watch/progress history is preserved. |
| "Also in" other playlists | **Yes**, showing other published playlists the student can access — explicitly secondary to the core flow. |
| `subject` as a plain String | **Replaced with a `Subject` reference for lectures and playlist tags**, as part of this work. Scoped deliberately — see §2.3. |

### 2.3 The Subject conversion is scoped to lectures and playlists

`subject` is stored as a plain string on `Doubt`, `Feedback`, `LiveClass` and
`Question` as well as `Video`, and threads through tests, classes, the AI
ingestion pipeline, the dashboard and roughly a dozen frontend pages. Converting
all of it is a platform-wide migration and a project in its own right.

This work converts **lectures and playlist tags only**. That is where the weak
model actually costs something: a renamed subject orphans a lecture and breaks
student access. Elsewhere a stale subject string is a filter mismatch — wrong,
but cosmetic.

Accepted cost: two conventions coexist until a follow-up project converts the
rest. That is worse than uniformity and better than either blocking playlists on
a platform-wide migration or leaving student access exposed.

### 2.1 A YouTube URL added during playlist building creates a Lecture

Pasting a YouTube URL while assembling a playlist creates a `Lecture` with
`provider: 'youtube'`; it does **not** become an inline playlist item.

One asset model means playlist items always reference lectures, progress stays
uniform, the same YouTube video used in three playlists is one asset, and the
existing link videos migrate in with no special casing.

### 2.2 Deactivation is a read-time filter, not a write

Deactivating a lecture does **not** mutate any playlist. The item stays in
`Playlist.items`; student-facing reads exclude lectures where
`is_active === false`. This is what makes "preserve history" free — no
`VideoProgress` row is touched, and reactivating restores the lecture to every
playlist it was in, in its original position.

Admin-facing playlist editing still shows deactivated members, marked as such,
so a curator can see why a playlist shrank.

## 3. Non-goals

- Per-playlist progress. Progress is per asset.
- Restricting which lectures may be added to a playlist by subject.
- Deleting Lecture Library. It remains, with a narrower job.
- Re-encoding or moving any existing Bunny asset.
- Making "Also in" a navigation hub. It is a secondary affordance.

## 4. Data model

### `Subject` — unchanged

Already exists with `name`, `slug` (both unique, indexed), `is_active`,
`sort_order`, `subtopics`, `owner_ids`. 21 rows in production. No change needed.

### `Lecture` — today's `Video`, narrowed, with a real subject reference

Keeps: `title`, `description`, `teacher_name`, `teacher_email`, `subtopic`,
`provider`, `video_url`, `bunny_video_id`, `bunny_library_id`,
`processing_status`, `duration_seconds`, `transcript_text`, `transcript_status`,
`thumbnail_url`, `card_thumbnail_url`, `is_active`, `created_by`, `updated_by`,
`updated_by_at`.

**Changes:**

- `subject: String` → `subject_id: { type: ObjectId, ref: 'Subject', required: true, index: true }`
- **Loses** `allowed_plans`, `is_free`, `is_published` — entitlement and
  publication move to the playlist. Nothing a student sees is decided on a
  lecture.
- **Loses** `order` — ordering is a property of a playlist, not of an asset.

### `Playlist` — the product

```js
{
  name:         { type: String, required: true },
  description:  { type: String, default: '' },

  // Optional browse tags. NOT required, and a playlist may span several.
  // Curator-set; the UI offers the union of its lectures' subjects as a
  // starting suggestion, but never derives this silently.
  subject_ids:  [{ type: ObjectId, ref: 'Subject' }],

  allowed_plans: { type: [String], default: [] },   // empty = all plans
  is_free:       { type: Boolean, default: false },
  is_published:  { type: Boolean, default: false },
  is_active:     { type: Boolean, default: true },

  items: [{
    lecture_id: { type: ObjectId, ref: 'Lecture', required: true },
    order:      { type: Number, default: 0 },
  }],

  created_by, updated_by, updated_by_at,
}
```

Indexes:
- `{ is_published: 1, is_active: 1 }` — student browsing
- `{ subject_ids: 1 }` — subject-filtered browsing
- `{ 'items.lecture_id': 1 }` — answers "which playlists contain this lecture?",
  needed both for "Also in" and before deactivating a lecture

> `subject_ids` is deliberately explicit rather than derived from members.
> Deriving it would mean recomputing on every lecture edit and would let a
> playlist silently change what it is filed under when a curator adds one
> off-topic lecture.

### `VideoProgress` — unchanged

Its `video_id` becomes a `Lecture` reference. No row migration: lecture `_id`s
are preserved (§6), so every existing progress row stays valid and correct.

## 5. Access control

`canAccessPlaylist(playlist, planName)` mirrors today's `canAccessVideo`:
`is_free` wins; an empty `allowed_plans` means all plans; otherwise the plan must
be listed.

**A lecture is playable iff it is active AND the student can access at least one
published, active playlist containing it.** That is the single gate, replacing
`canAccessVideo`. `GET /lectures/:id/playback` resolves entitlement that way
before minting a Bunny token; token minting itself is unchanged and already
verified against the live CDN.

> Accepted deliberately: a lecture in both a free and a paid playlist is
> reachable by anyone entitled to the free one. That follows from "entitlement
> lives on the playlist" and is intended.

### 5.1 "Also in"

On a lecture a student is watching, list other playlists that are published,
active, contain this lecture, and pass `canAccessPlaylist` for that student.
Never reveal a playlist the student cannot open. Secondary UI — it must not
become a second navigation path, and it must not add a query to the main
playlist read (resolve it lazily when the lecture view opens).

## 6. Migration

Existing `Video` rows are already assets. The collection is **converted in
place** rather than copied, so `_id`s — and therefore every `VideoProgress`
row — stay valid.

**Data as of 2026-09-22:** 21 `Subject` rows; only three distinct
`video.subject` strings in use (`Demo subject`, `ENT`, `Pharmacology`); **zero**
with no matching Subject. The string→reference conversion is mechanical.

1. For each `Video`, resolve `subject` to a `Subject` by slug (reusing
   `slugify` from `src/utils/subjects.js`) and set `subject_id`. A row that
   cannot be resolved is **reported and left untouched** — never silently
   assigned a default subject. The migration is re-runnable.
2. Read `allowed_plans` / `is_free` / `is_published` once, then drop them from
   the schema along with `subject` and `order`.
3. For each distinct subject among rows that were `is_published`, create one
   `Playlist` named after the subject, with `subject_ids: [thatSubject]`, the
   **union** of the plans seen on its member lectures, `is_published: true`, and
   items ordered by the lectures' existing `order` then `created_date`.
4. Rows that were unpublished become lectures in no playlist — present in
   Lecture Library, invisible to students. Same effective state as before.

The union in step 3 never removes access a student already had. Narrowing
afterwards is an editorial act done knowingly in the UI, not a silent side
effect of a migration.

## 7. Surfaces

**Lecture Library** — unchanged except that the Plans field and the Published
toggle disappear, and the subject picker writes `subject_id`. Upload, encode
status, refresh, edit metadata, deactivate. Nothing student-facing is decided
here.

**Video Management** — becomes playlist management: create a playlist with a
name, optional subject tags and plans; add lectures by searching the library;
paste a YouTube URL to create-and-add in one step; drag to reorder; publish.
Deactivated members are shown struck through so a curator understands a gap.

**Student Videos page** — browses published playlists, filtered by entitlement
and optionally by subject; opens one; plays its lectures in order, skipping
inactive ones. "Also in" appears on the lecture view.

This student page is the largest single change in this work and the least
certain. Prototype it against a real browser before building the rest — that is
the lesson from the Bunny integration, where four defects survived a full test
suite and a dozen reviews because everything was verified against assumptions
rather than a running client.

## 8. Risks

- **The student page is the real unknown.** The admin side is CRUD over a clear
  model. How students navigate playlists versus today's flat list is a product
  question, and worth a throwaway prototype first.
- **The subject conversion touches every video row.** Small today (3 distinct
  values, 0 orphans) and much cheaper now than after playlists multiply the
  references.
- **`Playlist.items` is an unbounded array.** Fine at lecture-per-playlist
  scale; if a playlist ever holds thousands of items, this becomes a separate
  collection. Not a concern at the intended scale.
- **Two systems of record during rollout.** Until migration runs, `Video` rows
  still carry `allowed_plans`/`is_published`. The migration must be a single
  cutover, not a gradual dual-write.

## 9. Sequencing

Do not start until the Bunny upload path is boring: ~10-20 real lectures
uploaded without new defects, and the status webhook working in a deployed
environment so "Refresh status" is a fallback rather than the mechanism.

Two integration points from that work remain unverified against reality —
Safari/iOS playback, and the webhook itself. Building a curation layer on top of
a pipeline that is still moving means debugging two things at once.
