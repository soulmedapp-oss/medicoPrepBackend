// Single source of truth for permission codes. Synced to the `permissions`
// collection on startup (see syncPermissions.js). A permission only means
// something once a route or button checks it, so codes are never created in
// the UI.

const ACTION_LABELS = {
  View: 'View', Add: 'Add', Edit: 'Edit', Deactivate: 'Deactivate / reactivate',
};

// crud('Questions', 'questions', ['View','Add']) -> CanViewQuestions, CanAddQuestions
function crud(resource, noun, actions) {
  return actions.map((action) => ({
    code: `Can${action}${resource}`,
    label: `${ACTION_LABELS[action]} ${noun}`,
    description: `Allows the user to ${ACTION_LABELS[action].toLowerCase()} ${noun}.`,
    resource,
  }));
}

const one = (resource, code, label, description) => ({ code, label, description, resource });
const ALL = ['View', 'Add', 'Edit', 'Deactivate'];

const PERMISSIONS = [
  ...crud('Questions', 'questions', ALL),
  one('Questions', 'CanBulkUploadQuestions', 'Bulk upload questions', 'Upload questions to a test from a CSV/XLSX file.'),

  ...crud('QuestionBank', 'question bank items', ALL),
  one('QuestionBank', 'CanBulkUploadQuestionBank', 'Bulk upload question bank', 'Upload question bank items from a CSV/XLSX file.'),

  ...crud('Tests', 'tests', ALL),
  one('Tests', 'CanAssignTestQuestions', 'Assign questions to tests', 'Assign and unassign question bank items on a test.'),
  one('Tests', 'CanViewAllAttempts', 'View all attempts', "See every student's test attempts and reviews."),

  ...crud('Subjects', 'subjects and subtopics', ['Add', 'Edit']),
  one('Subjects', 'CanManageSubjectOwners', 'Manage subject owners', 'Set which staff own a subject.'),

  ...crud('Classes', 'live classes', ALL),
  one('Classes', 'CanHostAnyClass', 'Start any class as host', 'Receive the Zoom host link for every class, not only your own.'),
  ...crud('Videos', 'videos', ALL),

  ...crud('Users', 'users', ALL),
  one('Users', 'CanAssignUserRoles', 'Assign roles to users', 'Add and remove roles on a user.'),

  ...crud('Roles', 'roles', ALL),
  one('Permissions', 'CanViewPermissions', 'View permissions', 'See the list of permissions and which roles hold them.'),
  one('AuditLog', 'CanViewAuditLog', 'View audit log', 'See who changed roles, users, settings and content.'),

  one('Doubts', 'CanViewAllDoubts', 'View all doubts', "See every student's doubts."),
  one('Doubts', 'CanAnswerDoubts', 'Answer doubts', 'Answer doubts and change their status.'),

  one('Feedback', 'CanViewAllFeedback', 'View all feedback', 'See feedback from every user.'),
  one('Feedback', 'CanEditFeedback', 'Edit feedback', 'Reply to feedback and change its status.'),

  one('TeacherRequests', 'CanAccessTeacherRequests', 'File teacher requests', 'Open the teacher requests page and file requests to the platform team.'),
  one('TeacherRequests', 'CanViewAllTeacherRequests', 'View all teacher requests', 'See every teacher request.'),
  one('TeacherRequests', 'CanEditTeacherRequests', 'Edit teacher requests', 'Approve, schedule or reject teacher requests.'),

  one('Payments', 'CanViewAllPayments', 'View all payments', "See every user's payments."),

  ...crud('Coupons', 'coupons', ALL),
  ...crud('SubscriptionPlans', 'subscription plans', ALL),

  one('Subscriptions', 'CanViewAllSubscriptions', 'View all subscriptions', "See every user's subscriptions."),
  ...crud('Subscriptions', 'subscriptions', ['Add', 'Edit', 'Deactivate']),

  one('Notifications', 'CanSendNotifications', 'Send notifications', 'Send notifications to users.'),

  ...crud('Settings', 'platform settings', ['View', 'Edit']),
  one('AdminDashboard', 'CanViewAdminDashboard', 'View admin dashboard', 'See platform analytics.'),

  // Student-facing page access.
  one('StudentPages', 'CanAccessDashboard', 'Use the student dashboard', 'Open the student dashboard.'),
  one('StudentPages', 'CanAccessTests', 'Take tests', 'Browse and attempt tests.'),
  one('StudentPages', 'CanAccessLiveClasses', 'Attend live classes', 'Browse, join and watch live classes.'),
  one('StudentPages', 'CanAccessVideos', 'Watch videos', 'Browse and watch the video library.'),
  one('StudentPages', 'CanAccessDoubts', 'Ask doubts', 'Post doubts and see your own.'),
  one('StudentPages', 'CanAccessProgress', 'View own progress', 'Open the progress page.'),
  one('StudentPages', 'CanAccessSubscription', 'Manage own subscription', 'Open the subscription page.'),
  one('StudentPages', 'CanAccessPayments', 'View own payments', 'Open the payments page.'),
  one('StudentPages', 'CanAccessFeedback', 'Send feedback', 'Send feedback and see your own.'),
  one('StudentPages', 'CanAccessCommunity', 'Use community', 'Connections, study groups and shared resources.'),
  one('StudentPages', 'CanUseAiTutor', 'Use the AI tutor', 'AI tutor sessions and tutor chat.'),
];

const ALL_CODES = PERMISSIONS.map((p) => p.code);
const PERMISSION_CODES = new Set(ALL_CODES);
const isKnownPermission = (code) => PERMISSION_CODES.has(code);
const codesForResource = (resource) => PERMISSIONS.filter((p) => p.resource === resource).map((p) => p.code);

module.exports = { PERMISSIONS, PERMISSION_CODES, ALL_CODES, isKnownPermission, codesForResource };
