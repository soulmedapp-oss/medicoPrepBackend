# Playlist rollout runbook

Operator-facing. Covers deploying the lecture-library/playlists branch and
running the two migrations that go with it. Read the whole page before
starting: the deploy and the migration belong in **one maintenance window**.

## Why this is one window, not two

From the moment this branch is deployed, a playlist is the *only* thing that
makes a lecture reachable: a lecture is playable (and answerable by the AI
tutor, and listed in the student library) **iff** it is active **and** it sits
in at least one published, active playlist the student can access. The
lecture's own `is_published` / `allowed_plans` / `is_free` no longer grant
anything.

Until the migration has run there are no playlists. So between deploy and
migration:

- every student sees **"No playlists available yet."** on the Lectures page,
- **no lecture is playable**, and ai-summary / ai-chat answer `403 Upgrade
  required` for every student,
- staff holding `CanViewVideos` are unaffected — the staff bypass still
  previews any active lecture.

Deploy order itself is safe either way (old code ignores playlists; new code
needs them), so you may migrate just before or just after the deploy — but
keep the gap short and inside the window.

## Order of operations

Run from the backend repo root, with `MONGODB_URI` pointing at the target
database. Both scripts refuse to run without exactly one of `--dry-run` /
`--execute`; **neither ever writes without `--execute`**.

1. **Subject backfill — rehearse**

   ```
   node src/scripts/backfill-video-subject-ids.js --dry-run
   ```

   Read-only. Prints `Would update: N` and any `Unresolved:` rows (a video
   whose `subject` string matches no `Subject`). Fix unresolved rows first —
   either correct the video's subject in Video Management or add the missing
   Subject — then re-run the dry run until `Unresolved: 0`.

2. **Subject backfill — execute**

   ```
   node src/scripts/backfill-video-subject-ids.js --execute
   ```

   Writes `subject_id` onto every video it can resolve. Idempotent; exits
   non-zero if anything was left unresolved.

3. **Playlist migration — rehearse**

   ```
   node src/scripts/migrate-videos-to-playlists.js --dry-run
   ```

   Read-only for data. (It does create the `PlaylistMigration.subject_id`
   unique index and any missing `Playlist` index — a schema operation, not a
   data write, and the index is what makes a concurrent `--execute` safe.)

   The output has three parts to read, in this order:

   - **Playlists to create** — one per subject, with its plans and item count.
   - **ACCESS GRANTED BY THIS MIGRATION** — see the next section. Stop here
     if a grant is not one you want.
   - **Unplaced rows**, split in two:
     - *Unpublished videos, left out of every playlist as expected* — normal,
       needs nothing, does not affect the exit code.
     - *Published videos with no subject_id — ACTION REQUIRED* — go back to
       step 1. **This list alone** makes the script exit non-zero.

4. **Playlist migration — execute**

   ```
   node src/scripts/migrate-videos-to-playlists.js --execute
   ```

   Creates one playlist per subject, published and active, and writes a
   `PlaylistMigration` row per subject. Idempotent: a subject that already
   has a log row is skipped. It writes every playlist it *can* and still
   exits non-zero if any published video had no `subject_id`, so that backlog
   is never silently missed.

5. **Verify** (in the app, as a real student account)

   - The Lectures page lists playlists, each with a sensible lecture count.
   - Opening a playlist lists its lectures in order; a paid playlist is
     refused for a free account and offered for an entitled one.
   - Playback starts on an entitled lecture; ai-summary and ai-chat answer on
     the same lecture and are refused on one in no playlist.
   - As staff: Playlist Management lists the created playlists.

   Re-running `--dry-run` at this point should report `Already migrated
   (skipped, idempotent): N` and `Playlists to create: 0`.

## What the migration grants

Each playlist takes the **union** of its member lectures' `allowed_plans`
(and is **open to every plan** if any member's list was empty, because the old
per-video gate read an empty list as "everyone"), and becomes **free if any
single member was free**. All three rules only ever widen access —
deliberately, so the migration never takes away something a student already
had. The consequence is that it can *give* access:

- a lecture that was gold-only, grouped with a silver lecture, becomes
  reachable on **both** plans;
- a subject with one free lecture becomes a **free playlist**, so every other
  lecture in that subject is now free to everyone.

The dry run prints exactly which lectures those are, per playlist, under
**ACCESS GRANTED BY THIS MIGRATION**. If a grant is wrong, fix it *before*
`--execute` (change the lecture's plans, or unpublish it so it stays out), or
fix the playlist afterwards in Playlist Management.

A lecture whose `allowed_plans` was already empty was reachable on every plan
before the migration, so it is not listed as gaining anything.

## Limits you must know

- **Keyed on `subject_id`.** A subject counts as migrated once it has a
  `PlaylistMigration` row. A video published *after* its subject was migrated
  is **not** picked up by a re-run — re-running is safe, it just does nothing
  for that subject. Add the lecture to its playlist by hand in Video/Playlist
  Management.
- **No name collision check.** The script does not look for an existing
  playlist with the same name. If a curator has already hand-built "ENT", a
  migration of the ENT subject creates a second playlist also called "ENT".
  Check Playlist Management before `--execute` and delete/rename duplicates
  after.
- **Unpublished videos join nothing.** By design (spec §6 step 4). Publish
  them and add them to a playlist by hand, or re-run the migration *before*
  their subject is migrated.
- **Deactivating a lecture is a read-time filter.** It disappears from
  student reads; its playlist item and every watch-progress row survive.

## Only after both migrations are verified

These are separate, later pieces of work and must **not** be done in this
window:

- **Playlists Task 8, Step 3** — dropping `allowed_plans`, `is_free`,
  `is_published` and `order` from the `Video` schema. Those fields are what
  the migration reads; until playlists are in place and verified, they are
  still the record of what a lecture was entitled to.
- **Subject plan, Task 5** — dropping the `subject` display string from
  `Video`. The migration takes each playlist's *name* from it.

Verify first, then schedule those.

## Discussions (added 2026-09-27)

Two new permissions govern lecture discussions:

- **`CanAccessDiscussions`** (label: *Discuss lectures*; resource: StudentPages) — enables students and teachers to read, post, and reply in lecture discussions. Included in the default student and teacher bundles for **new** databases.
- **`CanModerateDiscussions`** (label: *Moderate discussions*; resource: Discussions) — lets teachers pin an answer, hide/unhide posts, see who wrote anonymous posts and view the report queue (posts are never deleted; repeat offenders are muted automatically). Included in the default teacher bundle.

### On an existing database

Roles on an existing database **are not overwritten on restart**. To enable discussions:

1. Navigate to **Roles** in the admin panel, and for each role that should access discussions, tick *Discuss lectures*. Teachers should also tick *Moderate discussions*.
2. Or, run `node scripts/migrateRbac.js --reset-defaults` (from the backend repo root) to re-apply every default bundle to the four default roles. Note this also undoes any permission an admin has unticked on those roles — use it knowingly.

### Data sync

No data migration is required. The `permissions` collection syncs with the backend code on the next restart, so no operator action is needed beyond the permission grants above.
