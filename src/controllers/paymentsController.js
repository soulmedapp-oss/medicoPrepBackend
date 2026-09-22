const Coupon = require('../models/Coupon');
const CouponRedemption = require('../models/CouponRedemption');
const Payment = require('../models/Payment');
const Subscription = require('../models/Subscription');
const SubscriptionPlan = require('../models/SubscriptionPlan');
const User = require('../models/User');
const { sendEmail } = require('../services/emailService');
const { computeSubscriptionEndDate } = require('../utils/subscriptionUtils');
const { capLimit } = require('../utils/security');
const {
  createOrder,
  verifyPaymentSignature,
  verifyWebhookSignature,
  fetchPayment,
} = require('../services/razorpayService');

function percentDiscount(amount, percent) {
  const discount = Math.round((amount * percent) / 100);
  return Math.min(discount, amount);
}

function buildReceipt(planName, userId) {
  const suffix = String(userId || '').slice(-8);
  const raw = `plan-${planName}-${suffix}-${Date.now()}`;
  return raw.slice(0, 40);
}

function extractRazorpayError(err) {
  if (!err || typeof err !== 'object') return null;
  const errPayload = err.error || err.errors || err.response?.data;
  if (!errPayload || typeof errPayload !== 'object') return null;
  return {
    code: errPayload.code || errPayload.error_code,
    description: errPayload.description || errPayload.error_description,
    field: errPayload.field,
  };
}

/**
 * Records the coupon redemption for a *paid* payment. Runs only after payment
 * success, so abandoned/failed checkouts never burn a coupon. The unique
 * (coupon_code, user_id) index plus the "already used" check at order creation
 * prevent reuse after a successful payment.
 */
