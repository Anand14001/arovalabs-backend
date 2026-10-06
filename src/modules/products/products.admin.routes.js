const { Router } = require('express');
const asyncHandler = require('../../lib/asyncHandler');
const validate = require('../../middleware/validate');
const service = require('./products.service');
const schemas = require('./products.schema');

const router = Router();

router.get(
  '/',
  validate(schemas.adminListQuery),
  asyncHandler(async (req, res) => {
    res.json(await service.listAdmin(req.query));
  }),
);

/*
 * Mounted before /:id so "reorder" and "bulk" are not read as ids. Express
 * matches in declaration order, and :id would happily swallow them.
 */
router.post(
  '/reorder',
  validate(schemas.reorderSchema),
  asyncHandler(async (req, res) => {
    await service.reorder(req.body.ids, req);
    res.json({ ok: true });
  }),
);

router.post(
  '/bulk',
  validate(schemas.bulkSchema),
  asyncHandler(async (req, res) => {
    res.json(await service.bulk(req.body, req));
  }),
);

router.post(
  '/',
  validate(schemas.createSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json({ product: await service.create(req.body, req) });
  }),
);

router.get(
  '/:id',
  validate(schemas.idParam),
  asyncHandler(async (req, res) => {
    res.json({ product: await service.getAdminById(req.params.id) });
  }),
);

router.patch(
  '/:id',
  validate(schemas.updateSchema),
  asyncHandler(async (req, res) => {
    res.json({ product: await service.update(req.params.id, req.body, req) });
  }),
);

router.patch(
  '/:id/status',
  validate(schemas.statusSchema),
  asyncHandler(async (req, res) => {
    res.json({ product: await service.setStatus(req.params.id, req.body.status, req) });
  }),
);

router.post(
  '/:id/duplicate',
  validate(schemas.idParam),
  asyncHandler(async (req, res) => {
    res.status(201).json({ product: await service.duplicate(req.params.id, req) });
  }),
);

router.delete(
  '/:id',
  validate(schemas.idParam),
  asyncHandler(async (req, res) => {
    await service.remove(req.params.id, req);
    res.status(204).end();
  }),
);

module.exports = router;
