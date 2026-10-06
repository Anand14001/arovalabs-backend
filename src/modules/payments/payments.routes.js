/*
 * Payment routes.
 *
 * The webhook is NOT here — it is mounted in app.js, ahead of the JSON body
 * parser, because its signature is computed over the raw bytes. Mounting it in
 * this router would put it behind express.json(), and verification would fail
 * for reasons that look like a wrong secret.
 */

const { Router } = require('express');
const asyncHandler = require('../../lib/asyncHandler');
const validate = require('../../middleware/validate');
const { checkoutLimiter } = require('../../middleware/rateLimit');
const service = require('./payments.service');
const razorpay = require('../../lib/razorpay');
const schemas = require('../orders/orders.schema');

const router = Router();

/** Tells the website whether online payment is available before checkout starts. */
router.get('/config', (_req, res) => {
  res.json({
    provider: 'razorpay',
    enabled: razorpay.isConfigured,
    mode: razorpay.mode(),
    // The key id is public by design — it is what the checkout script is
    // initialised with in the browser. The secret never leaves the server.
    keyId: razorpay.keyId,
  });
});

router.post(
  '/verify',
  checkoutLimiter,
  validate(schemas.verifyPaymentSchema),
  asyncHandler(async (req, res) => {
    res.json(await service.verifyFromCheckout(req.body, req));
  }),
);

module.exports = router;
