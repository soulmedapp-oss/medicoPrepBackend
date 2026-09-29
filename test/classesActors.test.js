// Task 3 (spec §2 last row / §4): LiveClass records who scheduled it and who
// last modified it — created_by/updated_by/updated_by_at, the same shape
// Video already has (src/models/Video.js). Stubbed-model handler tests in
// the style of test/rbacMediaControllers.test.js / test/classesLocked.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const LiveClass = require('../src/models/LiveClass');
const User = require('../src/models/User');
const Subject = require('../src/models/Subject');
const AuditLog = require('../src/models/AuditLog');
const SubscriptionPlan = require('../src/models/SubscriptionPlan');

const { createClassesController } = require('../src/controllers/classesController');
const { invalidateEntitlementPlans } = require('../src/utils/entitlement');
const { STUDENT_HIDDEN_CLASS_FIELDS } = require('../src/utils/classProjection');

// Same fixture shape as test/classesLocked.test.js.
const PLANS = [
  { plan_name: 'free', display_name: 'Free', tier: 0, is_active: true },
  { plan_name: 'elite', display_name: 'Elite', tier: 2, is_active: true },
];

const oid = () => new mongoose.Types.ObjectId();

// Chainable, awaitable query stub (style: test/rbacMediaControllers.test.js).
function q(value) {
  const chain = {
    sort: () => chain,
    select: () => chain,
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
test.beforeEach(() => {
  stub(Subject, 'exists', async () => false);
});
test.afterEach(() => {
  while (originals.length) {
    const [obj, key, fn] = originals.pop();
    obj[key] = fn;
  }
  invalidateEntitlementPlans();
});

function controller() {
  return createClassesController({ createNotification: async () => {} });
}

function reqFor(user, extra = {}) {
  return { user, userId: String(user._id), ...extra };
}

const STAFF = {
  _id: oid(),
  email: 'staff@x.com',
  role: 'admin',
  subscription_plan: 'free',
  effective_permissions: ['CanViewClasses', 'CanEditClasses', 'CanDeactivateClasses'],
};

test('createClass: stamps created_by/updated_by/updated_by_at from req.userId', async () => {
  let captured = null;
  stub(LiveClass, 'create', async (payload) => {
    captured = payload;
    return { ...payload, _id: oid(), toObject() { return this; } };
  });
  const res = mockRes();
  await controller().createClass(reqFor(STAFF, {
    body: {
      title: 'Anatomy revision',
      subject: 'Anatomy',
      teacher_name: 'Dr. Rao',
      teacher_email: 'rao@x.com',
      scheduled_date: new Date(Date.now() + 3600_000).toISOString(),
      zoom_meeting_id: 'already-provisioned', // shouldCreateZoomMeeting = false: no Zoom call needed
      create_zoom_meeting: false,
      is_published: false,
    },
  }), res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.ok(captured, 'LiveClass.create was called');
  assert.equal(String(captured.created_by), String(STAFF._id));
  assert.equal(String(captured.updated_by), String(STAFF._id));
  assert.ok(captured.updated_by_at instanceof Date);
});

test('updateClass: stamps updated_by/updated_by_at and leaves created_by untouched', async () => {
  const classId = oid();
  const originalAuthor = oid();
  const existing = {
    _id: classId,
    title: 'Old title',
    is_active: true,
    is_published: true,
    scheduled_date: new Date('2026-01-01'),
    created_by: originalAuthor,
    updated_by: originalAuthor,
  };
  stub(LiveClass, 'findById', () => q(existing));
  let captured = null;
  stub(LiveClass, 'findByIdAndUpdate', (id, update) => {
    captured = update.$set;
    return q({ ...existing, ...captured });
  });
  const res = mockRes();
  await controller().updateClass(reqFor(STAFF, {
    params: { id: String(classId) },
    body: { title: 'New title' },
  }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(captured, '$set was captured');
  assert.equal(String(captured.updated_by), String(STAFF._id));
  assert.ok(captured.updated_by_at instanceof Date);
  assert.equal(Object.prototype.hasOwnProperty.call(captured, 'created_by'), false, 'update never touches created_by');
});

test('deleteClass (deactivate): stamps updated_by/updated_by_at', async () => {
  const classId = oid();
  const originalAuthor = oid();
  stub(AuditLog, 'create', async () => {});
  const doc = {
    _id: classId,
    title: 'Old class',
    is_active: true,
    is_published: true,
    created_by: originalAuthor,
    updated_by: originalAuthor,
    async save() {},
    toObject() {
      const { save, toObject, ...rest } = this;
      return rest;
    },
  };
  stub(LiveClass, 'findById', async () => doc);
  const res = mockRes();
  await controller().deleteClass(reqFor(STAFF, { params: { id: String(classId) } }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(String(doc.updated_by), String(STAFF._id));
  assert.ok(doc.updated_by_at instanceof Date);
  assert.equal(String(doc.created_by), String(originalAuthor), 'created_by is untouched on deactivate');
});

test('listClasses: staff list resolves created_by_name/updated_by_name, null for a missing user', async () => {
  const scheduler = oid();
  const editor = oid();
  const ghost = oid(); // deleted/missing user
  const updatedAt = new Date('2026-02-01');
  stub(LiveClass, 'findByIdAndUpdate', () => q(null));
  stub(LiveClass, 'find', () => q([
    {
      _id: oid(), title: 'Class A', status: 'completed', scheduled_date: new Date(Date.now() - 4 * 3600_000),
      created_by: scheduler, updated_by: editor, updated_by_at: updatedAt,
    },
    {
      _id: oid(), title: 'Class B', status: 'completed', scheduled_date: new Date(Date.now() - 4 * 3600_000),
      created_by: ghost, updated_by: ghost,
    },
  ]));
  stub(User, 'find', () => q([
    { _id: scheduler, full_name: 'Priya Scheduler' },
    { _id: editor, full_name: 'Amit Editor' },
  ]));
  const res = mockRes();
  await controller().listClasses(reqFor(STAFF, { query: { all: 'true' } }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const [rowA, rowB] = res.body.classes;
  assert.equal(rowA.created_by_name, 'Priya Scheduler');
  assert.equal(rowA.updated_by_name, 'Amit Editor');
  assert.deepEqual(rowA.updated_by_at, updatedAt);
  assert.equal(rowB.created_by_name, null, 'missing user resolves to null, not a throw');
  assert.equal(rowB.updated_by_name, null);
});

test('listClasses: student list never carries created_by/updated_by/updated_by_at', async () => {
  assert.deepEqual(
    ['created_by', 'updated_by', 'updated_by_at'].every((f) => STUDENT_HIDDEN_CLASS_FIELDS.includes(f)),
    true,
    'the three actor fields must be in STUDENT_HIDDEN_CLASS_FIELDS'
  );
  stub(SubscriptionPlan, 'find', () => q(PLANS));
  stub(LiveClass, 'findByIdAndUpdate', () => q(null));
  stub(LiveClass, 'find', () => q([
    {
      _id: oid(), title: 'Open class', is_published: true, is_active: true, is_free: true,
      status: 'completed', scheduled_date: new Date(Date.now() - 4 * 3600_000),
      created_by: oid(), updated_by: oid(), updated_by_at: new Date(),
    },
  ]));
  const student = {
    _id: oid(), email: 's@x.com', role: 'student', subscription_plan: 'free',
    effective_permissions: ['CanAccessLiveClasses'],
  };
  const res = mockRes();
  await controller().listClasses(reqFor(student, { query: {} }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const [row] = res.body.classes;
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'created_by'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'updated_by'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'updated_by_at'), false);
});
