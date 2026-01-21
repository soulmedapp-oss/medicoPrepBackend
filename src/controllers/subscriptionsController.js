const SubscriptionPlan = require('../models/SubscriptionPlan');
const Subscription = require('../models/Subscription');
const User = require('../models/User');

function createSubscriptionsController({
  createNotification,
  getPlansCache,
  setPlansCache,
  clearPlansCache,
}) {
  async function listPlans(req, res) {
    try {
      const cached = getPlansCache('public');
      if (cached) {
        return res.json({ plans: cached });
      }
      const plans = await SubscriptionPlan.find({ is_active: true })
        .sort({ sort_order: 1 })
        .lean();
      setPlansCache('public', plans);
      return res.json({ plans });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load plans' });
    }
  }

  async function listAllPlans(req, res) {
    try {
      const cached = getPlansCache('all');
      if (cached) {
        return res.json({ plans: cached });
      }
      const plans = await SubscriptionPlan.find({})
        .sort({ sort_order: 1 })
        .lean();
      setPlansCache('all', plans);
      return res.json({ plans });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load plans' });
    }
  }

  async function createPlan(req, res) {
    try {
      const data = req.body || {};
      if (!data.plan_name || !data.display_name) {
        return res.status(400).json({ error: 'plan_name and display_name are required' });
      }
      const existing = await SubscriptionPlan.findOne({ plan_name: data.plan_name });
      if (existing) {
        return res.status(409).json({ error: 'Plan already exists' });
      }
      const plan = await SubscriptionPlan.create(data);
      clearPlansCache();
      return res.status(201).json({ plan });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to create plan' });
    }
  }

  async function updatePlan(req, res) {
    try {
      const updates = req.body || {};
      const plan = await SubscriptionPlan.findByIdAndUpdate(
        req.params.id,
        { $set: updates },
        { new: true }
      ).lean();
      if (!plan) {
        return res.status(404).json({ error: 'Plan not found' });
      }
      clearPlansCache();
      return res.json({ plan });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to update plan' });
    }
  }

  async function deletePlan(req, res) {
    try {
      const plan = await SubscriptionPlan.findById(req.params.id);
      if (!plan) {
        return res.status(404).json({ error: 'Plan not found' });
      }
      plan.is_active = false;
      await plan.save();
      clearPlansCache();
      return res.json({ ok: true, plan: plan.toObject() });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to deactivate plan' });
    }
  }

  async function listSubscriptions(req, res) {
    try {
      const { status, plan, all, limit } = req.query;
      const filter = {};
      if (status) filter.status = status;
      if (plan) filter.plan = plan;

      if (all === 'true') {
        const user = await User.findById(req.userId).lean();
        if (!user || user.role !== 'admin') {
          return res.status(403).json({ error: 'Admin access required' });
        }
      } else {
        filter.user_id = req.userId;
        filter.is_active = true;
      }

      const max = Number(limit) || 100;
      const subscriptions = await Subscription.find(filter)
        .sort({ created_date: -1 })
        .limit(max)
        .lean();

      return res.json({ subscriptions });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load subscriptions' });
    }
  }

  async function createSubscription(req, res) {
    try {
      const data = req.body || {};
      if (!data.plan) {
        return res.status(400).json({ error: 'plan is required' });
      }

      const plan = await SubscriptionPlan.findOne({ plan_name: data.plan, is_active: true }).lean();
      if (!plan) {
        return res.status(400).json({ error: 'Plan is not available' });
      }

      const user = await User.findById(req.userId).lean();
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const startDate = data.start_date ? new Date(data.start_date) : new Date();
      const endDate = data.end_date ? new Date(data.end_date) : new Date(startDate);
      if (!data.end_date) {
        endDate.setMonth(endDate.getMonth() + 1);
      }

      const subscription = await Subscription.create({
        user_id: user._id,
        user_email: user.email,
        user_name: user.full_name || '',
        plan: data.plan,
        status: data.status || 'active',
        start_date: startDate,
        end_date: endDate,
      });

      if (subscription.status === 'active') {
        await User.findByIdAndUpdate(user._id, { $set: { subscription_plan: data.plan } });
        await createNotification({
          userEmail: user.email,
          title: 'Subscription activated',
          message: `Your ${data.plan} plan is now active.`,
          type: 'subscription',
        });
      }

      return res.status(201).json({ subscription });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to create subscription' });
    }
  }

  async function updateSubscription(req, res) {
    try {
      const subscription = await Subscription.findById(req.params.id);
      if (!subscription) {
        return res.status(404).json({ error: 'Subscription not found' });
      }

      const user = await User.findById(req.userId).lean();
      const isAdmin = user?.role === 'admin';
      if (!isAdmin && String(subscription.user_id) !== String(req.userId)) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      const updates = req.body || {};
      const allowed = ['status', 'plan', 'start_date', 'end_date'];
      allowed.forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(updates, field)) {
          subscription[field] = updates[field];
        }
      });

      await subscription.save();

      if (subscription.status === 'active') {
        await User.findByIdAndUpdate(subscription.user_id, { $set: { subscription_plan: subscription.plan } });
      }

      return res.json({ subscription: subscription.toObject() });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to update subscription' });
    }
  }

  async function deleteSubscription(req, res) {
    try {
      const subscription = await Subscription.findById(req.params.id);
      if (!subscription) {
        return res.status(404).json({ error: 'Subscription not found' });
      }
      const user = await User.findById(req.userId).lean();
      const isAdmin = user?.role === 'admin';
      if (!isAdmin && String(subscription.user_id) !== String(req.userId)) {
        return res.status(403).json({ error: 'Not authorized' });
      }
      subscription.is_active = false;
      subscription.status = 'cancelled';
      await subscription.save();
      return res.json({ ok: true, subscription: subscription.toObject() });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to deactivate subscription' });
    }
  }

  return {
    listPlans,
    listAllPlans,
    createPlan,
    updatePlan,
    deletePlan,
    listSubscriptions,
    createSubscription,
    updateSubscription,
    deleteSubscription,
  };
}

module.exports = { createSubscriptionsController };
