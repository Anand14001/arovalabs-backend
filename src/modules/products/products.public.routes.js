const { Router } = require('express');
const asyncHandler = require('../../lib/asyncHandler');
const validate = require('../../middleware/validate');
const service = require('./products.service');
const schemas = require('./products.schema');

const router = Router();

router.get(
  '/',
  validate(schemas.listQuery),
  asyncHandler(async (req, res) => {
    res.json(await service.listPublic(req.query));
  }),
);

router.get(
  '/:slug',
  validate(schemas.slugParam),
  asyncHandler(async (req, res) => {
    res.json({ product: await service.getPublicBySlug(req.params.slug) });
  }),
);

router.get(
  '/:slug/related',
  validate(schemas.slugParam),
  asyncHandler(async (req, res) => {
    res.json({ items: await service.getRelated(req.params.slug) });
  }),
);

module.exports = router;
