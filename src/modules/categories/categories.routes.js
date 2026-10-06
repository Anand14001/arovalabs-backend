const { Router } = require('express');
const { z } = require('zod');
const asyncHandler = require('../../lib/asyncHandler');
const validate = require('../../middleware/validate');
const { requireAdmin } = require('../../middleware/requireAdmin');
const service = require('./categories.service');

const idParam = { params: z.object({ id: z.coerce.number().int().positive() }) };

const bodySchema = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(191),
  slug: z.string().trim().max(191).optional(),
  parentId: z.number().int().positive().nullable().optional(),
  description: z.string().trim().max(5000).optional().nullable(),
  imageId: z.number().int().positive().nullable().optional(),
  menuOrder: z.number().int().min(0).optional(),
  isVisible: z.boolean().optional(),
  metaTitle: z.string().trim().max(255).optional().nullable(),
  metaDescription: z.string().trim().max(500).optional().nullable(),
});

const reorderSchema = {
  body: z.object({
    items: z
      .array(
        z.object({
          id: z.number().int().positive(),
          parentId: z.number().int().positive().nullable().optional(),
        }),
      )
      .min(1)
      .max(500),
  }),
};

// ---------------------------------------------------------------- public

const publicRouter = Router();

publicRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ items: await service.listTree() });
  }),
);

/*
 * Wildcard, not :path — categories are nested, so the URL carries slashes
 * ("tests/diabetes-tests") and a normal parameter would stop at the first one.
 */
publicRouter.get(
  '/*',
  asyncHandler(async (req, res) => {
    const path = req.params[0].replace(/^\/+|\/+$/g, '');
    res.json({ category: await service.getByPath(path) });
  }),
);

// ----------------------------------------------------------------- admin

const adminRouter = Router();

adminRouter.use(requireAdmin);

adminRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    // Hidden categories are still manageable, so the admin asks for everything.
    res.json({ items: await service.listTree({ includeHidden: true }) });
  }),
);

adminRouter.post(
  '/reorder',
  validate(reorderSchema),
  asyncHandler(async (req, res) => {
    await service.reorder(req.body.items, req);
    res.json({ ok: true });
  }),
);

adminRouter.post(
  '/',
  validate({ body: bodySchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json({ category: await service.create(req.body, req) });
  }),
);

adminRouter.patch(
  '/:id',
  validate({ ...idParam, body: bodySchema.partial() }),
  asyncHandler(async (req, res) => {
    res.json({ category: await service.update(req.params.id, req.body, req) });
  }),
);

adminRouter.delete(
  '/:id',
  validate(idParam),
  asyncHandler(async (req, res) => {
    await service.remove(req.params.id, req);
    res.status(204).end();
  }),
);

module.exports = { publicRouter, adminRouter };
