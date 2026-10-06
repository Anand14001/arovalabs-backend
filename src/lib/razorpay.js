/*
 * Razorpay.
 *
 * Wrapped rather than used directly so that:
 *   - the keys are read in one place and their absence is a clear error rather
 *     than a confusing SDK failure on the first checkout;
 *   - signature verification lives next to the calls it protects;
 *   - the rest of the application talks about orders and payments, not about a
 *     third party, which is what makes swapping or adding a provider tractable.
 *
 * Amounts are paise, which is also Razorpay's unit for INR — so no conversion
 * happens here, and none should be added.
 */

const crypto = require('node:crypto');
const Razorpay = require('razorpay');
const env = require('../config/env');
const ApiError = require('./ApiError');
const logger = require('./logger');

const isConfigured = Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);

let client = null;

const getClient = () => {
  if (!isConfigured) {
    throw new ApiError(
      503,
      'PAYMENTS_UNAVAILABLE',
      'Online payment is not configured. Please call us to book.',
    );
  }
  if (!client) {
    client = new Razorpay({
      key_id: env.RAZORPAY_KEY_ID,
      key_secret: env.RAZORPAY_KEY_SECRET,
    });
  }
  return client;
};

/*
 * Test keys start `rzp_test_`. Surfaced so the admin can show which mode is
 * live rather than anyone having to guess from a key they cannot read back.
 */
const mode = () =>
  !isConfigured ? 'unconfigured' : env.RAZORPAY_KEY_ID.startsWith('rzp_test') ? 'test' : 'live';

const createOrder = async ({ amount, receipt, notes }) => {
  try {
    return await getClient().orders.create({
      amount, // paise
      currency: 'INR',
      receipt,
      notes,
      // Razorpay captures automatically; a manual capture step would mean money
      // held in authorised limbo if the follow-up call ever failed.
      payment_capture: 1,
    });
  } catch (err) {
    logger.error({ err: err?.error ?? err }, 'razorpay order creation failed');
    throw new ApiError(
      502,
      'PAYMENT_PROVIDER_ERROR',
      'We could not start the payment. Please try again.',
    );
  }
};

/*
 * Checkout handoff signature: HMAC-SHA256 of "<order_id>|<payment_id>" with the
 * key secret. This is what proves the browser's success callback is genuine and
 * not someone POSTing a made-up payment id.
 */
const verifyPaymentSignature = ({ razorpayOrderId, razorpayPaymentId, signature }) => {
  if (!isConfigured || !signature) return false;

  const expected = crypto
    .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');

  return timingSafeEqual(expected, signature);
};

/*
 * Webhook signature: HMAC-SHA256 of the raw request body with the webhook
 * secret — a different secret from the key secret, and computed over bytes that
 * must not have been through a JSON parser (see the mount order in app.js).
 */
const verifyWebhookSignature = (rawBody, signature) => {
  if (!env.RAZORPAY_WEBHOOK_SECRET || !signature) return false;

  const expected = crypto
    .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  return timingSafeEqual(expected, signature);
};

// Constant-time compare: a plain === leaks how much of the signature matched.
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const fetchPayment = async (paymentId) => {
  try {
    return await getClient().payments.fetch(paymentId);
  } catch (err) {
    logger.error({ err: err?.error ?? err, paymentId }, 'razorpay payment fetch failed');
    return null;
  }
};

const refund = async ({ paymentId, amount, notes }) => {
  try {
    return await getClient().payments.refund(paymentId, { amount, notes });
  } catch (err) {
    logger.error({ err: err?.error ?? err, paymentId }, 'razorpay refund failed');
    throw new ApiError(502, 'REFUND_FAILED', err?.error?.description ?? 'The refund could not be processed.');
  }
};

module.exports = {
  isConfigured,
  mode,
  keyId: env.RAZORPAY_KEY_ID ?? null,
  createOrder,
  verifyPaymentSignature,
  verifyWebhookSignature,
  fetchPayment,
  refund,
};
