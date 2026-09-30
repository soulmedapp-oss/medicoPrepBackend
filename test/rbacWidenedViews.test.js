// Controller-level allow/deny tests (Task 8) for the inline checks being
// replaced in usersController.js / doubtsController.js / feedbackController.js /
// teacherRequestsController.js / subscriptionsController.js. Written BEFORE the
// controller edits so each one demonstrates the actual behavior change.
// Style: test/testsAttempts.test.js, test/rbacMediaControllers.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const User = require('../src/models/User');
const Doubt = require('../src/models/Doubt');
const Feedback = require('../src/models/Feedback');
const TeacherRequest = require('../src/models/TeacherRequest');
const Subscription = require('../src/models/Subscription');
const Notification = require('../src/models/Notification');
const ConnectionRequest = require('../src/models/ConnectionRequest');
const StudyGroup = require('../src/models/StudyGroup');
const AuditLog = require('../src/models/AuditLog');
const { createUsersController } = require('../src/controllers/usersController');
const { createDoubtsController } = require('../src/controllers/doubtsController');
const { createFeedbackController } = require('../src/controllers/feedbackController');
const { createTeacherRequestsController } = require('../src/controllers/teacherRequestsController');
const { createSubscriptionsController } = require('../src/controllers/subscriptionsController');
const { createNotificationsController } = require('../src/controllers/notificationsController');
const { createConnectionsController } = require('../src/controllers/connectionsController');
const { createGroupsController } = require('../src/controllers/groupsController');

