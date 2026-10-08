const { Router } = require('express');
const { z } = require('zod');
const asyncHandler = require('../../lib/asyncHandler');
const validate = require('../../middleware/validate');
const { requireAdmin } = require('../../middleware/requireAdmin');
const {
  createCouponSchema,
  updateCouponSchema,
  listCouponsSchema,
} = require('./coupons.schema');
const couponsService = require('./coupons.service');

const adminRouter = Router();

adminRouter.use(requireAdmin);

const idParam = {
  params: z.object({ id: z.coerce.number().int().positive() }),
};

adminRouter.get(
  '/',
  validate({ query: listCouponsSchema }),
  asyncHandler(async (req, res) => {
    const result = await couponsService.listCoupons(req.query);
    res.json(result);
  }),
);

adminRouter.get(
  '/:id',
  validate(idParam),
  asyncHandler(async (req, res) => {
    const coupon = await couponsService.getCoupon(req.params.id);
    res.json({ coupon });
  }),
);

adminRouter.post(
  '/',
  validate({ body: createCouponSchema }),
  asyncHandler(async (req, res) => {
    const coupon = await couponsService.createCoupon(req.body);
    res.status(201).json({ coupon });
  }),
);

adminRouter.patch(
  '/:id',
  validate({ ...idParam, body: updateCouponSchema }),
  asyncHandler(async (req, res) => {
    const coupon = await couponsService.updateCoupon(req.params.id, req.body);
    res.json({ coupon });
  }),
);

adminRouter.delete(
  '/:id',
  validate(idParam),
  asyncHandler(async (req, res) => {
    const result = await couponsService.deleteCoupon(req.params.id);
    res.json(result);
  }),
);

module.exports = {
  adminRouter,
};
