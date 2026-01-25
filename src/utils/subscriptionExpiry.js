const Subscription = require('../models/Subscription');
const User = require('../models/User');

async function expireSubscriptionIfNeeded(user) {
  if (!user) return user;
  if (user.subscription_status !== 'active') return user;
  if (!user.subscription_end_date) return user;
  const endDate = new Date(user.subscription_end_date);
  if (Number.isNaN(endDate.getTime())) return user;
  if (endDate > new Date()) return user;

  await Subscription.updateMany(
    { user_id: user._id, status: 'active' },
    { $set: { status: 'expired', is_active: false } }
  );

  await User.findByIdAndUpdate(user._id, {
    $set: {
      subscription_plan: 'free',
      subscription_status: 'expired',
    },
  });

  return {
    ...user,
    subscription_plan: 'free',
    subscription_status: 'expired',
  };
}

module.exports = { expireSubscriptionIfNeeded };
