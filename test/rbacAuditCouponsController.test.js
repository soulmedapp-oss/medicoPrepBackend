// Task 11: audit coverage for couponsController.js's deleteCoupon, which had
// no controller-level test at all before this task. Style: test/rbacMediaControllers.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Coupon = require('../src/models/Coupon');
const AuditLog = require('../src/models/AuditLog');

const { createCouponsController } = require('../src/controllers/couponsController');

const oid = () => new mongoose.Types.ObjectId();

function q(value) {
  const chain = {
    sort: () => chain,
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
test.beforeEach(() => {
  stub(AuditLog, 'create', async () => {});
});

function couponsController() { return createCouponsController(); }

test('deleteCoupon: a successful deactivation writes coupon.deactivated with target_* only', async () => {
  const id = oid();
  const coupon = { _id: id, code: 'SAVE10', is_active: true, save: async function save() { return this; }, toObject() { return this; } };
  stub(Coupon, 'findById', () => q(coupon));
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await couponsController().deleteCoupon({ params: { id: String(id) }, user: {} }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(saved, 'an audit entry must be written on success');
  assert.equal(saved.action, 'coupon.deactivated');
  assert.equal(saved.target_type, 'coupon');
  assert.equal(saved.target_label, 'SAVE10');
  assert.equal(saved.before, null);
  assert.equal(saved.after, null);
});

// Fix round 1, Minor 5: the reactivate direction was covered for test /
// question_bank / plan but not for updateCoupon.
test('updateCoupon: reactivating writes coupon.reactivated', async () => {
  const id = oid();
  stub(Coupon, 'findById', () => q({ _id: id, is_active: false, code: 'SAVE10' }));
  stub(Coupon, 'findByIdAndUpdate', () => q({ _id: id, is_active: true, code: 'SAVE10' }));
  let saved;
  stub(AuditLog, 'create', async (doc) => { saved = doc; });
  const res = mockRes();
  await couponsController().updateCoupon({
    params: { id: String(id) }, user: { effective_permissions: ['CanEditCoupons', 'CanDeactivateCoupons'] }, body: { is_active: true },
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(saved);
  assert.equal(saved.action, 'coupon.reactivated');
});

test('deleteCoupon: a not-found coupon writes nothing to the audit log', async () => {
  stub(Coupon, 'findById', () => q(null));
  let auditCalled = false;
  stub(AuditLog, 'create', async () => { auditCalled = true; });
  const res = mockRes();
  await couponsController().deleteCoupon({ params: { id: String(oid()) }, user: {} }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(auditCalled, false);
});
