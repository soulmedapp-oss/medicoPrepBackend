const Coupon = require('../models/Coupon');
const CouponRedemption = require('../models/CouponRedemption');
const Payment = require('../models/Payment');
const Subscription = require('../models/Subscription');
const SubscriptionPlan = require('../models/SubscriptionPlan');
const User = require('../models/User');
const { sendEmail } = require('../services/emailService');
const { computeSubscriptionEndDate } = require('../utils/subscriptionUtils');
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

async function applyPostPaymentUpdates(payment) {
  if (!payment || payment.subscription_activated) return;
  const plan = await SubscriptionPlan.findOne({ plan_name: payment.plan }).lean();
  const startDate = new Date();
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

  return subscription;
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
      if (!planName) {
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
        coupon = await Coupon.findOne({ code: coupon_code.toUpperCase(), is_active: true }).lean();
        if (!coupon) {
          return res.status(400).json({ error: 'Invalid coupon code' });
        }
        if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
          return res.status(400).json({ error: 'Coupon expired' });
        }
        if (coupon.max_uses_total && coupon.uses_total >= coupon.max_uses_total) {
          return res.status(400).json({ error: 'Coupon usage limit reached' });
        }
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

      if (coupon?.code) {
        await CouponRedemption.updateOne(
          { coupon_code: coupon.code, user_id: user._id },
          {
            $setOnInsert: {
              coupon_code: coupon.code,
              coupon_id: coupon._id,
              user_id: user._id,
              payment_id: payment._id,
            },
          },
          { upsert: true }
        );
      }

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
      const debugEnabled = String(process.env.DEBUG_API_ERRORS || '').toLowerCase() === 'true';
      const razorpayDetails = extractRazorpayError(err);
      const rawDetails = err instanceof Error
        ? err.message
        : (typeof err === 'object' ? JSON.stringify(err, Object.getOwnPropertyNames(err)) : String(err));
      const errorObj = err instanceof Error ? err : new Error(rawDetails);
      console.error(`Payment order failed [${req.correlationId}]`, errorObj);
      const response = {
        error: razorpayDetails?.description || errorObj.message || 'Failed to create payment order',
        correlationId: req.correlationId,
      };
      if (debugEnabled) {
        response.details = rawDetails;
        if (razorpayDetails) {
          response.razorpay = razorpayDetails;
        }
        response.stack = errorObj.stack;
      }
      return res.status(500).json(response);
    }
  }

  async function verifyPayment(req, res) {
    try {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ error: 'Missing payment verification data' });
      }
      const payment = await Payment.findOne({ order_id: razorpay_order_id });
      if (!payment) {
        return res.status(404).json({ error: 'Payment not found' });
      }
      if (payment.status === 'paid') {
        return res.json({ ok: true, status: 'paid' });
      }

      const valid = verifyPaymentSignature({
        orderId: razorpay_order_id,
        paymentId: razorpay_payment_id,
        signature: razorpay_signature,
      });
      if (!valid) {
        payment.status = 'failed';
        payment.error_description = 'Signature verification failed';
        await payment.save();
        return res.status(400).json({ error: 'Payment verification failed' });
      }

      let paymentDetails = null;
      try {
        paymentDetails = await fetchPayment(razorpay_payment_id);
      } catch (err) {
        paymentDetails = null;
      }

      payment.status = 'paid';
      payment.payment_id = razorpay_payment_id;
      payment.paid_at = new Date();
      payment.method = paymentDetails?.method || '';
      payment.bank = paymentDetails?.bank || '';
      payment.wallet = paymentDetails?.wallet || '';
      payment.vpa = paymentDetails?.vpa || '';
      await payment.save();

      const subscription = await applyPostPaymentUpdates(payment);

      try {
        await sendEmail({
          to: payment.user_email,
          subject: 'Payment successful',
          text: `Your payment for ${payment.plan} plan was successful.`,
        });
      } catch (err) {
        console.error('Failed to send payment email:', err);
      }

      return res.json({ ok: true, subscription });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: err.message || 'Failed to verify payment' });
    }
  }

  async function listPayments(req, res) {
    try {
      const payments = await Payment.find({ user_id: req.userId })
        .sort({ created_date: -1 })
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
      const user = await User.findById(req.userId).lean();
      if (!user || user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
      }
      const payments = await Payment.find({})
        .sort({ created_date: -1 })
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
      const payload = JSON.parse(rawBody);
      const event = payload.event;
      const paymentEntity = payload?.payload?.payment?.entity;
      const orderId = paymentEntity?.order_id;
      if (!orderId) {
        return res.json({ ok: true });
      }
      const payment = await Payment.findOne({ order_id: orderId });
      if (!payment) {
        return res.json({ ok: true });
      }
      if (event === 'payment.failed') {
        payment.status = 'failed';
        payment.payment_id = paymentEntity?.id || payment.payment_id;
        payment.method = paymentEntity?.method || '';
        payment.bank = paymentEntity?.bank || '';
        payment.wallet = paymentEntity?.wallet || '';
        payment.vpa = paymentEntity?.vpa || '';
        payment.error_code = paymentEntity?.error_code || '';
        payment.error_description = paymentEntity?.error_description || '';
        await payment.save();
      }
      if (event === 'payment.captured') {
        if (payment.status !== 'paid') {
          payment.status = 'paid';
          payment.payment_id = paymentEntity?.id || payment.payment_id;
          payment.method = paymentEntity?.method || '';
          payment.bank = paymentEntity?.bank || '';
          payment.wallet = paymentEntity?.wallet || '';
          payment.vpa = paymentEntity?.vpa || '';
          payment.paid_at = new Date();
          await payment.save();
        }
        await applyPostPaymentUpdates(payment);
      }
      if (event === 'refund.processed') {
        payment.status = 'refunded';
        await payment.save();
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

module.exports = { createPaymentsController };
