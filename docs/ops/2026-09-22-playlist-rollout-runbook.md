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

One index change does need an operator action on an existing database: the unique index on `users.nickname_lc` is now a partial index (it indexes string values only, so cleared nicknames cannot collide on `null`). Mongoose will not alter an index that already exists under the same name, so drop the old one once — `db.users.dropIndex('nickname_lc_1')` — and it is recreated with the new definition on the next restart.

## Plan tiers and upgrade pitch (added 2026-09-29)

Locked playlists, classes and tests now show students a lock badge and an
upgrade dialog instead of just disappearing, and entitlement is decided by a
numeric plan **tier** instead of matching plan names one by one.

### What changes on deploy

No data migration. On first start after deploy, `ensurePlanTiers()` fills the
new `tier` field for any plan that doesn't have one yet: a plan priced at 0 or
below gets tier 0, and the paid plans are ranked 1, 2, 3… ordered by
`sort_order`, then by `price`. A plan that already has a tier is left exactly
as it is, so this is idempotent — safe to restart as many times as you like.
Seeded default plans (free/basic/premium/ultimate) get sane tiers and a starter
pitch out of the box.

(It used to copy `sort_order` straight into `tier`. That put every plan sharing
the default `sort_order` of 0 at tier 0 — **including paid ones**, which means
everything they gate would have been unlocked for every free student. Hence the
pre-deploy check below.)

### Pre-deploy check — no paid plan may show tier 0

Run this against the target database before you deploy, and again after the
first start:

```js
db.subscriptionplans.find({ is_active: true }, { plan_name: 1, price: 1, sort_order: 1, tier: 1 })
```

**No paid plan (`price > 0`) may show `tier: 0`.** A paid plan at tier 0 sits at
the same tier as free, so a free student would be entitled to everything it
gates. Three things now stop that, but you still want eyes on the list:

- `ensurePlanTiers()` ranks any plan that has **no** tier at all;
- the Plans API refuses to save a paid plan at tier 0 — "A paid plan needs a
  tier of 1 or more" — on both create and edit;
- at runtime, a priced plan found at tier 0 is *treated* as tier 1 anyway, so
  its content still locks. The server also logs a startup `WARN` naming every
  active paid plan sitting at tier 0. If you see that warning, fix the ladder
  in **Plans**; the safety net is not a resting place.

**Cache lag:** plan tiers and pitches are cached in-process for 60 seconds, per
process. On a multi-process or multi-instance deployment a tier change can take
up to 60 s to be reflected everywhere, and different instances can disagree
during that window. Don't judge a tier edit by one request — wait a minute, and
check on more than one instance if you run several.

### What you do

1. Open **Plans** in the admin panel. Confirm the tier ladder makes sense:
   `free = 0 < basic = 1 < premium = 2 < ultimate = 3`, or your own ordering
   if you use different plan names — what matters is that a cheaper plan has
   a strictly lower `tier` than a more expensive one.
2. For every paid plan, fill in an **Upgrade pitch**: a headline (short —
   this is what students see in the "This is a `<Plan>` feature" dialog), up
   to 6 highlights (icon + one line each), and an optional banner image. A
   plan with no pitch still works, it just shows a generic dialog.

### The semantic change to call out to teachers and admins

**Higher tier now includes everything below it.** A playlist, class, or test
ticked for `premium` only is no longer premium-exclusive — anyone on
`ultimate` (or any tier above premium) can open it too, because entitlement
is now "is your tier high enough", not "is your plan named on this content".
If a piece of content was deliberately meant to be premium-only and off
limits to ultimate students, that is no longer expressible — call this out
before deploy, not after a teacher notices.

A related trap: if a plan named on some content gets deactivated or renamed,
that content does **not** silently unlock. It locks at "a paid plan" (tier 1)
until someone re-ticks the content with a plan that still exists and is
active. Re-tick the affected playlists/classes/tests once the plan situation
is sorted.

Also visible to students immediately: locked playlists, classes, and tests
are no longer hidden from browse/list views. They now show up with a lock
badge and an "Unlock with `<Plan>`" prompt that opens the upgrade dialog. A
locked test additionally can no longer be started — `POST
/tests/:id/attempts` refuses it with the same `UPGRADE_REQUIRED` body used
everywhere else.

