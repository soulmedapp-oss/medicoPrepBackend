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
function studentClassRow(liveClass, lock) {
  const row = sanitizeClassForStudent(liveClass);
  if (lock) {
    delete row.youtube_url;
    row.has_join_link = false;
    row.has_recording = false;
  }
  return { ...row, lock: lock || null };
}

module.exports = { STUDENT_HIDDEN_CLASS_FIELDS, sanitizeClassForStudent, studentClassRow };
