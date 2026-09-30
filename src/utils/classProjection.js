// The one student-facing projection for a live-class row, shared by every read
// a student can reach: the class list (classesController.listClasses) and the
// student dashboard's `upcoming_classes`
// (dashboardController.getStudentDashboard).
//
// Final fix wave C2: the dashboard used to return the raw LiveClass documents
// — meeting_link, recording_url and every zoom_* field included — so a free
// student could read the join link for a plan-gated class straight off their
// home page, bypassing the list sanitizer and the /classes/:id/join gate
// entirely. Both reads now go through this file, so they cannot drift again.
//
// Never sent to students in list responses; joining goes through
// GET /classes/:id/join and recordings through GET /classes/:id/recording,
// which enforce the time window / plan checks.
const STUDENT_HIDDEN_CLASS_FIELDS = [
  'meeting_link',
  'recording_url',
  'zoom_recording_files',
  'zoom_recording_password',
  'zoom_start_url',
  'zoom_join_url',
  // Staff provenance (spec §2/§4) — who scheduled/last modified a class is
  // an admin-only detail, same as Video's created_by/updated_by/updated_by_at.
  'created_by',
  'updated_by',
  'updated_by_at',
  // Final fix wave I3: a class transcript is plan-gated content, exactly like
  // a lecture's — which only GET /videos/:id/transcript hands out, and only
  // after a featureLock('transcript') check. The class list shipped both
  // fields inline on every student row, so the whole transcript reached every
  // student with no gate at all, on a locked class as readily as an open one.
  'transcript_text',
  'transcript_url',
  'recording_video_id', // exposed as recording_lecture_id only when ready
];

function sanitizeClassForStudent(liveClass) {
  const sanitized = { ...liveClass };
  const hasZoomRecording = Array.isArray(liveClass.zoom_recording_files) && liveClass.zoom_recording_files.length > 0;
  sanitized.has_recording = Boolean(liveClass.recording_url || liveClass.youtube_url || hasZoomRecording);
  sanitized.has_join_link = Boolean(liveClass.zoom_join_url || liveClass.meeting_link);
  STUDENT_HIDDEN_CLASS_FIELDS.forEach((field) => {
    delete sanitized[field];
  });
  return sanitized;
}

// One student row, lock included. A locked class stays visible — that is the
// whole point of the feature — but it is stripped of join/recording hints on
// top of the usual sanitizer: youtube_url is removed (it plays without any
// server gate) and has_join_link/has_recording report false, since neither is
// usable without the plan. `lock` is null for an open class, and the key is
// always present so the row shape is stable.
function studentClassRow(liveClass, lock, { recordingLectureReady = false } = {}) {
  const row = sanitizeClassForStudent(liveClass);
  // The Bunny copy of a Zoom recording, playable on the lecture watch page.
  // Only advertised once Bunny has finished encoding; until then the Zoom
  // play URL (has_recording) is the fallback.
  row.recording_lecture_id = recordingLectureReady && liveClass.recording_video_id ? String(liveClass.recording_video_id) : null;
  if (row.recording_lecture_id) row.has_recording = true;
  if (lock) {
    delete row.youtube_url;
    row.has_join_link = false;
    row.has_recording = false;
    // The Bunny lecture id is a usable handle on gated content: the watch page
    // takes it straight off this row, and a locked row that still carried it
    // pointed the client at a lecture /videos/:id would only have refused.
    row.recording_lecture_id = null;
  }
  return { ...row, lock: lock || null };
}

module.exports = { STUDENT_HIDDEN_CLASS_FIELDS, sanitizeClassForStudent, studentClassRow };
