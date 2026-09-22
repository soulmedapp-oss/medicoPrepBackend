const { codesForResource, PERMISSION_CODES } = require('./permissions');

const all = (...resources) => resources.flatMap(codesForResource);
const STUDENT_PAGES = codesForResource('StudentPages');

const LEGACY_PERMISSION_MAP = {
  manage_questions: [...all('Questions', 'QuestionBank'), 'CanAddSubjects', 'CanEditSubjects', 'CanViewTests'],
  manage_tests: [...all('Tests'), 'CanViewQuestions'],
  // CanHostAnyClass (the Zoom HOST link for every class) is withheld here —
  // same idea as CanManageSubjectOwners being absent from manage_questions.
  // Only admins get it by default (via ALL_CODES); an admin can grant it to
  // other roles explicitly.
  manage_classes: all('Classes').filter((code) => code !== 'CanHostAnyClass'),
  manage_videos: all('Videos'),
  manage_students: ['CanViewUsers', 'CanViewAllAttempts'],
  manage_doubts: all('Doubts'),
  manage_feedback: all('Feedback'),
  manage_roles: [...all('Roles', 'Permissions'), 'CanAssignUserRoles'],
  manage_subscriptions: all('SubscriptionPlans', 'Subscriptions'),
  // CanAccessTeacherRequests (filing a request, a student-page-style access
  // permission, not a management one) is withheld here — same idea as
  // CanHostAnyClass being absent from manage_classes. The default teacher
  // role is granted it explicitly below instead.
  manage_teacher_requests: all('TeacherRequests').filter((code) => code !== 'CanAccessTeacherRequests'),
  manage_payments: all('Payments'),
  manage_coupons: all('Coupons'),
  view_analytics: ['CanViewAdminDashboard'],
  view_dashboard: ['CanAccessDashboard'],
  view_tests: ['CanAccessTests'],
  view_live_classes: ['CanAccessLiveClasses'],
  view_videos: ['CanAccessVideos'],
  view_doubts: ['CanAccessDoubts'],
  view_progress: ['CanAccessProgress'],
  view_subscription: ['CanAccessSubscription'],
  view_payments: ['CanAccessPayments'],
  view_feedback: ['CanAccessFeedback'],
  view_community: ['CanAccessCommunity'],
};

function mapLegacyPermissions(codes) {
  const out = new Set();
  (codes || []).forEach((code) => {
    if (PERMISSION_CODES.has(code)) out.add(code);
    else (LEGACY_PERMISSION_MAP[code] || []).forEach((mapped) => out.add(mapped));
  });
  return Array.from(out);
}

const uniq = (list) => Array.from(new Set(list));

// What a fresh database is seeded with, and what the migration tops roles up
// to so nobody loses access they have today (the old staff-only middleware
// let every teacher manage classes/videos; every logged-in user could use
// every student page).
// Community is the one exception (fix round 1, item A): isStudentUser(caller)
// used to keep it students-only regardless of what CanAccessCommunity said;
// now that the hidden role check is gone, the permission itself must be
// withheld from the default teacher role to keep the same students-only
// behavior out of the box (an admin can grant it to teachers explicitly).
const DEFAULT_ROLE_PERMISSIONS = {
  student: uniq(STUDENT_PAGES),
  teacher: uniq([
    ...STUDENT_PAGES.filter((code) => code !== 'CanAccessCommunity'),
    'CanAccessTeacherRequests',
    ...mapLegacyPermissions(['manage_tests', 'manage_questions', 'manage_classes', 'manage_videos', 'manage_doubts', 'manage_students']),
  ]),
  content_writer: uniq(mapLegacyPermissions(['manage_questions'])),
  admin: [],
};

module.exports = { LEGACY_PERMISSION_MAP, mapLegacyPermissions, DEFAULT_ROLE_PERMISSIONS };
