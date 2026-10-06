/*
 * Tags — the homepage's "Choose Test by Organ" tiles.
 *
 * A flat list with an icon, so this stays small and lives in one file rather
 * than being split into a service that would only forward calls.
 */

const { Router } = require('express');
const { z } = require('zod');
const asyncHandler = require('../../lib/asyncHandler');
const validate = require('../../middleware/validate');
const { requireAdmin } = require('../../middleware/requireAdmin');
const prisma = require('../../lib/prisma');
const ApiError = require('../../lib/ApiError');
const { slugify } = require('../../lib/slug');
const { writeAudit } = require('../../lib/audit');
const storage = require('../../lib/storage');

const serialize = (t) => ({
  id: t.id,
  slug: t.slug,
  name: t.name,
  // `icon` is a path into the website's static assets (the organ SVGs);
  // `iconUpload` is one an admin replaced it with. The uploaded one wins.
  icon: t.iconUpload ? storage.publicUrl(t.iconUpload) : (t.icon ?? null),
  menuOrder: t.menuOrder,
  isVisible: t.isVisible,
  productCount: t._count?.products ?? 0,
});

const idParam = { params: z.object({ id: z.coerce.number().int().positive() }) };

const bodySchema = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(191),
  slug: z.string().trim().max(191).optional(),
  icon: z.string().trim().max(255).optional().nullable(),
  iconId: z.number().int().positive().nullable().optional(),
  menuOrder: z.number().int().min(0).optional(),
  isVisible: z.boolean().optional(),
});

const list = async ({ includeHidden = false } = {}) => {
  const rows = await prisma.tag.findMany({
    where: includeHidden ? {} : { isVisible: true },
    include: { iconUpload: true, _count: { select: { products: true } } },
    orderBy: [{ menuOrder: 'asc' }, { name: 'asc' }],
  });
  return rows.map(serialize);
};

// ---------------------------------------------------------------- public

const publicRouter = Router();

publicRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ items: await list() });
  }),
);

// ----------------------------------------------------------------- admin

const adminRouter = Router();

adminRouter.use(requireAdmin);

adminRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ items: await list({ includeHidden: true }) });
  }),
);

adminRouter.post(
  '/',
  validate({ body: bodySchema }),
  asyncHandler(async (req, res) => {
    const slug = slugify(req.body.slug || req.body.name);

    const clash = await prisma.tag.findUnique({ where: { slug }, select: { id: true } });
    if (clash) {
      throw ApiError.conflict('A tag with that slug already exists.', {
        slug: 'Already taken.',
      });
    }

    const tag = await prisma.tag.create({
      data: {
        slug,
        name: req.body.name,
        icon: req.body.icon ?? null,
        iconId: req.body.iconId ?? null,
        menuOrder: req.body.menuOrder ?? 0,
        isVisible: req.body.isVisible ?? true,
      },
      include: { iconUpload: true, _count: { select: { products: true } } },
    });

    await writeAudit({
      req, action: 'tag.created', entityType: 'Tag', entityId: tag.id,
      after: { slug: tag.slug, name: tag.name },
    });

    res.status(201).json({ tag: serialize(tag) });
  }),
);

adminRouter.patch(
  '/:id',
  validate({ ...idParam, body: bodySchema.partial() }),
  asyncHandler(async (req, res) => {
    const existing = await prisma.tag.findUnique({ where: { id: req.params.id } });
    if (!existing) throw ApiError.notFound('Tag not found.');

    const data = { ...req.body };
    if (data.slug || data.name) {
      data.slug = slugify(data.slug || data.name);
      const clash = await prisma.tag.findFirst({
        where: { slug: data.slug, id: { not: req.params.id } },
        select: { id: true },
      });
      if (clash) {
        throw ApiError.conflict('A tag with that slug already exists.', {
          slug: 'Already taken.',
        });
      }
    }

    const tag = await prisma.tag.update({
      where: { id: req.params.id },
      data,
      include: { iconUpload: true, _count: { select: { products: true } } },
    });

    await writeAudit({
      req, action: 'tag.updated', entityType: 'Tag', entityId: tag.id,
      before: { slug: existing.slug, name: existing.name },
      after: { slug: tag.slug, name: tag.name },
    });

    res.json({ tag: serialize(tag) });
  }),
);

adminRouter.delete(
  '/:id',
  validate(idParam),
  asyncHandler(async (req, res) => {
    const existing = await prisma.tag.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { products: true } } },
    });
    if (!existing) throw ApiError.notFound('Tag not found.');

    // Unlike categories, removing a tag loses nothing but the association, so
    // this deletes the links rather than refusing.
    await prisma.tag.delete({ where: { id: req.params.id } });

    await writeAudit({
      req, action: 'tag.deleted', entityType: 'Tag', entityId: req.params.id,
      before: { slug: existing.slug, name: existing.name,
        productsUnlinked: existing._count.products },
    });

    res.status(204).end();
  }),
);

module.exports = { publicRouter, adminRouter };
