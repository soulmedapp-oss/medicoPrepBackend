const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePlanName, buildViewer, planTier, requiredPlanFor, lockState, isEntitled, upgradeRefusal } = require('../src/utils/entitlement');

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
