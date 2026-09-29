// One entitlement rule for every plan-gated thing (spec §5). Content keeps
// its own fields — `is_free` + `allowed_plans` (playlists, live classes) or
// `is_free` + `required_plan` (tests) — and this file decides, from the
// plans' admin-set `tier`, whether a viewer may open it and, if not, which
// plan is the cheapest way in.
const SubscriptionPlan = require('../models/SubscriptionPlan');

const ALIASES = { medium: 'premium', advance: 'ultimate' };
const FALLBACK_REQUIRED = Object.freeze({ plan_name: '', display_name: 'a paid plan', tier: 1 });
const PLANS_TTL_MS = 60 * 1000;
let cache = { value: null, expiresAt: 0 };

function normalizePlanName(name) {
  const lower = String(name || '').trim().toLowerCase();
  return ALIASES[lower] || lower;
}

function plansByName(plans) {
  return new Map((plans || []).filter((p) => p && p.is_active !== false).map((p) => [normalizePlanName(p.plan_name), p]));
}

function tierOf(plan) {
  const t = Number(plan?.tier);
  return Number.isFinite(t) && t >= 0 ? t : 0;
}

function planTier(planName, plans) {
  const plan = plansByName(plans).get(normalizePlanName(planName));
  return plan ? tierOf(plan) : 0;
}

function buildViewer(user, plans) {
  const planName = normalizePlanName(user?.subscription_plan);
  return { planName, tier: planTier(planName, plans), plansByName: plansByName(plans) };
}

function namedPlans(item) {
  if (Array.isArray(item?.allowed_plans)) return item.allowed_plans.map(normalizePlanName).filter(Boolean);
  const single = normalizePlanName(item?.required_plan);
  return single && single !== 'free' ? [single] : [];
}

function requiredPlanFor(item, plans) {
  if (!item || item.is_free === true) return null;
  const names = namedPlans(item);
  if (names.length === 0) return null;
  const byName = plans instanceof Map ? plans : plansByName(plans);
  const found = names.map((n) => byName.get(n)).filter(Boolean);
  if (found.length === 0) return { ...FALLBACK_REQUIRED };
  const cheapest = found.reduce((a, b) => (tierOf(b) < tierOf(a) ? b : a));
  return { plan_name: normalizePlanName(cheapest.plan_name), display_name: cheapest.display_name || cheapest.plan_name, tier: tierOf(cheapest) };
}

function lockState(item, viewer) {
  const required = requiredPlanFor(item, viewer?.plansByName || new Map());
  if (!required) return null;
  if ((viewer?.tier || 0) >= required.tier) return null;
  return { required_plan: required.plan_name, required_label: required.display_name, required_tier: required.tier };
}

const isEntitled = (item, viewer) => lockState(item, viewer) === null;

function upgradeRefusal(lock) {
  return { error: 'Upgrade required', code: 'UPGRADE_REQUIRED', lock };
}

async function getActivePlans() {
  if (cache.value && cache.expiresAt > Date.now()) return cache.value;
  const plans = await SubscriptionPlan.find({ is_active: true }).select('plan_name display_name tier is_active').lean();
  cache = { value: plans, expiresAt: Date.now() + PLANS_TTL_MS };
  return plans;
}

function invalidateEntitlementPlans() {
  cache = { value: null, expiresAt: 0 };
}

async function viewerFor(user) {
  return buildViewer(user, await getActivePlans());
}

module.exports = {
  normalizePlanName, buildViewer, planTier, requiredPlanFor, lockState, isEntitled, upgradeRefusal,
  getActivePlans, viewerFor, invalidateEntitlementPlans,
};
