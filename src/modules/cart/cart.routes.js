const { Router } = require('express');
const { z } = require('zod');
const asyncHandler = require('../../lib/asyncHandler');
const validate = require('../../middleware/validate');
const service = require('./cart.service');

const router = Router();

const tokenParam = {
  params: z.object({ token: z.string().trim().min(10).max(64) }),
};

const itemParam = {
  params: z.object({
    token: z.string().trim().min(10).max(64),
    itemId: z.coerce.number().int().positive(),
  }),
};

router.post(
  '/',
  asyncHandler(async (_req, res) => {
    res.status(201).json({ cart: await service.create() });
  }),
);

router.get(
  '/:token',
  validate(tokenParam),
  asyncHandler(async (req, res) => {
    res.json({ cart: await service.get(req.params.token) });
  }),
);

/*
 * Adding takes the token in the body, not the path, because the very first add
 * happens before a cart exists. The service creates one and returns its token.
 */
router.post(
  '/items',
  validate({
    body: z.object({
      token: z.string().trim().min(10).max(64).optional().nullable(),
      productId: z.number().int().positive(),
      // A cap, because nothing stops a client posting 10 million and asking the
      // database to multiply it out.
      quantity: z.number().int().min(1).max(20).default(1),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { token, productId, quantity } = req.body;
    res.json({ cart: await service.addItem(token, { productId, quantity }) });
  }),
);

router.patch(
  '/:token/items/:itemId',
  validate({ ...itemParam, body: z.object({ quantity: z.number().int().min(0).max(20) }) }),
  asyncHandler(async (req, res) => {
    const { token, itemId } = req.params;
    res.json({ cart: await service.setQuantity(token, itemId, req.body.quantity) });
  }),
);

router.delete(
  '/:token/items/:itemId',
  validate(itemParam),
  asyncHandler(async (req, res) => {
    const { token, itemId } = req.params;
    res.json({ cart: await service.removeItem(token, itemId) });
  }),
);

router.delete(
  '/:token',
  validate(tokenParam),
  asyncHandler(async (req, res) => {
    res.json({ cart: await service.clear(req.params.token) });
  }),
);

router.post(
  '/:token/coupon',
  validate({ ...tokenParam, body: z.object({ code: z.string().trim().min(1).max(64) }) }),
  asyncHandler(async (req, res) => {
    res.json({ cart: await service.applyCoupon(req.params.token, req.body.code) });
  }),
);

router.delete(
  '/:token/coupon',
  validate(tokenParam),
  asyncHandler(async (req, res) => {
    res.json({ cart: await service.removeCoupon(req.params.token) });
  }),
);

module.exports = router;