### What to check after deploy

- A free student browsing Videos sees a lock badge on a paid playlist; opening it shows the teaser/dialog, not the player.
- The dialog's **View plans** button lands on Subscription with the required plan's card highlighted.
- A premium student can open both premium **and** basic content (higher includes lower); an ultimate student can open everything.
- Editing a plan's pitch (headline/highlights/banner) in admin shows up in the student dialog within about 60 seconds (the plans list is cached).
- Deactivating the only plan a playlist/class/test names locks it as "a paid plan" rather than unlocking it or 500ing.
- A paid plan created without touching **Tier** is refused (or auto-ranked at the next start), and its content still locks: create a paid plan leaving Tier at 0, confirm the save is refused, set a tier of 1 or more, tick it on a playlist, and check a free student sees the lock badge rather than the content.

## Plan features (added 2026-09-30)

Plans now also gate three student-facing features — **AI Tutor**, **AI Summary**,
**Transcript** — the same lock-and-upgrade-dialog machinery as playlists,
classes and tests, applied to tabs on the watch page instead of whole
lectures.

### What changes on deploy

No data migration. On first start after deploy, `ensurePlanFeatures()` seeds
the `features` field for any plan that doesn't have one yet: **free** gets
`['transcript']`, **basic** gets `['transcript', 'ai_summary']`, **premium**
and **ultimate** get all three. This only runs once per plan, keyed on the
plan's stored `plan_name`, and only for a plan that has **no** `features`
field at all — a plan that already has one (even `[]`) is left alone.

The name is normalized before the lookup, the same way the rest of the
paywall normalizes it: case and surrounding space don't matter, and the
legacy spellings are folded in — a plan stored as **medium** gets
premium's set, **advance** gets ultimate's.

A plan the seed doesn't recognize by name — a custom plan you created
yourself, or one renamed away from the seeded defaults (and their
medium/advance aliases) — gets **no** features on deploy, not the seeded
set for whatever it's closest to. It stays feature-locked for everyone
until an operator ticks its Features checkboxes by hand. Check every
active plan's Features after deploy, not just the four seeded ones.

### What you do

Open **Plans** in the admin panel. Each plan has a **Features** section
with one checkbox per feature: **AI Tutor**, **AI Summary**, **Transcript**.
Tick whichever features that plan includes and save. There is no ordering
requirement here (unlike tiers) — features are a flat list per plan, not a
ladder.

### What a student sees

The watch page now shows four tabs under the player: **Discussion | AI
Tutor | AI Summary | Transcript** (Lectures joins them below `xl` width).
A feature not in the student's plan shows its tab with a lock badge naming
the **cheapest active plan that includes it**; opening that tab shows a
locked panel with a **View plans** button that opens the same upgrade
dialog used elsewhere. If no active plan lists the feature at all, the
lock falls back to "a paid plan" (tier 1), same as any other content lock.
Staff (`CanViewVideos`) always see all four tabs unlocked.

AI Summary and Transcript are fetched only when their tab is opened, not
on every lecture load as before.

### Cache lag and re-login

Two caches sit between a Plans-page edit and a student seeing it change:

- The in-process **plans cache** (60 s), same one tiers use — a feature
  tick/untick can take up to a minute to be visible to any given server
  process, longer across instances if you run several.
- The student's **`feature_locks`** are computed once, at login/`getMe`,
  and stored on the client's auth state — not re-fetched on every page
  view. A logged-in student's tabs won't reflect a plan edit until their
  session refreshes `getMe` (a page refresh) or they log in again. Don't
  judge a features edit by an already-open tab in another window.

### Post-deploy checks

- **Every active plan**: open Plans and confirm **Features** is filled in on
  each one, reading the plan's stored `plan_name` (a plan stored as
  **medium** is treated as premium by the seed, **advance** as ultimate; any
  other unrecognized name is seeded with nothing and needs ticking by hand).
- **Free student**: Transcript tab works (cues clickable / text renders);
  AI Tutor and AI Summary tabs show a lock badge, and opening one shows the
  locked panel and upgrade dialog, not the endpoint's content.
- **Premium student**: all four tabs work, including AI Tutor and AI
  Summary.
- **Untick a feature**: in Plans, untick AI Summary on Premium and save;
  after the affected student refreshes (or re-logs in), their AI Summary
  tab shows locked.
