require('dotenv').config();

const mongoose = require('mongoose');
const Coupon = require('../src/models/Coupon');
const CouponRedemption = require('../src/models/CouponRedemption');
const Payment = require('../src/models/Payment');
const Subscription = require('../src/models/Subscription');
const SubscriptionPlan = require('../src/models/SubscriptionPlan');
const User = require('../src/models/User');
const { computeSubscriptionEndDate } = require('../src/utils/subscriptionUtils');

const { MONGODB_URI } = process.env;

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
}

async function applyPayment(payment) {
  if (!payment?.plan) return { skipped: true, reason: 'missing plan' };

  const plan = await SubscriptionPlan.findOne({ plan_name: payment.plan }).lean();
  if (!plan) return { skipped: true, reason: 'plan not found' };

  const startDate = payment.paid_at || payment.created_date || new Date();
  const endDate = computeSubscriptionEndDate(plan, startDate);

  await Subscription.updateMany(
    { user_id: payment.user_id, status: 'active' },
    { $set: { status: 'expired', is_active: false } }
  );

  const subscription = await Subscription.create({
    user_id: payment.user_id,
    user_email: payment.user_email,
    user_name: payment.user_name || '',
    plan: payment.plan,
    status: 'active',
    start_date: startDate,
    end_date: endDate || null,
  });

  await User.findByIdAndUpdate(payment.user_id, {
    $set: {
      subscription_plan: payment.plan,
      subscription_status: 'active',
      subscription_start_date: startDate,
      subscription_end_date: endDate || null,
    },
  });

  if (payment.coupon_code && !payment.coupon_redeemed) {
    const coupon = await Coupon.findOne({ code: payment.coupon_code }).lean();
    if (coupon) {
      await CouponRedemption.updateOne(
        { coupon_code: coupon.code, user_id: payment.user_id },
        {
          $setOnInsert: {
            coupon_code: coupon.code,
            coupon_id: coupon._id,
            user_id: payment.user_id,
            payment_id: payment._id,
          },
        },
        { upsert: true }
      );
      await Coupon.updateOne(
        { _id: coupon._id },
        { $inc: { uses_total: 1 } }
      );
      payment.coupon_redeemed = true;
    }
  }

  payment.subscription_activated = true;
  await payment.save();

  return { skipped: false, subscriptionId: subscription._id };
}

async function main() {
  requireEnv('MONGODB_URI', MONGODB_URI);
  await mongoose.connect(MONGODB_URI, { autoIndex: true });

  const payments = await Payment.find({
    status: 'paid',
    $or: [{ subscription_activated: { $ne: true } }, { subscription_activated: { $exists: false } }],
  })
    .sort({ paid_at: 1, created_date: 1 })
    .lean(false);

  if (payments.length === 0) {
    console.log('No paid payments require backfill.');
    await mongoose.disconnect();
    return;
  }

  let updated = 0;
  let skipped = 0;

  for (const payment of payments) {
    try {
      const result = await applyPayment(payment);
      if (result.skipped) {
        skipped += 1;
        console.log(`Skipped payment ${payment._id}: ${result.reason}`);
      } else {
        updated += 1;
        console.log(`Activated subscription for payment ${payment._id}`);
      }
    } catch (err) {
      skipped += 1;
      console.error(`Failed to backfill payment ${payment._id}:`, err);
    }
  }

  console.log(`Backfill complete. Updated: ${updated}. Skipped: ${skipped}.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
