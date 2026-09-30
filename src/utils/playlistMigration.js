// Pure: turns already-loaded `Video` rows into the `Playlist` documents the
// videos->playlists migration (spec §6) would create, plus the rows it
// cannot place. No I/O — the migration's judgement calls are testable
// without a database, same shape as subjectResolution.js's resolver.
//
// Deliberately does NOT filter on `is_active`. Deactivating a lecture is a
// read-time filter, never a write to playlist membership (spec §2.2) — an
// inactive-but-published video still gets a playlist item; only
// student-facing reads (visibleItems) hide it later. Skipping an inactive
// video here would be exactly the write-time filtering the spec forbids, so
// `is_active` is accepted as an input field but intentionally unused by the
// grouping/placement logic below.
// Fix round 3, Important 3: the rows that join no playlist are returned as
// TWO lists, not one. `unpublished` is the expected, no-action outcome of
// spec §6 step 4 — an unpublished video is meant to stay out of every
// playlist. `missingSubjectId` is the one that needs an operator: the
// subject backfill has not covered that video yet, so it can never be
// placed until someone runs it. Pooling them meant a perfectly healthy run
// full of drafts exited non-zero and read exactly like a broken one, which
// is the fastest way to teach an operator to ignore the exit code.
function planPlaylistsFromVideos(videos) {
  const rows = Array.isArray(videos) ? videos : [];
  const unpublished = [];
  const missingSubjectId = [];
  // subject_id (stringified) -> { subjectId, subjectName, members: [video] }
  const groups = new Map();

  rows.forEach((video) => {
    // Rule 1: only published videos join a playlist. An unpublished video
    // stays a lecture in no playlist — invisible to students, same
    // effective state as before the migration. Reported here and nowhere
    // else, even when it ALSO lacks a subject_id: while it is unpublished
    // its missing subject_id costs nothing, and counting it twice would
    // make a no-action run exit non-zero.
    if (!video.is_published) {
      unpublished.push({ _id: video._id, subject: video.subject });
      return;
    }
    // Rule 6: a published video with no subject_id (the subject backfill
    // has not run for it yet) can never be defaulted into some playlist.
    if (!video.subject_id) {
      missingSubjectId.push({ _id: video._id, subject: video.subject });
      return;
    }

    const key = String(video.subject_id);
    if (!groups.has(key)) {
      // The subject's display name is taken from the first published
      // member's `subject` string — the name is still stored alongside the
      // id (spec §6 step 1) precisely so a display name is available here
      // without a Subject lookup.
      groups.set(key, { subjectId: video.subject_id, subjectName: video.subject, members: [] });
    }
    groups.get(key).members.push(video);
  });

  const playlists = [];
  const grants = [];
  groups.forEach(({ subjectId, subjectName, members }) => {
    // Rule 3: plans are the UNION across member videos, never the
    // intersection — the migration must never remove access a student
    // already had.
    const plans = new Set();
    // Rule 4: any free member makes the whole playlist free.
    let isFree = false;
    // Rule 3, refined (final review): the per-video gate this migration
    // replaces (canAccessVideo) read an EMPTY or missing allowed_plans as
    // "every plan". A union that ignored that would NARROW such a member to
    // whatever plans its neighbours carried — the one thing rule 3 promises
    // never happens. So one open member makes the whole playlist open:
    // canAccessPlaylist reads [] the same way.
    let isOpen = false;
    members.forEach((video) => {
      const own = Array.isArray(video.allowed_plans) ? video.allowed_plans : [];
      if (own.length === 0) isOpen = true;
      own.forEach((plan) => plans.add(plan));
      if (video.is_free) isFree = true;
    });

    // Rule 5: ordered by the video's existing `order`, then `created_date`,
    // then renumbered contiguously from 0 so the playlist's own ordering is
    // never sparse or tied.
    const items = members
      .slice()
      .sort((a, b) => {
        const orderDiff = (a.order ?? 0) - (b.order ?? 0);
        if (orderDiff !== 0) return orderDiff;
        const aDate = a.created_date ? new Date(a.created_date).getTime() : 0;
        const bDate = b.created_date ? new Date(b.created_date).getTime() : 0;
        return aDate - bDate;
      })
      .map((video, index) => ({ lecture_id: video._id, order: index }));

    const allowedPlans = isOpen ? [] : [...plans];

    // Fix round 3, Rec 2: rules 3 and 4 only ever WIDEN access, which means
    // --execute can hand a student a lecture they could not reach the day
    // before. Work out exactly which lectures that is, so the dry run can
    // say so before anyone types --execute. A member whose own
    // allowed_plans list was EMPTY was already reachable on every plan and
    // cannot gain anything; a plan-restricted member grouped with such an
    // open member gains EVERY plan (gains_open), because the playlist is
    // then open — see isOpen above.
    const grantedLectures = [];
    members.forEach((video) => {
      const own = Array.isArray(video.allowed_plans) ? video.allowed_plans : [];
      const gainsOpen = !isFree && isOpen && own.length > 0;
      const gainsPlans =
        !isFree && !isOpen && own.length ? allowedPlans.filter((plan) => !own.includes(plan)) : [];
      const gainsFree = isFree && video.is_free !== true;
      if (gainsPlans.length || gainsFree || gainsOpen) {
        grantedLectures.push({
          _id: video._id,
          gains_plans: gainsPlans,
          gains_free: gainsFree,
          gains_open: gainsOpen,
        });
      }
    });
    if (grantedLectures.length) {
      grants.push({
        name: subjectName,
        subject_id: subjectId,
        allowed_plans: allowedPlans,
        is_free: isFree,
        lectures: grantedLectures,
      });
    }

    playlists.push({
      name: subjectName,
      subject_ids: [subjectId],
      allowed_plans: allowedPlans,
      is_free: isFree,
      is_published: true,
      is_active: true,
      items,
    });
  });

  return { playlists, unpublished, missingSubjectId, grants };
}

// Pure: classifies an error thrown while inserting a PlaylistMigration row
// during --execute (fix round 2), so the imperative cleanup logic in the
// script can branch on a plain string instead of a raw MongoDB error shape.
// Extracted so this one judgement — "is this a genuine duplicate-key race
// on subject_id, or something else that must NOT be treated as benign" — is
// unit-testable without a database. A MongoDB duplicate-key error carries
// `code === 11000`; anything else (a validation error, a network blip, a
// missing/malformed error object) is 'other' and must propagate rather than
// be silently swallowed as if it were an expected race.
function classifyLogInsertError(err) {
  return err && err.code === 11000 ? 'duplicate' : 'other';
}

module.exports = { planPlaylistsFromVideos, classifyLogInsertError };
