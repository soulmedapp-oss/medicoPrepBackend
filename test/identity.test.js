const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { validateNickname, isValidAvatarId, AVATAR_IDS, DEFAULT_AVATAR_ID, displayNameFor, isDuplicateNicknameError } = require('../src/utils/identity');
const User = require('../src/models/User');
const Role = require('../src/models/Role');
const SubscriptionPlan = require('../src/models/SubscriptionPlan');
const { invalidateEntitlementPlans } = require('../src/utils/entitlement');
const authController = require('../src/controllers/authController');

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
test.afterEach(() => {
  while (originals.length) {
    const [obj, key, fn] = originals.pop();
    obj[key] = fn;
  }
  invalidateEntitlementPlans();
});

test('validateNickname: trims, enforces 2-20 chars, letters/digits/single spaces', () => {
  assert.deepEqual(validateNickname('  Dr Neuron  '), { ok: true, value: 'Dr Neuron', lc: 'dr neuron' });
  assert.equal(validateNickname('a').ok, false);
  assert.equal(validateNickname('x'.repeat(21)).ok, false);
  assert.equal(validateNickname('two  spaces').ok, false);
  assert.equal(validateNickname('bad-char!').ok, false);
  assert.equal(validateNickname(42).ok, false);
});

// Fix round 2, Important 3: the post body is filtered, so the name printed
// above every post must be too, or the filter is bypassed by moving the word
// into the nickname.
test('validateNickname: a profane nickname is refused', () => {
  for (const word of ['Shit', 'fuck off', 'BITCH', 'Dr Chutiya']) {
    const check = validateNickname(word);
    assert.equal(check.ok, false, word);
    assert.equal(check.error, 'Please choose a different nickname', word);
  }
  // An anatomy term is not profanity — the filter is whole-word and small.
  assert.equal(validateNickname('Dr Cocci').ok, true);
});

test('validateNickname: reserved words are refused case-insensitively', () => {
  for (const word of ['admin', 'Teacher', 'SOULMED', 'moderator', 'Anonymous', 'staff', 'support']) {
    assert.equal(validateNickname(word).ok, false, word);
  }
});

test('avatar ids: 24 numbered plus the default; anything else is invalid', () => {
  assert.equal(AVATAR_IDS.length, 25);
  assert.ok(AVATAR_IDS.includes('avatar-01') && AVATAR_IDS.includes('avatar-24') && AVATAR_IDS.includes(DEFAULT_AVATAR_ID));
  assert.equal(isValidAvatarId('avatar-07'), true);
  assert.equal(isValidAvatarId('avatar-25'), false);
  assert.equal(isValidAvatarId('../x.svg'), false);
  assert.equal(isValidAvatarId(''), true, 'empty means "use the default"');
});

test('displayNameFor: nickname, else first name, else Student', () => {
  assert.equal(displayNameFor({ nickname: 'Dr Neuron', full_name: 'Anand Pandey' }), 'Dr Neuron');
  assert.equal(displayNameFor({ nickname: '', full_name: 'Anand Pandey' }), 'Anand');
  assert.equal(displayNameFor({}), 'Student');
});

// Fix round 1, Important 3: isDuplicateNicknameError.
test('isDuplicateNicknameError: recognizes a Mongo duplicate-key error on nickname_lc, and only that', () => {
  assert.equal(isDuplicateNicknameError({ code: 11000, keyPattern: { nickname_lc: 1 } }), true);
  assert.equal(isDuplicateNicknameError({ code: 11000, keyValue: { nickname_lc: 'dr neuron' } }), true);
  assert.equal(isDuplicateNicknameError({ code: 11000, message: 'E11000 duplicate key error collection: db.users index: nickname_lc_1 dup key: { nickname_lc: "dr neuron" }' }), true);
  assert.equal(isDuplicateNicknameError({ code: 11000, keyPattern: { email: 1 } }), false, 'a duplicate on a different field must not match');
  assert.equal(isDuplicateNicknameError({ code: 11001, keyPattern: { nickname_lc: 1 } }), false, 'the wrong error code must not match');
  assert.equal(isDuplicateNicknameError(new Error('boom')), false);
  assert.equal(isDuplicateNicknameError(null), false);
});

// --- authController.updateMe: nickname/avatar_id (Step 10) ---

test('updateMe: a nickname taken by another user (any case) is refused 409, nothing written', async () => {
  const userId = oid();
  stub(User, 'exists', async () => true);
  let updateCalled = false;
  stub(User, 'findByIdAndUpdate', () => { updateCalled = true; return q({ _id: userId }); });

  const req = { userId: String(userId), body: { nickname: 'DR NEURON' } };
  const res = mockRes();
  await authController.updateMe(req, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'That nickname is already taken');
  assert.equal(updateCalled, false, 'findByIdAndUpdate must not be called when the nickname is taken');
});

