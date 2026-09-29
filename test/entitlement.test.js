const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePlanName, buildViewer, tierOf, planTier, requiredPlanFor, lockState, isEntitled, questionPlanClause, upgradeRefusal, viewerFor, invalidateEntitlementPlans } = require('../src/utils/entitlement');
const SubscriptionPlan = require('../src/models/SubscriptionPlan');

const PLANS = [
  { plan_name: 'free', display_name: 'Free', tier: 0, is_active: true },
  { plan_name: 'premium', display_name: 'Premium', tier: 2, is_active: true },
  { plan_name: 'elite', display_name: 'Elite', tier: 3, is_active: true },
  { plan_name: 'basic', display_name: 'Basic', tier: 1, is_active: true },
];
const viewer = (plan) => buildViewer({ subscription_plan: plan }, PLANS);

test('normalizePlanName: lower-cases, maps legacy aliases, empty for nothing', () => {
  assert.equal(normalizePlanName('Premium'), 'premium');
  assert.equal(normalizePlanName('medium'), 'premium');
  assert.equal(normalizePlanName('advance'), 'ultimate');
  assert.equal(normalizePlanName(undefined), '');
});

test('planTier: known plan → its tier; unknown, deactivated or missing → 0; undefined tier → 0', () => {
  assert.equal(planTier('elite', PLANS), 3);
  assert.equal(planTier('gold', PLANS), 0);
  assert.equal(planTier('', PLANS), 0);
  assert.equal(planTier('x', [{ plan_name: 'x', is_active: true }]), 0);
});

test('requiredPlanFor: free/open items → null; otherwise the cheapest named plan; missing plans → tier-1 fallback', () => {
  assert.equal(requiredPlanFor({ is_free: true, allowed_plans: ['elite'] }, PLANS), null);
  assert.equal(requiredPlanFor({ allowed_plans: [] }, PLANS), null);
  assert.equal(requiredPlanFor({ required_plan: 'free' }, PLANS), null);
  assert.deepEqual(requiredPlanFor({ allowed_plans: ['elite', 'premium'] }, PLANS), { plan_name: 'premium', display_name: 'Premium', tier: 2 });
  assert.deepEqual(requiredPlanFor({ required_plan: 'medium' }, PLANS), { plan_name: 'premium', display_name: 'Premium', tier: 2 }, 'alias on content');
  assert.deepEqual(requiredPlanFor({ allowed_plans: ['gold'] }, PLANS), { plan_name: '', display_name: 'a paid plan', tier: 1 }, 'never silently unlock');
});

test('lockState: higher tier includes lower; equal tier entitled; below → lock object', () => {
  const item = { allowed_plans: ['premium'] };
  assert.equal(lockState(item, viewer('elite')), null);
  assert.equal(lockState(item, viewer('premium')), null);
  assert.deepEqual(lockState(item, viewer('basic')), { required_plan: 'premium', required_label: 'Premium', required_tier: 2 });
  assert.deepEqual(lockState(item, viewer('free')), { required_plan: 'premium', required_label: 'Premium', required_tier: 2 });
  assert.equal(isEntitled(item, viewer('free')), false);
  assert.equal(lockState({ is_free: true }, viewer('free')), null);
});

test('lockState: a viewer on a deactivated/unknown plan is tier 0', () => {
  assert.equal(lockState({ allowed_plans: ['basic'] }, viewer('advance')).required_plan, 'basic', 'advance → ultimate, but ultimate is not an active plan here → tier 0');
  assert.equal(lockState({ allowed_plans: ['basic'] }, viewer(undefined)).required_tier, 1);
});

test('upgradeRefusal: the uniform 403 body', () => {
  assert.deepEqual(upgradeRefusal({ required_plan: 'elite', required_label: 'Elite', required_tier: 3 }),
    { error: 'Upgrade required', code: 'UPGRADE_REQUIRED', lock: { required_plan: 'elite', required_label: 'Elite', required_tier: 3 } });
});

// Fix round 1: questions are filtered in Mongo, so the tier rule has to be a
// query. questionPlanClause must admit exactly what lockState would unlock.
test('tierOf: reads the plan tier, coercing anything unusable to 0', () => {
  assert.equal(tierOf({ tier: 3 }), 3);
  assert.equal(tierOf({ tier: '2' }), 2);
  assert.equal(tierOf({}), 0);
  assert.equal(tierOf({ tier: -1 }), 0);
  assert.equal(tierOf(undefined), 0);
});

test('questionPlanClause: a tier-0 viewer gets a whitelist of free/blank/absent plus every tier-0 plan', () => {
  const clause = questionPlanClause(buildViewer({ subscription_plan: 'free' }, PLANS));
  assert.deepEqual(clause, { $in: ['free', '', null] });
  assert.equal(clause.$in.includes(undefined), false, 'undefined is not a stored value');
  // A second tier-0 plan, stored raw-cased, appears in both spellings.
  const withTrial = questionPlanClause(buildViewer({ subscription_plan: 'free' },
    [...PLANS, { plan_name: 'Trial', display_name: 'Trial', tier: 0, is_active: true }]));
  assert.deepEqual(withTrial, { $in: ['free', '', null, 'Trial', 'trial'] });
});

test('questionPlanClause: a paying viewer gets a blacklist of only the plans above them, in every stored spelling', () => {
  const plans = [
    { plan_name: 'premium', display_name: 'Premium', tier: 2, is_active: true },
    { plan_name: 'ultimate', display_name: 'Ultimate', tier: 3, is_active: true },
    { plan_name: 'Gold', display_name: 'Gold', tier: 1, is_active: true },
  ];
  const clause = questionPlanClause(buildViewer({ subscription_plan: 'premium' }, plans));
  assert.deepEqual(clause.$nin.sort(), ['advance', 'ultimate'], 'only the tier-3 plan, plus its legacy alias');
  assert.equal(clause.$nin.includes('premium'), false, "the viewer's own tier is not excluded");
  assert.equal(clause.$nin.includes('Gold'), false, 'a lower tier is included, raw case and all');
});

