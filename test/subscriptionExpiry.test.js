// Final fix wave I4: expireSubscriptionIfNeeded is called with a Mongoose
// DOCUMENT (authController.login / middlewares/auth both pass one). Spreading
// a document with `...user` copies its internal guts ($__, _doc, $isNew…) and
// NOT the fields, so the caller that builds the response payload from the
// return value lost _id, full_name, email — everything — on exactly the
// request where a subscription lapsed. Convert with toObject() first; a plain
// object (a .lean() read) still spreads as before.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Subscription = require('../src/models/Subscription');
const User = require('../src/models/User');
const { expireSubscriptionIfNeeded } = require('../src/utils/subscriptionExpiry');

const oid = () => new mongoose.Types.ObjectId();

const originals = [];
function stub(obj, key, fn) {
  originals.push([obj, key, obj[key]]);
  obj[key] = fn;
}
test.beforeEach(() => {
  stub(Subscription, 'updateMany', async () => ({}));
  stub(User, 'findByIdAndUpdate', async () => ({}));
});
test.afterEach(() => {
  while (originals.length) {
    const [obj, key, fn] = originals.pop();
    obj[key] = fn;
  }
});

const PAST = new Date(Date.now() - 24 * 3600_000);
const FUTURE = new Date(Date.now() + 24 * 3600_000);

// A stand-in for a Mongoose document: the fields live behind toObject(), and
// the enumerable own properties are the document's own machinery.
function fakeDoc(fields) {
  return {
    _id: fields._id,
    subscription_status: fields.subscription_status,
    subscription_end_date: fields.subscription_end_date,
    $__: { internal: true },
    toObject() { return { ...fields }; },
  };
}

test('expireSubscriptionIfNeeded: an expired document keeps every field, with the plan/status overridden', async () => {
  const _id = oid();
  const user = fakeDoc({
    _id,
    full_name: 'Asha Student',
    email: 'asha@x.com',
    subscription_plan: 'premium',
    subscription_status: 'active',
    subscription_end_date: PAST,
  });

  const result = await expireSubscriptionIfNeeded(user);

  assert.equal(String(result._id), String(_id), 'the payload still identifies the user');
  assert.equal(result.full_name, 'Asha Student');
  assert.equal(result.email, 'asha@x.com');
  assert.equal(result.subscription_plan, 'free');
  assert.equal(result.subscription_status, 'expired');
  assert.equal(Object.prototype.hasOwnProperty.call(result, '$__'), false, 'no document internals leak into the payload');
});

test('expireSubscriptionIfNeeded: writes the expiry through to Mongo exactly once', async () => {
  const _id = oid();
  const subWrites = [];
  const userWrites = [];
  stub(Subscription, 'updateMany', async (filter, update) => { subWrites.push([filter, update]); });
  stub(User, 'findByIdAndUpdate', async (id, update) => { userWrites.push([String(id), update]); });

  await expireSubscriptionIfNeeded(fakeDoc({
    _id, full_name: 'Asha', subscription_plan: 'premium', subscription_status: 'active', subscription_end_date: PAST,
  }));

  assert.equal(subWrites.length, 1);
  assert.deepEqual(subWrites[0][1], { $set: { status: 'expired', is_active: false } });
  assert.equal(userWrites.length, 1);
  assert.deepEqual(userWrites[0][1], { $set: { subscription_plan: 'free', subscription_status: 'expired' } });
});

test('expireSubscriptionIfNeeded: a plain (lean) object still works, and a live subscription is returned untouched', async () => {
  const _id = oid();
  const lean = {
    _id, full_name: 'Plain', subscription_plan: 'premium', subscription_status: 'active', subscription_end_date: PAST,
  };
  const expired = await expireSubscriptionIfNeeded(lean);
  assert.equal(expired.full_name, 'Plain');
  assert.equal(expired.subscription_plan, 'free');

  const live = fakeDoc({ _id, full_name: 'Still paying', subscription_plan: 'premium', subscription_status: 'active', subscription_end_date: FUTURE });
  assert.equal(await expireSubscriptionIfNeeded(live), live, 'an unexpired subscription returns the same object');
  assert.equal(await expireSubscriptionIfNeeded(null), null);
});