test('updateMe: a valid unique nickname is stored as typed with its lower-case twin', async () => {
  const userId = oid();
  stub(User, 'exists', async () => false);
  let capturedOps;
  stub(User, 'findByIdAndUpdate', (id, ops) => {
    capturedOps = ops;
    return q({ _id: id, nickname: ops.$set.nickname, nickname_lc: ops.$set.nickname_lc });
  });

  const req = { userId: String(userId), body: { nickname: '  Dr Neuron  ' } };
  const res = mockRes();
  await authController.updateMe(req, res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(capturedOps.$set.nickname, 'Dr Neuron');
  assert.equal(capturedOps.$set.nickname_lc, 'dr neuron');
  // Fix round 1, item 4: the internal uniqueness key never reaches the client.
  assert.equal(res.body.user.nickname_lc, undefined);
});

test('updateMe: an unknown avatar id is refused 400', async () => {
  const userId = oid();
  let updateCalled = false;
  stub(User, 'findByIdAndUpdate', () => { updateCalled = true; return q({ _id: userId }); });

  const req = { userId: String(userId), body: { avatar_id: 'avatar-99' } };
  const res = mockRes();
  await authController.updateMe(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Unknown avatar');
  assert.equal(updateCalled, false, 'findByIdAndUpdate must not be called for an unknown avatar id');
});

// Fix round 2, Minor: `null` from the UI means "back to the default avatar";
// it must be stored as the '' the schema defaults to, not as a null.
test('updateMe: avatar_id null is normalised to an empty string before validation', async () => {
  const userId = oid();
  let capturedOps;
  stub(User, 'findByIdAndUpdate', (id, ops) => { capturedOps = ops; return q({ _id: id, avatar_id: ops.$set.avatar_id }); });

  const res = mockRes();
  await authController.updateMe({ userId: String(userId), body: { avatar_id: null } }, res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(capturedOps.$set.avatar_id, '');
});

// Fix round 1, Important 3: the pre-write check (User.exists) can be won by a
// concurrent request between the check and the write itself; the loser must
// still get 409, not a 500, when Mongo's unique index rejects the write.
test('updateMe: a duplicate-key error from the write itself (lost the uniqueness race) is turned into 409, not 500', async () => {
  const userId = oid();
  stub(User, 'exists', async () => false);
  stub(User, 'findByIdAndUpdate', () => {
    const err = new Error('E11000 duplicate key error collection: db.users index: nickname_lc_1 dup key: { nickname_lc: "dr neuron" }');
    err.code = 11000;
    err.keyPattern = { nickname_lc: 1 };
    throw err;
  });

  const req = { userId: String(userId), body: { nickname: 'Dr Neuron' } };
  const res = mockRes();
  await authController.updateMe(req, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'That nickname is already taken');
});

// --- authController.getMe: feature_locks (Task 2, spec §4) ---
// The client reads feature_locks off /auth/me so a locked watch-page tab can
// render without a second request. The lock shape/keys must exactly match
// entitlement.featureLocksFor.

const PLANS_F = [
  { plan_name: 'free', display_name: 'Free', tier: 0, is_active: true, features: ['transcript'] },
  { plan_name: 'premium', display_name: 'Premium', tier: 2, is_active: true, features: ['ai_tutor', 'ai_summary', 'transcript'] },
];

test('getMe: a non-staff student gets feature_locks with exactly the three catalogue keys, each null|lock per their plan', async () => {
  const userId = oid();
  stub(SubscriptionPlan, 'find', () => q(PLANS_F));
  stub(Role, 'find', () => q([]));
  stub(User, 'findById', () => q({
    _id: userId, role: 'student', roles: ['student'], is_teacher: false, subscription_plan: 'free',
  }));

  const res = mockRes();
  await authController.getMe({ userId: String(userId) }, res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const locks = res.body.user.feature_locks;
  assert.deepEqual(Object.keys(locks).sort(), ['ai_summary', 'ai_tutor', 'transcript']);
  assert.equal(locks.transcript, null, 'free plan lists transcript');
  assert.deepEqual(locks.ai_summary, { required_plan: 'premium', required_label: 'Premium', required_tier: 2 });
  assert.deepEqual(locks.ai_tutor, { required_plan: 'premium', required_label: 'Premium', required_tier: 2 });
});

test('getMe: staff (admin role, which carries CanViewVideos) gets all three feature_locks null regardless of plan', async () => {
  const userId = oid();
  stub(SubscriptionPlan, 'find', () => q(PLANS_F));
  stub(User, 'findById', () => q({
    _id: userId, role: 'admin', roles: ['admin'], is_teacher: false, subscription_plan: 'free',
  }));

  const res = mockRes();
  await authController.getMe({ userId: String(userId) }, res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.user.feature_locks, { ai_tutor: null, ai_summary: null, transcript: null });
});