test('questionPlanClause: the raw stored case of an excluded plan is denied too', () => {
  const plans = [
    { plan_name: 'Basic', display_name: 'Basic', tier: 1, is_active: true },
    { plan_name: 'Ultimate', display_name: 'Ultimate', tier: 3, is_active: true },
  ];
  const clause = questionPlanClause(buildViewer({ subscription_plan: 'Basic' }, plans));
  assert.deepEqual(clause.$nin.sort(), ['Ultimate', 'advance', 'ultimate']);
});

// The counterpart of requiredPlanFor's tier-1 "a paid plan" fallback: a plan
// name no active row defines cannot be enumerated, so a blacklist is what lets
// it open from tier 1 up while still locking at tier 0.
test('questionPlanClause: a question on an unknown or deactivated plan is reachable from tier 1, never at tier 0', () => {
  const atTier1 = questionPlanClause(buildViewer({ subscription_plan: 'basic' }, PLANS));
  assert.equal(atTier1.$nin.includes('platinum'), false, 'nothing excludes it, so the query matches it');
  const atTier0 = questionPlanClause(buildViewer({ subscription_plan: 'free' }, PLANS));
  assert.equal(atTier0.$in.includes('platinum'), false, 'the whitelist never admits it');
});

test('questionPlanClause: a viewer with no plans loaded is treated as tier 0', () => {
  assert.deepEqual(questionPlanClause(undefined), { $in: ['free', '', null] });
  assert.deepEqual(questionPlanClause({ tier: 0 }), { $in: ['free', '', null] });
});

// Final fix wave C1, layer 3: the runtime safety net. If a paid plan somehow
// reaches the database at tier 0 anyway — a hand-edited document, a direct
// Mongo update, a row created before the validation landed — treating it as
// tier 0 would hand every free student everything that plan gates (the plan's
// own subscribers and free users would sit at the same tier). tierOf floors a
// priced plan at 1 instead, so the content still locks.
test('tierOf: a plan with a price above 0 is never tier 0 — it floors at 1', () => {
  assert.equal(tierOf({ plan_name: 'elite', price: 999, tier: 0 }), 1);
  assert.equal(tierOf({ plan_name: 'elite', price: '999', tier: 0 }), 1, 'a string price counts');
  assert.equal(tierOf({ plan_name: 'free', price: 0, tier: 0 }), 0, 'a free plan stays at 0');
  assert.equal(tierOf({ plan_name: 'free', tier: 0 }), 0, 'no price at all stays at 0');
  assert.equal(tierOf({ plan_name: 'elite', price: 999, tier: 3 }), 3, 'a real tier is never overridden');
});

test('lockState: content gated on a mis-tiered paid plan still locks, at required_tier 1', () => {
  const plans = [
    { plan_name: 'free', display_name: 'Free', tier: 0, is_active: true },
    { plan_name: 'elite', display_name: 'Elite', price: 999, tier: 0, is_active: true },
  ];
  const lock = lockState({ allowed_plans: ['elite'] }, buildViewer({ subscription_plan: 'free' }, plans));
  assert.deepEqual(lock, { required_plan: 'elite', required_label: 'Elite', required_tier: 1 });
  // And the plan's own subscriber is at tier 1, so they can still open it.
  assert.equal(lockState({ allowed_plans: ['elite'] }, buildViewer({ subscription_plan: 'elite' }, plans)), null);
});

test('questionPlanClause: a mis-tiered paid plan is excluded from a free viewer whitelist', () => {
  const plans = [
    { plan_name: 'free', display_name: 'Free', tier: 0, is_active: true },
    { plan_name: 'elite', display_name: 'Elite', price: 999, tier: 0, is_active: true },
  ];
  const clause = questionPlanClause(buildViewer({ subscription_plan: 'free' }, plans));
  assert.equal(clause.$in.includes('elite'), false, 'a priced tier-0 plan is not a free-tier plan');
});

// Final re-review residual 1: the price floor in tierOf only works at runtime
// if getActivePlans() actually selects `price`. Every handler test stubs the
// query and ignores the projection, so pin the projection here, through the
// real loader, with a hand-edited tier-0 paid plan.
test('viewerFor: the plans loader selects price, so a paid plan hand-edited to tier 0 still locks its content', async () => {
  const original = SubscriptionPlan.find;
  let selected;
  SubscriptionPlan.find = () => {
    const chain = {
      select: (fields) => { selected = fields; return chain; },
      lean: async () => [
        { plan_name: 'free', display_name: 'Free', tier: 0, price: 0, is_active: true },
        { plan_name: 'elite', display_name: 'Elite', tier: 0, price: 999, is_active: true },
      ],
    };
    return chain;
  };
  try {
    invalidateEntitlementPlans();
    const freeViewer = await viewerFor({ subscription_plan: 'free' });
    assert.match(selected, /\bprice\b/, 'getActivePlans must select price for the tierOf floor');
    assert.deepEqual(lockState({ allowed_plans: ['elite'] }, freeViewer), { required_plan: 'elite', required_label: 'Elite', required_tier: 1 });
    invalidateEntitlementPlans();
    const eliteViewer = await viewerFor({ subscription_plan: 'elite' });
    assert.equal(lockState({ allowed_plans: ['elite'] }, eliteViewer), null, 'the subscriber of that plan still opens it');
  } finally {
    SubscriptionPlan.find = original;
    invalidateEntitlementPlans();
  }
});
