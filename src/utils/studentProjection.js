// The single student-facing projection allowlist for a lecture (Video) row,
// shared by every read a student can reach: the playlist detail view
// (playlistsController.getPlaylist) and the lecture list
// (videosController.listVideos). It lives here, in one place, rather than
// beside either controller, so the two can never drift apart and quietly
// start exposing different amounts of a lecture.
//
// Deliberately excludes:
//   - every bunny_* field (internal Bunny identifiers — a playback token
//     comes only from /videos/:id/playback, never from a list read),
//   - every *_by / *_by_at field (staff-only provenance),
//   - transcript_text (large, and not needed to browse or open a lecture),
//   - allowed_plans / is_free / is_published / order (per-video entitlement
//     and ordering: operator-gated fields that no longer decide anything for
//     a student, since the playlist is the single entitlement gate — spec
//     §5 — and echoing them back would only invite a client to re-implement
//     the gate wrongly).
//
// is_active IS included: the client renders a deactivated lecture
// differently, and it is the same flag the server already filters on.
const STUDENT_LECTURE_FIELDS =
  'title description teacher_name teacher_email subtopic provider video_url processing_status duration_seconds thumbnail_url card_thumbnail_url is_active subject subject_id';

// The seven fields — and only these — a student may see about a playlist,
// plus whatever `extra` the caller legitimately computed (today only
// `lecture_count`, from the browse read). Built key by key rather than by
// deleting from a spread of the stored document, so a field added to the
// Playlist schema later is absent from student reads by default instead of
// arriving the moment it is introduced.
//
// Final fix wave, B6: browsePlaylists spread the whole lean document and
// getPlaylist returned it raw, so every student browse leaked `items` (the
// full lecture-id list, including lectures they cannot reach),
// created_by/updated_by/updated_by_at (staff provenance) and the
// is_published/is_active/created_date/updated_date curation state.
// allowed_plans and is_free stay: they are what the client renders as
// "included in your plan" / "free", and the student is the subject of that
// decision, not a third party. thumbnail_url is a plain display field, the
// same class as name/description — nothing about who curated it or when.
function studentPlaylistView(playlist, extra) {
  if (!playlist) return null;
  const view = {
    _id: playlist._id,
    name: playlist.name,
    description: playlist.description,
    thumbnail_url: playlist.thumbnail_url || '',
    subject_ids: playlist.subject_ids,
    allowed_plans: playlist.allowed_plans,
    is_free: playlist.is_free,
  };
  // Only lecture_count is ever taken from `extra` — spreading it would
  // reopen exactly the leak this function exists to close.
  if (extra && Object.prototype.hasOwnProperty.call(extra, 'lecture_count')) {
    view.lecture_count = extra.lecture_count;
  }
  return view;
}

module.exports = { STUDENT_LECTURE_FIELDS, studentPlaylistView };
