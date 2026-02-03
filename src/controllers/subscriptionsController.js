const SubscriptionPlan = require('../models/SubscriptionPlan');
const Subscription = require('../models/Subscription');
const User = require('../models/User');
const { computeSubscriptionEndDate } = require('../utils/subscriptionUtils');

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

      const adminUser = req.user || await User.findById(req.userId).lean();
      if (!adminUser || adminUser.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
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
      const endDate = data.end_date ? new Date(data.end_date) : computeSubscriptionEndDate(plan, startDate);

      const subscription = await Subscription.create({
        user_id: user._id,
        user_email: user.email,
        user_name: user.full_name || '',
        plan: data.plan,
        status: data.status || 'active',
        start_date: startDate,
        end_date: endDate || null,
      });

      if (subscription.status === 'active') {
        await User.findByIdAndUpdate(user._id, {
          $set: {
            subscription_plan: data.plan,
            subscription_status: subscription.status,
            subscription_start_date: startDate,
            subscription_end_date: endDate || null,
          },
        });
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

      const user = req.user || await User.findById(req.userId).lean();
      const isAdmin = user?.role === 'admin';
      if (!isAdmin) {
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

      await User.findByIdAndUpdate(subscription.user_id, {
        $set: {
          subscription_plan: subscription.status === 'active' ? subscription.plan : 'free',
          subscription_status: subscription.status,
          subscription_start_date: subscription.start_date,
          subscription_end_date: subscription.end_date || null,
        },
      });

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
      const user = req.user || await User.findById(req.userId).lean();
      const isAdmin = user?.role === 'admin';
      if (!isAdmin) {
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

  async function extendSubscription(req, res) {
    try {
      const { extend_days } = req.body || {};
      const days = Number(extend_days);
      if (!days || Number.isNaN(days) || days <= 0) {
        return res.status(400).json({ error: 'extend_days must be a positive number' });
      }
      const user = await User.findById(req.userId).lean();
      if (!user || user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
      }
      const subscription = await Subscription.findById(req.params.id);
      if (!subscription) {
        return res.status(404).json({ error: 'Subscription not found' });
      }
      const base = subscription.end_date ? new Date(subscription.end_date) : new Date();
      base.setDate(base.getDate() + days);
      subscription.end_date = base;
      subscription.status = 'active';
      await subscription.save();

      await User.findByIdAndUpdate(subscription.user_id, {
        $set: {
          subscription_plan: subscription.plan,
          subscription_status: subscription.status,
          subscription_start_date: subscription.start_date,
          subscription_end_date: subscription.end_date,
        },
      });

      return res.json({ subscription: subscription.toObject() });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to extend subscription' });
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
    extendSubscription,
  };
}

module.exports = { createSubscriptionsController };
