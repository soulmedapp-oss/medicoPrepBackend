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

// Final fix wave C1, layer 3 (the runtime safety net). A PAID plan at tier 0
// would sit at the same tier as free, so every free student would be entitled
// to everything that plan gates — a fail-open paywall. planPitch's startup
// backfill and validatePlanFields stop that being created, but a hand-edited
// document or a direct Mongo write can still reintroduce it, so a plan with a
// price above 0 is floored at tier 1 here, wherever it is read from.
function tierOf(plan) {
  const t = Number(plan?.tier);
  const tier = Number.isFinite(t) && t >= 0 ? t : 0;
  if (tier === 0 && Number(plan?.price) > 0) return 1;
  return tier;
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

// Every spelling of a plan a question's `required_plan` might have been
// stored as: the row's raw case (API-created questions store it verbatim),
// its normalized form, and the legacy alias that means it ("medium" for
// premium, "advance" for ultimate).
function planNameForms(plan) {
  const raw = typeof plan?.plan_name === 'string' ? plan.plan_name.trim() : '';
  const normalized = normalizePlanName(raw);
  const forms = new Set();
  if (raw) forms.add(raw);
  if (normalized) forms.add(normalized);
  Object.entries(ALIASES).forEach(([legacy, target]) => {
    if (normalized && target === normalized) forms.add(legacy);
  });
  return [...forms];
}

// The Mongo condition for a question's `required_plan` that admits exactly the
// questions lockState would unlock for this viewer — questions are filtered in
// the database, so the rule has to be expressed as a query rather than run per
// document.
//
// Tier 0 is a whitelist: free/blank/absent, plus every active tier-0 plan.
// Tier 1+ is a blacklist of the plans ABOVE the viewer, which is what makes an
// unknown or deactivated plan name open from tier 1 up — exactly like
// requiredPlanFor's "a paid plan" (tier 1) fallback, since neither can be
// enumerated as an allowed name.
function questionPlanClause(viewer) {
  const plans = viewer?.plansByName instanceof Map ? [...viewer.plansByName.values()] : [];
  const tier = viewer?.tier || 0;
  if (tier === 0) {
    // `null` also matches a document with no required_plan at all.
    const allowed = new Set(['free', '', null]);
    plans.filter((p) => tierOf(p) === 0).forEach((p) => planNameForms(p).forEach((n) => allowed.add(n)));
    return { $in: [...allowed] };
  }
  const denied = new Set();
  plans.filter((p) => tierOf(p) > tier).forEach((p) => planNameForms(p).forEach((n) => denied.add(n)));
  return { $nin: [...denied] };
}

function upgradeRefusal(lock) {
  return { error: 'Upgrade required', code: 'UPGRADE_REQUIRED', lock };
}

async function getActivePlans() {
  if (cache.value && cache.expiresAt > Date.now()) return cache.value;
  const plans = await SubscriptionPlan.find({ is_active: true }).select('plan_name display_name tier price is_active').lean();
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
  normalizePlanName, buildViewer, tierOf, planTier, requiredPlanFor, lockState, isEntitled,
  questionPlanClause, upgradeRefusal,
  getActivePlans, viewerFor, invalidateEntitlementPlans,
};