- **Manage Live Class**: create or edit a class and confirm **Scheduled
  by** and **Last modified** fill in with the actor's name and timestamp;
  a class created before this deploy shows `—` in both columns.

## Uploads on Amazon S3 (added 2026-09-30)

Thumbnails, plan banners, profile photos, doubt/question images, class
recordings and transcripts are stored either on the server's disk
(`UPLOADS_DIR`, dev only) or in an S3 bucket when `UPLOADS_S3_BUCKET` is set.
Production must use S3: Lambda/Vercel have no persistent disk, and disk files
are outside your backups.

### Folder layout in the bucket

Keys are readable on purpose:

```
thumbnails/lectures/2026/09/20260930-141522-a1b2c3-dr-jindal.jpg
thumbnails/playlists/…      thumbnails/classes/…
plans/banners/…             profiles/…        doubts/…      questions/…
recordings/classes/…        videos/uploads/…  transcripts/classes/…
misc/…                      (only if code ever forgets to name a folder)
```

`<folder>/<year>/<month>/<yyyymmdd-hhmmss>-<6 random hex>-<original name, slugified>.<ext>`.
Files moved from the old disk folder by the migration script sit in the same
folders with a `legacy-` prefix; unreferenced old files go to `misc/legacy/`.

### One-time AWS setup (owner)

1. **Bucket**: S3 → Create bucket, e.g. `soulmed-uploads`, region `ap-south-1`
   (Mumbai). Leave versioning off. Under *Block Public Access* untick
   "Block all public access" (objects must be readable by students' browsers)
   — or keep it blocked and put CloudFront in front (step 4).
2. **Bucket policy** (Permissions → Bucket policy), so anyone can *read*
   objects but nobody can list or write:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Sid": "PublicReadObjects",
       "Effect": "Allow",
       "Principal": "*",
       "Action": "s3:GetObject",
       "Resource": "arn:aws:s3:::soulmed-uploads/*"
     }]
   }
   ```
3. **IAM user for the API**: IAM → Users → Create `soulmed-api-uploads`,
   *Attach policies directly* → *Create policy* (JSON):
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject"], "Resource": "arn:aws:s3:::soulmed-uploads/*" },
       { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::soulmed-uploads" }
     ]
   }
   ```
   Then *Security credentials → Create access key → Application running
   outside AWS*. Copy the key id and secret once. (On Lambda, attach the same
   policy to the function's execution role instead and skip the access key.)
4. **Optional CDN**: CloudFront distribution with the bucket as origin
   (Origin access control) and, if you like, a CNAME such as
   `cdn.soulmed.app`. Then keep Block Public Access ON and set
   `UPLOADS_PUBLIC_BASE_URL=https://cdn.soulmed.app`.
5. **Environment on the backend host**:
   ```
   UPLOADS_S3_BUCKET=soulmed-uploads
   UPLOADS_S3_REGION=ap-south-1
   AWS_ACCESS_KEY_ID=…            (not needed on Lambda with a role)
   AWS_SECRET_ACCESS_KEY=…
   UPLOADS_PUBLIC_BASE_URL=       (only with CloudFront / custom domain)
   ```
   Restart. The startup log prints `uploads storage mode=s3 bucket=…`.
6. **Move the existing files** (once, from a machine that has the old
   `uploads` folder and the same env):
   ```
   node src/scripts/migrate-uploads-to-s3.js --dry-run
   node src/scripts/migrate-uploads-to-s3.js --execute
   ```
   It uploads every file a database field points at, rewrites those fields to
   the new URLs, and lists anything missing on disk.

### What to check after deploy

- Upload a lecture thumbnail → the saved URL starts with `https://soulmed-uploads.s3…` (or your CDN) and the image shows on the student Videos page.
- The object appears in the bucket under `thumbnails/lectures/<year>/<month>/`.
- Old thumbnails (migrated) still display; the browser console shows no CSP errors (`img-src https:` and `media-src` already allow the bucket for images; if class recordings are served from S3, add the bucket/CDN host to `media-src` in the frontend `vercel.json`/`index.html`).
- Cost: images are tiny; a few thousand thumbnails cost cents per month. Recordings are the only thing worth watching.