async function redeemCouponForPayment(payment) {
  if (!payment || !payment.coupon_code || payment.coupon_redeemed) return;
  const coupon = await Coupon.findOne({ code: payment.coupon_code }).lean();
  if (!coupon) return;
  let inserted = false;
  try {
    const result = await CouponRedemption.updateOne(
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
    inserted = Boolean(result.upsertedCount);
  } catch (err) {
    if (!err || err.code !== 11000) throw err;
  }
  if (inserted) {
    await Coupon.updateOne({ _id: coupon._id }, { $inc: { uses_total: 1 } });
  }
  await Payment.updateOne({ _id: payment._id }, { $set: { coupon_redeemed: true } });
}

/**
 * Activates the subscription for a paid payment exactly once. The
 * subscription_activated flag is claimed atomically, so concurrent
 * verify + webhook calls cannot both activate. If a downstream step fails the
 * claim is released so a later retry (verify or webhook redelivery) can finish.
 */
async function applyPostPaymentUpdates(payment) {
  if (!payment) return null;
  const claimed = await Payment.findOneAndUpdate(
    { _id: payment._id, status: 'paid', subscription_activated: { $ne: true } },
    { $set: { subscription_activated: true } },
    { new: true }
  );
  if (!claimed) return null;

  let subscription;
  try {
    const plan = await SubscriptionPlan.findOne({ plan_name: claimed.plan }).lean();
    const startDate = new Date();
    const endDate = computeSubscriptionEndDate(plan, startDate);

    await Subscription.updateMany(
      { user_id: claimed.user_id, status: 'active' },
      { $set: { status: 'expired', is_active: false } }
    );

    subscription = await Subscription.create({
      user_id: claimed.user_id,
      user_email: claimed.user_email,
      user_name: claimed.user_name || '',
      plan: claimed.plan,
      status: 'active',
      start_date: startDate,
      end_date: endDate || null,
      payment_id: claimed._id,
    });

    await User.findByIdAndUpdate(claimed.user_id, {
      $set: {
        subscription_plan: claimed.plan,
        subscription_status: 'active',
        subscription_start_date: startDate,
        subscription_end_date: endDate || null,
      },
    });
  } catch (err) {
    await Payment.updateOne(
      { _id: claimed._id },
      { $set: { subscription_activated: false } }
    ).catch(() => {});
    throw err;
  }

  try {
    await redeemCouponForPayment(claimed);
  } catch (err) {
    // The subscription is already active; a coupon bookkeeping failure must not undo it.
    console.error('Coupon redemption failed for payment', String(claimed._id), err);
  }

  return subscription;
}

/** Full refund: deactivate the subscription this payment bought. */
async function revokeSubscriptionForPayment(payment) {
  const result = await Subscription.updateMany(
    { payment_id: payment._id, status: 'active' },
    { $set: { status: 'refunded', is_active: false } }
  );
  let revoked = result.modifiedCount || 0;
  if (!revoked && payment.subscription_activated) {
    // Subscriptions created before payment_id was recorded: match by user + plan.
    const legacy = await Subscription.updateMany(
      { user_id: payment.user_id, plan: payment.plan, status: 'active', payment_id: { $exists: false } },
      { $set: { status: 'refunded', is_active: false } }
    );
    revoked = legacy.modifiedCount || 0;
  }
  if (revoked) {
    await User.updateOne(
      { _id: payment.user_id, subscription_plan: payment.plan },
      {
        $set: {
          subscription_plan: 'free',
          subscription_status: 'inactive',
          subscription_end_date: new Date(),
        },
      }
    );
  }
  return revoked;
}

function applyGatewayDetails(target, entity) {
  target.method = entity?.method || '';
  target.bank = entity?.bank || '';
  target.wallet = entity?.wallet || '';
  target.vpa = entity?.vpa || '';
}

function createPaymentsController() {
  async function createPaymentOrder(req, res) {
    try {
      if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
        return res.status(500).json({
          error: 'Razorpay is not configured',
          correlationId: req.correlationId,
        });
      }
      const { plan: planName, coupon_code } = req.body || {};
      if (!planName || typeof planName !== 'string') {
        return res.status(400).json({ error: 'plan is required' });
      }
      const plan = await SubscriptionPlan.findOne({ plan_name: planName, is_active: true }).lean();
      if (!plan) {
        return res.status(404).json({ error: 'Plan not available' });
      }
      const user = await User.findById(req.userId).lean();
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      let currentPlan = null;
      if (user.subscription_status === 'active' && user.subscription_plan) {
        currentPlan = await SubscriptionPlan.findOne({ plan_name: user.subscription_plan }).lean();
      }

      let coupon = null;
      let discountPercent = 0;
      let discountAmount = 0;
      if (coupon_code) {
        coupon = await Coupon.findOne({ code: String(coupon_code).trim().toUpperCase(), is_active: true }).lean();
        if (!coupon) {
          return res.status(400).json({ error: 'Invalid coupon code' });
        }
        if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
          return res.status(400).json({ error: 'Coupon expired' });
        }
        if (coupon.max_uses_total && coupon.uses_total >= coupon.max_uses_total) {
          return res.status(400).json({ error: 'Coupon usage limit reached' });
        }
        // Redemptions are recorded only after a successful payment, so this
        // blocks reuse once a discounted payment has gone through.
        const alreadyUsed = await CouponRedemption.findOne({
          coupon_code: coupon.code,
          user_id: user._id,
        }).lean();
        if (alreadyUsed) {
          return res.status(400).json({ error: 'Coupon already used' });
        }
        discountPercent = Number(coupon.percent_off || 0);
        if (discountPercent <= 0 || discountPercent > 100) {
          return res.status(400).json({ error: 'Invalid coupon discount' });
        }
        discountAmount = percentDiscount(Number(plan.price || 0), discountPercent);
      }

      const baseAmount = Number(plan.price || 0);
      let payableAmount = baseAmount;
      let upgradeFrom = '';
      if (currentPlan && currentPlan.plan_name !== plan.plan_name) {
        const currentPrice = Number(currentPlan.price || 0);
        if (baseAmount <= currentPrice) {
          return res.status(400).json({ error: 'Only upgrades are allowed' });
        }
        payableAmount = Math.max(0, baseAmount - currentPrice);
        upgradeFrom = currentPlan.plan_name;
      } else if (currentPlan && currentPlan.plan_name === plan.plan_name) {
        return res.status(400).json({ error: 'You already have this plan' });
      }

      discountAmount = percentDiscount(payableAmount, discountPercent);
      const finalAmount = Math.max(0, payableAmount - discountAmount);
      const amountPaise = Math.round(finalAmount * 100);
      if (amountPaise < 100) {
        return res.status(400).json({ error: 'Amount must be at least INR 1' });
      }

      const order = await createOrder({
        amount: amountPaise,
        currency: 'INR',
        receipt: buildReceipt(plan.plan_name, user._id),
        notes: {
          plan: plan.plan_name,
          user_email: user.email,
        },
      });

      const payment = await Payment.create({
        user_id: user._id,
        user_email: user.email,
        user_name: user.full_name || '',
        plan: plan.plan_name,
        amount: finalAmount,
        currency: 'INR',
        status: 'created',
        order_id: order.id,
        coupon_code: coupon?.code || '',
        discount_percent: discountPercent,
        discount_amount: discountAmount,
        base_amount: baseAmount,
        upgrade_from: upgradeFrom,
      });

      return res.json({
        order_id: order.id,
        amount: order.amount,
        currency: order.currency,
        key_id: process.env.RAZORPAY_KEY_ID || '',
        payment_id: payment._id,
        plan: plan.plan_name,
        discount_percent: discountPercent,
        discount_amount: discountAmount,
        base_amount: baseAmount,
        upgrade_from: upgradeFrom,
      });
    } catch (err) {
      // Full details go to the server log only (correlated by id), never to the client.
      const razorpayDetails = extractRazorpayError(err);
      const errorObj = err instanceof Error
        ? err
        : new Error(typeof err === 'object' ? JSON.stringify(err, Object.getOwnPropertyNames(err || {})) : String(err));
      console.error(
        `Payment order failed [${req.correlationId}]`,
        razorpayDetails ? JSON.stringify(razorpayDetails) : '',
        errorObj
      );
      return res.status(500).json({
        error: 'Failed to create payment order',
        correlationId: req.correlationId,
      });
    }
  }

  async function verifyPayment(req, res) {
    try {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ error: 'Missing payment verification data' });
      }
      const payment = await Payment.findOne({
        order_id: String(razorpay_order_id),
        user_id: req.userId,
      });
      if (!payment) {
        return res.status(404).json({ error: 'Payment not found' });
      }
      if (payment.status === 'paid') {
        // Idempotent: finish activation if an earlier attempt failed midway.
        const subscription = await applyPostPaymentUpdates(payment);
        return res.json({ ok: true, status: 'paid', subscription: subscription || undefined });
      }
      if (payment.status === 'refunded' || payment.status === 'partially_refunded') {
        return res.status(400).json({ error: 'Payment was refunded' });
      }

      const valid = verifyPaymentSignature({
        orderId: String(razorpay_order_id),
        paymentId: String(razorpay_payment_id),
        signature: String(razorpay_signature),
      });
      if (!valid) {
        await Payment.updateOne(
          { _id: payment._id, status: { $nin: ['paid', 'refunded', 'partially_refunded'] } },
          { $set: { status: 'failed', error_description: 'Signature verification failed' } }
        );
        return res.status(400).json({ error: 'Payment verification failed' });
      }

      let paymentDetails = null;
      try {
        paymentDetails = await fetchPayment(razorpay_payment_id);
      } catch (err) {
        paymentDetails = null;
      }

      const paidUpdate = {
        status: 'paid',
        payment_id: String(razorpay_payment_id),
        paid_at: new Date(),
      };
      applyGatewayDetails(paidUpdate, paymentDetails);
      await Payment.updateOne(
        { _id: payment._id, status: { $nin: ['paid', 'refunded', 'partially_refunded'] } },
        { $set: paidUpdate }
      );

      const subscription = await applyPostPaymentUpdates(payment);

      if (subscription) {
        try {
          await sendEmail({
            to: payment.user_email,
            subject: 'Payment successful',
            text: `Your payment for ${payment.plan} plan was successful.`,
          });
        } catch (err) {
          console.error('Failed to send payment email:', err);
        }
      }

      return res.json({ ok: true, subscription });
    } catch (err) {
      console.error('Payment verification failed', err);
      return res.status(500).json({ error: 'Failed to verify payment', correlationId: req.correlationId });
    }
  }

  async function listPayments(req, res) {
    try {
      const max = capLimit(req.query.limit, 100, 200);
      const payments = await Payment.find({ user_id: req.userId })
        .sort({ created_date: -1 })
        .limit(max)
        .lean();
      return res.json({ payments });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load payments' });
    }
  }

  async function cancelPayment(req, res) {
    try {
      const payment = await Payment.findOne({ _id: req.params.id, user_id: req.userId });
      if (!payment) {
        return res.status(404).json({ error: 'Payment not found' });
      }
      if (payment.status !== 'created') {
        return res.json({ ok: true, payment: payment.toObject() });
      }
      payment.status = 'cancelled';
      payment.error_description = 'Checkout cancelled';
      await payment.save();
      return res.json({ ok: true, payment: payment.toObject() });
    } catch (err) {
      console.error('Failed to cancel payment', err);
      return res.status(500).json({ error: 'Failed to cancel payment' });
    }
  }

  async function listAllPayments(req, res) {
    try {
      // Admin ledger view: higher default/cap than user-facing lists.
      const max = capLimit(req.query.limit, 1000, 1000);
      const payments = await Payment.find({})
        .sort({ created_date: -1 })
        .limit(max)
        .lean();
      return res.json({ payments });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load payments' });
    }
  }

  async function handleWebhook(req, res) {
    try {
      const signature = req.headers['x-razorpay-signature'];
      const rawBody = req.body?.toString?.() || '';
      if (!verifyWebhookSignature(rawBody, signature)) {
        return res.status(400).send('Invalid signature');
      }
      let payload;
      try {
        payload = JSON.parse(rawBody);
      } catch (err) {
        return res.status(400).json({ error: 'Invalid JSON' });
      }
      const event = payload.event;
      const paymentEntity = payload?.payload?.payment?.entity;
      const orderId = paymentEntity?.order_id;
      if (!orderId) {
        return res.json({ ok: true });
      }
      const payment = await Payment.findOne({ order_id: String(orderId) });
      if (!payment) {
        return res.json({ ok: true });
      }

      if (event === 'payment.failed') {
        // Never downgrade an order that is already paid/refunded (events can arrive out of order).
        const failedUpdate = {
          status: 'failed',
          payment_id: paymentEntity?.id || payment.payment_id,
          error_code: paymentEntity?.error_code || '',
          error_description: paymentEntity?.error_description || '',
        };
        applyGatewayDetails(failedUpdate, paymentEntity);
        await Payment.updateOne(
          { _id: payment._id, status: { $nin: ['paid', 'refunded', 'partially_refunded'] } },
          { $set: failedUpdate }
        );
      }

      if (event === 'payment.captured') {
        if (payment.status !== 'paid') {
          const paidUpdate = {
            status: 'paid',
            payment_id: paymentEntity?.id || payment.payment_id,
            paid_at: new Date(),
          };
          applyGatewayDetails(paidUpdate, paymentEntity);
          await Payment.updateOne(
            { _id: payment._id, status: { $nin: ['paid', 'refunded', 'partially_refunded'] } },
            { $set: paidUpdate }
          );
        }
        await applyPostPaymentUpdates(payment);
      }

      if (event === 'refund.processed') {
        const amountPaise = Number(paymentEntity?.amount || 0);
        const refundedPaise = Number(paymentEntity?.amount_refunded || 0);
        const fullRefund = paymentEntity?.refund_status === 'full'
          || (amountPaise > 0 && refundedPaise >= amountPaise);
        await Payment.updateOne(
          { _id: payment._id },
          { $set: { status: fullRefund ? 'refunded' : 'partially_refunded' } }
        );
        if (fullRefund) {
          await revokeSubscriptionForPayment(payment);
        }
      }
      return res.json({ ok: true });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Webhook failed' });
    }
  }

  return {
    createPaymentOrder,
    verifyPayment,
    listPayments,
    cancelPayment,
    listAllPayments,
    handleWebhook,
  };
}

module.exports = {
  createPaymentsController,
  // exported for unit tests
  applyPostPaymentUpdates,
  redeemCouponForPayment,
  revokeSubscriptionForPayment,
};