// Chainable, awaitable query stub (style: test/testsAttempts.test.js).
function q(value) {
  const chain = {
    sort: () => chain,
    select: () => chain,
    skip: () => chain,
    limit: () => chain,
    lean: async () => value,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return chain;
}

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

const originals = [];
function stub(obj, key, fn) {
  originals.push([obj, key, obj[key]]);
  obj[key] = fn;
}
test.afterEach(() => {
  while (originals.length) {
    const [obj, key, fn] = originals.pop();
    obj[key] = fn;
  }
});
// Task 11: recordAudit is now wired into several handlers exercised here
// (usersController.updateUser, subscriptionsController). Default it to a
// silent no-op so pre-existing tests don't hit the real model.
test.beforeEach(() => {
  stub(AuditLog, 'create', async () => {});
});

// --- usersController.listUsers ---

test('GET /users: without CanViewUsers sees only the public teacher directory (sanitized); with it sees everyone (fully sanitized)', async () => {
  const controller = createUsersController();
  const teacher = {
    _id: 't1', full_name: 'Teacher One', email: 'teacher@x.com', role: 'teacher',
    roles: ['teacher'], is_teacher: true, is_active: true, passwordHash: 'secret',
  };
  stub(User, 'find', () => q([teacher]));

  const resPublic = mockRes();
  await controller.listUsers(
    { userId: 'caller1', user: { _id: 'caller1', effective_permissions: [] }, query: {} },
    resPublic
  );
  assert.equal(resPublic.statusCode, 200);
  assert.equal(resPublic.body.users[0].passwordHash, undefined);
  assert.equal(resPublic.body.users[0].is_active, undefined, 'sanitizePublicUser strips fields outside its whitelist');

  const resFull = mockRes();
  await controller.listUsers(
    { userId: 'caller2', user: { _id: 'caller2', effective_permissions: ['CanViewUsers'] }, query: {} },
    resFull
  );
  assert.equal(resFull.statusCode, 200);
  assert.equal(resFull.body.users[0].passwordHash, undefined);
  assert.equal(resFull.body.users[0].is_active, true, 'CanViewUsers holder gets the fully sanitized (non-public) record');
});

// Fix round 1, item C: this is a permission denial, not a generic 403 — it
// must use the standard body { error: 'Permission denied', required: [...] }.
test('GET /users: asking for a role other than teacher without CanViewUsers is a standard Permission denied 403', async () => {
  const controller = createUsersController();
  const res = mockRes();
  await controller.listUsers(
    { userId: 'caller1', user: { _id: 'caller1', effective_permissions: [] }, query: { role: 'admin' } },
    res
  );
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Permission denied', required: ['CanViewUsers'] });
});

// --- usersController.updateUser ---

test('PATCH /users/:id ignores role, roles and permissions', async () => {
  const controller = createUsersController();
  const stored = { _id: 'user1', full_name: 'Old', role: 'student', roles: ['student'], permissions: [], is_active: true };
  stub(User, 'findById', () => q(stored));
  let saved = null;
  stub(User, 'findByIdAndUpdate', (id, updateOps) => {
    saved = updateOps.$set;
    return q({ ...stored, ...updateOps.$set });
  });
  const res = mockRes();
  // Task 17: this route now needs CanEditUsers (or CanDeactivateUsers) — the
  // caller holds CanEditUsers here since the point of this test is the
  // role/roles/permissions stripping, not the deactivate split.
  await controller.updateUser({
    params: { id: 'user1' },
    user: { _id: 'admin1', email: 'admin@x.com', effective_permissions: ['CanEditUsers'] },
    body: { full_name: 'New', role: 'admin', roles: ['admin'], permissions: ['x'] },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(saved.full_name, 'New');
  assert.equal(saved.role, undefined, 'role must be ignored');
  assert.equal(saved.roles, undefined, 'roles must be ignored');
  assert.equal(saved.permissions, undefined, 'permissions must be ignored');
});

// --- doubtsController.listDoubts (widened view: all=true is an EXPLICIT
// opt-in, gated by CanViewAllDoubts; without all=true, everyone — staff
// included — gets only their own records; spec 5.2 / progress.md correction) ---

test('GET /doubts: without all=true, a CanViewAllDoubts holder still gets only their own records', async () => {
  const controller = createDoubtsController({ createNotification: async () => {} });
  const seen = [];
  stub(Doubt, 'find', (filter) => { seen.push(filter); return q([]); });
  await controller.listDoubts({ userId: 'u1', user: { _id: 'u1', effective_permissions: ['CanViewAllDoubts'] }, query: {} }, mockRes());
  assert.ok(JSON.stringify(seen[0]).includes('u1'), 'own records only without all=true');
});

test('GET /doubts: all=true with CanViewAllDoubts is not limited to the caller', async () => {
  const controller = createDoubtsController({ createNotification: async () => {} });
  const seen = [];
  stub(Doubt, 'find', (filter) => { seen.push(filter); return q([]); });
  await controller.listDoubts({ userId: 'u2', user: { _id: 'u2', effective_permissions: ['CanViewAllDoubts'] }, query: { all: 'true' } }, mockRes());
  assert.ok(!JSON.stringify(seen[0]).includes('u2'), 'not limited to the caller when widened');
});

test('GET /doubts: all=true without CanViewAllDoubts is refused', async () => {
  const controller = createDoubtsController({ createNotification: async () => {} });
  const res = mockRes();
  await controller.listDoubts({ userId: 'u3', user: { _id: 'u3', effective_permissions: ['CanAccessDoubts'] }, query: { all: 'true' } }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Permission denied', required: ['CanViewAllDoubts'] });
});

// --- doubtsController.updateDoubt ---

test('PATCH /doubts/:id: a student cannot answer or change status', async () => {
  const controller = createDoubtsController({ createNotification: async () => {} });
  let saved = false;
  const doubt = {
    _id: 'd1', student_id: 'u1', status: 'pending', assigned_teacher_email: '', assigned_teacher_id: null,
    save: async function save() { saved = true; return this; },
    toObject() { return this; },
  };
  stub(Doubt, 'findById', async () => doubt);
  const res = mockRes();
  await controller.updateDoubt({
    params: { id: 'd1' },
    userId: 'u1',
    user: { _id: 'u1', effective_permissions: ['CanAccessDoubts'] },
    body: { answer: 'x', status: 'resolved' },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Permission denied', required: ['CanAnswerDoubts'] });
  assert.equal(saved, false, 'nothing must be saved when the field-restriction check refuses the update');
});

test('PATCH /doubts/:id: a student cannot patch someone else\'s doubt', async () => {
  const controller = createDoubtsController({ createNotification: async () => {} });
  let saved = false;
  const doubt = {
    _id: 'd1', student_id: 'u1', status: 'pending',
    save: async function save() { saved = true; return this; },
    toObject() { return this; },
  };
  stub(Doubt, 'findById', async () => doubt);
  const res = mockRes();
  await controller.updateDoubt({
    params: { id: 'd1' },
    userId: 'u2',
    user: { _id: 'u2', effective_permissions: ['CanAccessDoubts'] },
    body: { topic: 'new topic' },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(saved, false, 'nothing must be saved when a non-owner without CanAnswerDoubts is refused');
});

// --- feedbackController.listFeedback (widened view: all=true opt-in) ---

function feedbackController() {
  return createFeedbackController({
    createNotification: async () => {}, sendSupportEmail: async () => {}, broadcastFeedback: () => {},
  });
}

test('GET /feedback: without all=true, a CanViewAllFeedback holder still gets only their own records', async () => {
  const seen = [];
  stub(Feedback, 'find', (filter) => { seen.push(filter); return q([]); });
  await feedbackController().listFeedback({ userId: 'u1', user: { _id: 'u1', effective_permissions: ['CanViewAllFeedback'] }, query: {} }, mockRes());
  assert.ok(JSON.stringify(seen[0]).includes('u1'), 'own records only without all=true');
});

test('GET /feedback: all=true with CanViewAllFeedback is not limited to the caller', async () => {
  const seen = [];
  stub(Feedback, 'find', (filter) => { seen.push(filter); return q([]); });
  await feedbackController().listFeedback({ userId: 'u2', user: { _id: 'u2', effective_permissions: ['CanViewAllFeedback'] }, query: { all: 'true' } }, mockRes());
  assert.ok(!JSON.stringify(seen[0]).includes('u2'), 'not limited to the caller when widened');
});

test('GET /feedback: all=true without CanViewAllFeedback is refused', async () => {
  const res = mockRes();
  await feedbackController().listFeedback({ userId: 'u3', user: { _id: 'u3', effective_permissions: ['CanAccessFeedback'] }, query: { all: 'true' } }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Permission denied', required: ['CanViewAllFeedback'] });
});

// --- teacherRequestsController.listTeacherRequests (widened view: all=true opt-in) ---

function teacherRequestsController() {
  return createTeacherRequestsController({ createNotification: async () => {} });
}

test('GET /teacher-requests: without all=true, a CanViewAllTeacherRequests holder still gets only their own records', async () => {
  const seen = [];
  stub(TeacherRequest, 'find', (filter) => { seen.push(filter); return q([]); });
  await teacherRequestsController().listTeacherRequests({ userId: 'u1', user: { _id: 'u1', effective_permissions: ['CanViewAllTeacherRequests'] }, query: {} }, mockRes());
  assert.ok(JSON.stringify(seen[0]).includes('u1'), 'own records only without all=true');
});

test('GET /teacher-requests: all=true with CanViewAllTeacherRequests is not limited to the caller', async () => {
  const seen = [];
  stub(TeacherRequest, 'find', (filter) => { seen.push(filter); return q([]); });
  await teacherRequestsController().listTeacherRequests({ userId: 'u2', user: { _id: 'u2', effective_permissions: ['CanViewAllTeacherRequests'] }, query: { all: 'true' } }, mockRes());
  assert.ok(!JSON.stringify(seen[0]).includes('u2'), 'not limited to the caller when widened');
});

test('GET /teacher-requests: all=true without CanViewAllTeacherRequests is refused', async () => {
  const res = mockRes();
  await teacherRequestsController().listTeacherRequests({ userId: 'u3', user: { _id: 'u3', effective_permissions: [] }, query: { all: 'true' } }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Permission denied', required: ['CanViewAllTeacherRequests'] });
});

// --- subscriptionsController.listSubscriptions (widened view; route moves in
// Task 9, controller change is this task's per the brief) ---

function subscriptionsController() {
  return createSubscriptionsController({
    createNotification: async () => {},
    getPlansCache: () => null,
    setPlansCache: () => {},
    clearPlansCache: () => {},
  });
}

test('GET /subscriptions: without all=true, a CanViewAllSubscriptions holder still gets only their own records', async () => {
  const seen = [];
  stub(Subscription, 'find', (filter) => { seen.push(filter); return q([]); });
  await subscriptionsController().listSubscriptions({ userId: 'u1', user: { _id: 'u1', effective_permissions: ['CanViewAllSubscriptions'] }, query: {} }, mockRes());
  assert.ok(JSON.stringify(seen[0]).includes('u1'), 'own records only without all=true');
});

test('GET /subscriptions: all=true with CanViewAllSubscriptions is not limited to the caller', async () => {
  const seen = [];
  stub(Subscription, 'find', (filter) => { seen.push(filter); return q([]); });
  await subscriptionsController().listSubscriptions({ userId: 'u2', user: { _id: 'u2', effective_permissions: ['CanViewAllSubscriptions'] }, query: { all: 'true' } }, mockRes());
  assert.ok(!JSON.stringify(seen[0]).includes('u2'), 'not limited to the caller when widened');
});

test('GET /subscriptions: all=true without CanViewAllSubscriptions is refused', async () => {
  const res = mockRes();
  await subscriptionsController().listSubscriptions({ userId: 'u3', user: { _id: 'u3', effective_permissions: ['CanAccessSubscription'] }, query: { all: 'true' } }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Permission denied', required: ['CanViewAllSubscriptions'] });
});

// --- notificationsController.updateNotification (pre-review correction: the
// route is selfService — own records only; no admin bypass, no permission
// fits "manage any notification", and nothing in the app uses it) ---

test('PATCH /notifications/:id: an admin cannot update a notification addressed to someone else', async () => {
  const controller = createNotificationsController({ createNotification: async () => {} });
  const notification = {
    _id: 'n1', user_email: 'other@x.com', is_read: false,
    save: async function save() { return this; },
    toObject() { return this; },
  };
  stub(Notification, 'findById', async () => notification);
  const res = mockRes();
  await controller.updateNotification({
    params: { id: 'n1' },
    user: { _id: 'admin1', email: 'admin@x.com', role_names: ['admin'], effective_permissions: [] },
    body: { is_read: true },
  }, res);
  assert.equal(res.statusCode, 403);
});

test('PATCH /notifications/:id: an admin can update their own notification', async () => {
  const controller = createNotificationsController({ createNotification: async () => {} });
  const notification = {
    _id: 'n2', user_email: 'admin@x.com', is_read: false,
    save: async function save() { return this; },
    toObject() { return this; },
  };
  stub(Notification, 'findById', async () => notification);
  const res = mockRes();
  await controller.updateNotification({
    params: { id: 'n2' },
    user: { _id: 'admin1', email: 'admin@x.com', role_names: ['admin'], effective_permissions: [] },
    body: { is_read: true },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.notification.is_read, true);
});

// --- teacherRequestsController.createTeacherRequest (pre-review correction,
// item 2): the role-name check ('teacher' literal) is replaced by the new
// CanAccessTeacherRequests permission at the ROUTE level; the controller no
// longer makes this decision at all. ---

test('POST /teacher-requests: createTeacherRequest no longer refuses a caller without the literal "teacher" role name', async () => {
  const controller = createTeacherRequestsController({ createNotification: async () => {} });
  stub(TeacherRequest, 'create', async (doc) => ({ ...doc, toObject() { return this; } }));
  const res = mockRes();
  await controller.createTeacherRequest({
    userId: 'u1',
    user: { _id: 'u1', email: 'x@y.com', full_name: 'X', role_names: ['student'], effective_permissions: ['CanAccessTeacherRequests'] },
    body: { title: 'A suggestion', description: 'A long enough description here.' },
  }, res);
  assert.equal(res.statusCode, 201);
});

// --- Fix round 1, item A: isStudentUser(caller) was a hidden role check
// deciding CALLER access in connectionsController.createRequest/listStudents
// and groupsController.createGroup — the route's authorize('CanAccessCommunity')
// is now the only access decision on the caller. The TARGET-side checks
// (is the OTHER person a student?) are unchanged. ---

function connectionsController(overrides = {}) {
  return createConnectionsController({
    createNotification: async () => {},
    isStudentUser: (u) => !u?.role || u.role === 'student',
    ...overrides,
  });
}

// Note: Mongoose's Model.findById(id) is implemented as this.findOne({_id:
// id}) internally (node_modules/mongoose/lib/model.js), so stubbing
// User.findOne also intercepts the old code's User.findById(req.userId) call
// for the caller. These stubs are filter-aware (keyed by _id) so the caller
// and target resolve to distinct records regardless of which of the two
// methods old vs. new code happens to call.

test('POST /connections/request: a teacher caller (CanAccessCommunity) is no longer refused "Student access required"', async () => {
  const targetId = new mongoose.Types.ObjectId();
  const caller = {
    _id: new mongoose.Types.ObjectId(), email: 'teacher@x.com', full_name: 'Teacher',
    role: 'teacher', effective_permissions: ['CanAccessCommunity'],
  };
  stub(User, 'findOne', (filter) => {
    if (String(filter._id) === String(targetId)) {
      return q({ _id: targetId, email: 'target@x.com', full_name: 'Target', role: 'student', is_active: true });
    }
    return q({ _id: caller._id, email: caller.email, full_name: caller.full_name, role: caller.role, is_active: true });
  });
  stub(ConnectionRequest, 'findOne', async () => null);
  stub(ConnectionRequest, 'create', async (doc) => ({ ...doc, toObject() { return this; } }));
  const res = mockRes();
  await connectionsController().createRequest(
    { userId: String(caller._id), user: caller, body: { target_user_id: String(targetId) } },
    res
  );
  assert.equal(res.statusCode, 201, `expected the request to proceed to target validation, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
});

test('POST /connections/request: a non-student TARGET is still refused (target-side check unchanged)', async () => {
  const targetId = new mongoose.Types.ObjectId();
  const caller = {
    _id: new mongoose.Types.ObjectId(), email: 'student@x.com',
    role: 'student', effective_permissions: ['CanAccessCommunity'],
  };
  stub(User, 'findOne', (filter) => {
    if (String(filter._id) === String(targetId)) {
      return q({ _id: targetId, email: 'teacher-target@x.com', role: 'teacher', is_active: true });
    }
    return q({ _id: caller._id, email: caller.email, role: caller.role, is_active: true });
  });
  const res = mockRes();
  await connectionsController().createRequest(
    { userId: String(caller._id), user: caller, body: { target_user_id: String(targetId) } },
    res
  );
  assert.equal(res.statusCode, 404);
});

test('GET /students: a teacher caller (CanAccessCommunity) is no longer refused "Student access required"', async () => {
  const caller = { _id: new mongoose.Types.ObjectId(), role: 'teacher', effective_permissions: ['CanAccessCommunity'] };
  stub(User, 'find', () => q([]));
  // Old code's User.findById(req.userId) aliases to User.findOne internally.
  stub(User, 'findOne', () => q({ _id: caller._id, role: caller.role, is_active: true }));
  const res = mockRes();
  await connectionsController().listStudents({ userId: String(caller._id), user: caller, query: {} }, res);
  assert.equal(res.statusCode, 200);
});

// Fix round 1, item A completion: the per-member loop's isStudentUser check
// (kept per the original ruling as a TARGET-side check) was ALSO applying to
// the CREATOR's own id (uniqueIds starts with it) — a caller-side check
// arriving by another door. Corrected: the student check now applies only to
// the OTHER members; a missing/inactive record is still an error for anyone,
// creator included.

function groupsController(overrides = {}) {
  return createGroupsController({
    createNotification: async () => {},
    hasAcceptedConnection: async () => true,
    isStudentUser: (u) => !u?.role || u.role === 'student',
    ...overrides,
  });
}

test('POST /groups: a teacher caller (CanAccessCommunity) with no other members succeeds, as the group\'s sole admin member', async () => {
  const caller = {
    _id: new mongoose.Types.ObjectId(), email: 'teacher@x.com', full_name: 'Teacher',
    role: 'teacher', effective_permissions: ['CanAccessCommunity'],
  };
  stub(User, 'findOne', () => q({ _id: caller._id, email: caller.email, full_name: caller.full_name, role: caller.role, is_active: true }));
  stub(StudyGroup, 'create', async (doc) => ({ ...doc, toObject() { return this; } }));
  const res = mockRes();
  await groupsController().createGroup({ userId: String(caller._id), user: caller, body: { name: 'Study Group A' } }, res);
  assert.equal(res.statusCode, 201, `expected the group to be created, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.group.members.length, 1);
  assert.equal(String(res.body.group.members[0].user_id), String(caller._id));
  assert.equal(res.body.group.members[0].role, 'admin');
});

test('POST /groups: a teacher caller adding a non-student OTHER member is still refused "Student not found"', async () => {
  const caller = {
    _id: new mongoose.Types.ObjectId(), email: 'teacher@x.com', full_name: 'Teacher',
    role: 'teacher', effective_permissions: ['CanAccessCommunity'],
  };
  const otherId = new mongoose.Types.ObjectId();
  stub(User, 'findOne', (filter) => {
    if (String(filter._id) === String(otherId)) {
      return q({ _id: otherId, email: 'other-teacher@x.com', role: 'teacher', is_active: true });
    }
    return q({ _id: caller._id, email: caller.email, full_name: caller.full_name, role: caller.role, is_active: true });
  });
  stub(StudyGroup, 'create', async (doc) => ({ ...doc, toObject() { return this; } }));
  const res = mockRes();
  await groupsController().createGroup(
    { userId: String(caller._id), user: caller, body: { name: 'Study Group A', member_ids: [String(otherId)] } },
    res
  );
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'Student not found' });
});

test('POST /groups: a creator whose own record is missing/inactive is still refused "Student not found"', async () => {
  const caller = {
    _id: new mongoose.Types.ObjectId(), email: 'teacher@x.com', full_name: 'Teacher',
    role: 'teacher', effective_permissions: ['CanAccessCommunity'],
  };
  stub(User, 'findOne', () => q(null));
  const res = mockRes();
  await groupsController().createGroup({ userId: String(caller._id), user: caller, body: { name: 'Study Group A' } }, res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'Student not found' });
});
