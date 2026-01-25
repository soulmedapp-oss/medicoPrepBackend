const Razorpay = require('razorpay');
const crypto = require('crypto');

const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET } = process.env;

let client;
function getRazorpayClient() {
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    throw new Error('Razorpay is not configured');
  }
  if (!client) {
    client = new Razorpay({
      key_id: RAZORPAY_KEY_ID,
      key_secret: RAZORPAY_KEY_SECRET,
    });
  }
  return client;
}

async function createOrder({ amount, currency, receipt, notes }) {
  const razorpay = getRazorpayClient();
  return razorpay.orders.create({
    amount,
    currency,
    receipt,
    notes,
  });
}

function verifyPaymentSignature({ orderId, paymentId, signature }) {
  if (!RAZORPAY_KEY_SECRET) return false;
  const payload = `${orderId}|${paymentId}`;
  const expected = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET).update(payload).digest('hex');
  return expected === signature;
}

function verifyWebhookSignature(rawBody, signature) {
  if (!RAZORPAY_WEBHOOK_SECRET || !signature || !rawBody) return false;
  const expected = crypto
    .createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  return expected === signature;
}

async function fetchPayment(paymentId) {
  const razorpay = getRazorpayClient();
  return razorpay.payments.fetch(paymentId);
}

module.exports = {
  getRazorpayClient,
  createOrder,
  verifyPaymentSignature,
  verifyWebhookSignature,
  fetchPayment,
};
