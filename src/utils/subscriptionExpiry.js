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

  // Final fix wave I4: callers pass a Mongoose DOCUMENT (authController.login,
  // middlewares/auth), and spreading one copies its internals ($__, _doc,
  // $isNew) instead of its fields — so the payload built from this return
  // value lost _id, full_name, email and the rest on exactly the request where
  // a subscription lapsed. toObject() first; a plain `.lean()` object (no
  // toObject) still spreads as before.
  return {
    ...(typeof user.toObject === 'function' ? user.toObject() : user),
    subscription_plan: 'free',
    subscription_status: 'expired',
  };
}

module.exports = { expireSubscriptionIfNeeded };
