const { Router } = require('express');
const asyncHandler = require('../../lib/asyncHandler');
const validate = require('../../middleware/validate');
const { checkoutLimiter } = require('../../middleware/rateLimit');
const service = require('./orders.service');
const schemas = require('./orders.schema');

const router = Router();

router.post(
  '/',
  checkoutLimiter,
  validate(schemas.placeOrderSchema),
  asyncHandler(async (req, res) => {
    const result = await service.place(req.body, req);
    res.status(201).json(result);
  }),
);

/*
 * Order lookup for the confirmation page and emailed links.
 *
 * The token is required and checked in constant time; without it this is a
 * 404, so order numbers cannot be walked.
 */
router.get(
  '/:orderNumber',
  validate(schemas.lookupSchema),
  asyncHandler(async (req, res) => {
    const order = await service.getByNumber(req.params.orderNumber, req.query.token);
    res.json({ order });
  }),
);

module.exports = router;
