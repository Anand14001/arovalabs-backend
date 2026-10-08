const { Router } = require('express');
const { z } = require('zod');
const asyncHandler = require('../../lib/asyncHandler');
const validate = require('../../middleware/validate');
const { requireAdmin } = require('../../middleware/requireAdmin');
const {
  createCenterSchema,
  updateCenterSchema,
  listCentersSchema,
} = require('./centers.schema');
const centersService = require('./centers.service');

const adminRouter = Router();

adminRouter.use(requireAdmin);

const idParam = {
  params: z.object({ id: z.coerce.number().int().positive() }),
};

adminRouter.get(
  '/',
  validate({ query: listCentersSchema }),
  asyncHandler(async (req, res) => {
    const result = await centersService.listCenters(req.query);
    res.json(result);
  }),
);

adminRouter.get(
  '/:id',
  validate(idParam),
  asyncHandler(async (req, res) => {
    const center = await centersService.getCenter(req.params.id);
    res.json({ center });
  }),
);

adminRouter.post(
  '/',
  validate({ body: createCenterSchema }),
  asyncHandler(async (req, res) => {
    const center = await centersService.createCenter(req.body);
    res.status(201).json({ center });
  }),
);

adminRouter.patch(
  '/:id',
  validate({ ...idParam, body: updateCenterSchema }),
  asyncHandler(async (req, res) => {
    const center = await centersService.updateCenter(req.params.id, req.body);
    res.json({ center });
  }),
);

adminRouter.delete(
  '/:id',
  validate(idParam),
  asyncHandler(async (req, res) => {
    const result = await centersService.deleteCenter(req.params.id);
    res.json(result);
  }),
);

module.exports = {
  adminRouter,
};
