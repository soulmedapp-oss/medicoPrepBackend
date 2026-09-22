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
function planPlaylistsFromVideos(videos) {
  const rows = Array.isArray(videos) ? videos : [];
  const unmigrated = [];
  // subject_id (stringified) -> { subjectId, subjectName, members: [video] }
  const groups = new Map();

  rows.forEach((video) => {
    // Rule 1: only published videos join a playlist. An unpublished video
    // stays a lecture in no playlist — invisible to students, same
    // effective state as before the migration.
    if (!video.is_published) {
      unmigrated.push({ _id: video._id, subject: video.subject, reason: 'not published' });
      return;
    }
    // Rule 6: a published video with no subject_id (the subject backfill
    // has not run for it yet) can never be defaulted into some playlist.
    if (!video.subject_id) {
      unmigrated.push({
        _id: video._id,
        subject: video.subject,
        reason: 'no subject_id (run the subject backfill first)',
      });
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
  groups.forEach(({ subjectId, subjectName, members }) => {
    // Rule 3: plans are the UNION across member videos, never the
    // intersection — the migration must never remove access a student
    // already had.
    const plans = new Set();
    // Rule 4: any free member makes the whole playlist free.
    let isFree = false;
    members.forEach((video) => {
      (Array.isArray(video.allowed_plans) ? video.allowed_plans : []).forEach((plan) => plans.add(plan));
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

    playlists.push({
      name: subjectName,
      subject_ids: [subjectId],
      allowed_plans: [...plans],
      is_free: isFree,
      is_published: true,
      is_active: true,
      items,
    });
  });

  return { playlists, unmigrated };
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
