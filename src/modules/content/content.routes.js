const { Router } = require('express');
const { z } = require('zod');
const asyncHandler = require('../../lib/asyncHandler');
const validate = require('../../middleware/validate');
const { requireAdmin } = require('../../middleware/requireAdmin');
const prisma = require('../../lib/prisma');
const ApiError = require('../../lib/ApiError');
const storage = require('../../lib/storage');
const { slugify } = require('../../lib/slug');
const { pageQuery, paginated } = require('../../lib/pagination');
const { writeAudit } = require('../../lib/audit');
const revisions = require('../../lib/revisions');
const sanitize = require('../../lib/sanitize');
const service = require('./content.service');
const registry = require('./sections.registry');

const idParam = { params: z.object({ id: z.coerce.number().int().positive() }) };

const avatarUrl = (u) => (u ? storage.publicUrl(u) : null);

// ---------------------------------------------------------------- shared

/*
 * The blocks several pages pull from — testimonials, FAQs, reviews, navigation.
 *
 * Serialised identically for the public site and the admin, because there is
 * nothing editorial to hide: the difference is only that the admin also sees
 * hidden rows.
 */
const listBlocks = async ({ includeHidden = false } = {}) => {
  const where = includeHidden ? {} : { isVisible: true };

  const [testimonials, reviews, faqs, nav] = await prisma.$transaction([
    prisma.testimonial.findMany({
      where,
      include: { avatar: true },
      orderBy: [{ menuOrder: 'asc' }, { id: 'asc' }],
    }),
    prisma.googleReview.findMany({
      where,
      orderBy: [{ menuOrder: 'asc' }, { id: 'asc' }],
    }),
    prisma.faq.findMany({ where, orderBy: [{ menuOrder: 'asc' }, { id: 'asc' }] }),
    prisma.navItem.findMany({
      where: includeHidden ? {} : { isVisible: true },
      orderBy: [{ menu: 'asc' }, { order: 'asc' }],
    }),
  ]);

  return {
    testimonials: testimonials.map((t) => ({
      id: t.id,
      authorName: t.authorName,
      authorMeta: t.authorMeta,
      rating: t.rating,
      quote: t.quote,
      avatar: avatarUrl(t.avatar),
      source: t.source,
      isVisible: t.isVisible,
      menuOrder: t.menuOrder,
    })),
    googleReviews: reviews.map((r) => ({
      id: r.id,
      authorName: r.authorName,
      rating: r.rating,
      quote: r.quote,
      avatarUrl: r.avatarUrl,
      reviewedAt: r.reviewedAt,
      isVisible: r.isVisible,
      menuOrder: r.menuOrder,
    })),
    faqs: faqs.map((f) => ({
      id: f.id,
      question: f.question,
      answer: f.answer,
      group: f.group,
      isVisible: f.isVisible,
      menuOrder: f.menuOrder,
    })),
    nav: nav.reduce((acc, n) => {
      (acc[n.menu] ??= []).push({
        id: n.id,
        label: n.label,
        url: n.url,
        parentId: n.parentId,
        order: n.order,
        opensInNewTab: n.opensInNewTab,
        isVisible: n.isVisible,
      });
      return acc;
    }, {}),
  };
};

// ---------------------------------------------------------------- public

const publicRouter = Router();

publicRouter.get(
  '/posts',
  validate({
    query: pageQuery.extend({
      category: z.string().trim().max(191).optional(),
      tag: z.string().trim().max(191).optional(),
      q: z.string().trim().max(120).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { page, limit } = req.query;
    const { items, total } = await service.listPosts({ ...req.query, status: 'PUBLISHED' });
    res.json(paginated(items.map((p) => service.toPost(p)), total, { page, limit }));
  }),
);

publicRouter.get(
  '/posts/:slug',
  validate({ params: z.object({ slug: z.string().trim().min(1).max(191) }) }),
  asyncHandler(async (req, res) => {
    res.json(await service.getPostBySlug(req.params.slug));
  }),
);

publicRouter.get(
  '/blog-categories',
  asyncHandler(async (_req, res) => {
    const rows = await prisma.blogCategory.findMany({
      orderBy: [{ menuOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { posts: true } } },
    });
    res.json({
      items: rows.map((c) => ({
        id: c.id,
        slug: c.slug,
        name: c.name,
        description: c.description,
        postCount: c._count.posts,
      })),
    });
  }),
);

publicRouter.get(
  '/pages/:slug',
  validate({ params: z.object({ slug: z.string().trim().min(1).max(191) }) }),
  asyncHandler(async (req, res) => {
    res.json({ page: await service.getPageBySlug(req.params.slug) });
  }),
);

publicRouter.get(
  '/content-blocks',
  asyncHandler(async (_req, res) => {
    res.json(await listBlocks());
  }),
);

/*
 * Redirect lookup.
 *
 * The website asks before showing a 404, so an article that was renamed still
 * resolves. Counting hits shows which old links are still in circulation.
 */
publicRouter.get(
  '/redirects/lookup',
  validate({ query: z.object({ path: z.string().trim().min(1).max(500) }) }),
  asyncHandler(async (req, res) => {
    const row = await prisma.redirect.findUnique({ where: { fromPath: req.query.path } });
    if (!row?.isActive) return res.json({ redirect: null });

    prisma.redirect
      .update({ where: { id: row.id }, data: { hitCount: { increment: 1 } } })
      .catch(() => {});

    return res.json({ redirect: { to: row.toPath, status: row.statusCode } });
  }),
);

// ----------------------------------------------------------------- admin

const adminRouter = Router();

adminRouter.use(requireAdmin);

/** The form definitions the section editor builds itself from. */
adminRouter.get(
  '/section-types',
  asyncHandler(async (_req, res) => {
    res.json({ items: registry.describe() });
  }),
);

// ---- posts

adminRouter.get(
  '/posts',
  validate({
    query: pageQuery.extend({
      status: z.enum(['DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED']).optional(),
      category: z.string().trim().max(191).optional(),
      q: z.string().trim().max(120).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { page, limit } = req.query;
    const { items, total } = await service.listPosts(req.query);
    res.json(paginated(items.map(service.toAdminPost), total, { page, limit }));
  }),
);

const postBody = z.object({
  title: z.string().trim().min(1, 'Give the article a title.').max(255),
  slug: z.string().trim().max(191).optional(),
  excerpt: z.string().trim().max(1000).optional().nullable(),
  content: z.string().max(200_000).optional().nullable(),
  status: z.enum(['DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED']).default('DRAFT'),
  categoryId: z.number().int().positive().nullable().optional(),
  tagIds: z.array(z.number().int().positive()).optional(),
  featuredUploadId: z.number().int().positive().nullable().optional(),
  ogUploadId: z.number().int().positive().nullable().optional(),
  authorName: z.string().trim().max(191).optional().nullable(),
  isFeatured: z.boolean().optional(),
  metaTitle: z.string().trim().max(255).optional().nullable(),
  metaDescription: z.string().trim().max(500).optional().nullable(),
});

adminRouter.post(
  '/posts',
  validate({ body: postBody }),
  asyncHandler(async (req, res) => {
    res.status(201).json({ post: await service.createPost(req.body, req) });
  }),
);

adminRouter.get(
  '/posts/:id',
  validate(idParam),
  asyncHandler(async (req, res) => {
    const post = await prisma.blogPost.findUnique({
      where: { id: req.params.id },
      include: service.POST_INCLUDE,
    });
    if (!post) throw ApiError.notFound('Article not found.');
    res.json({ post: service.toAdminPost(post) });
  }),
);

adminRouter.patch(
  '/posts/:id',
  validate({ ...idParam, body: postBody.partial() }),
  asyncHandler(async (req, res) => {
    res.json({ post: await service.updatePost(req.params.id, req.body, req) });
  }),
);

adminRouter.delete(
  '/posts/:id',
  validate(idParam),
  asyncHandler(async (req, res) => {
    await service.deletePost(req.params.id, req);
    res.status(204).end();
  }),
);

adminRouter.get(
  '/posts/:id/revisions',
  validate(idParam),
  asyncHandler(async (req, res) => {
    res.json({ items: await revisions.list('BlogPost', req.params.id) });
  }),
);

adminRouter.post(
  '/posts/:id/revisions/:revisionId/restore',
  validate({
    params: z.object({
      id: z.coerce.number().int().positive(),
      revisionId: z.coerce.number().int().positive(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const post = await service.restorePost(req.params.id, req.params.revisionId, req);
    res.json({ post });
  }),
);

// ---- blog categories and tags

adminRouter.get(
  '/blog-categories',
  asyncHandler(async (_req, res) => {
    const rows = await prisma.blogCategory.findMany({
      orderBy: [{ menuOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { posts: true } } },
    });
    res.json({
      items: rows.map((c) => ({
        id: c.id, slug: c.slug, name: c.name, description: c.description,
        menuOrder: c.menuOrder, postCount: c._count.posts,
      })),
    });
  }),
);

adminRouter.post(
  '/blog-categories',
  validate({
    body: z.object({
      name: z.string().trim().min(1).max(191),
      description: z.string().trim().max(1000).optional().nullable(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const slug = slugify(req.body.name);
    const clash = await prisma.blogCategory.findUnique({ where: { slug } });
    if (clash) throw ApiError.conflict('A category with that name already exists.');
    const row = await prisma.blogCategory.create({ data: { ...req.body, slug } });
    res.status(201).json({ category: row });
  }),
);

// ---- pages and sections

adminRouter.get(
  '/pages',
  asyncHandler(async (_req, res) => {
    const rows = await prisma.page.findMany({
      orderBy: { title: 'asc' },
      include: { _count: { select: { sections: true } } },
    });
    res.json({
      items: rows.map((p) => ({
        id: p.id, slug: p.slug, title: p.title, status: p.status,
        layout: p.layout, isSystem: p.isSystem, sectionCount: p._count.sections,
        updatedAt: p.updatedAt,
      })),
    });
  }),
);

adminRouter.get(
  '/pages/:id',
  validate(idParam),
  asyncHandler(async (req, res) => {
    const page = await prisma.page.findUnique({
      where: { id: req.params.id },
      include: service.PAGE_INCLUDE,
    });
    if (!page) throw ApiError.notFound('Page not found.');
    res.json({ page: service.toPage(page, { includeHidden: true }) });
  }),
);

adminRouter.patch(
  '/pages/:id',
  validate({
    ...idParam,
    body: z.object({
      title: z.string().trim().max(255).optional(),
      slug: z.string().trim().max(191).optional(),
      status: z.enum(['DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED']).optional(),
      bodyHtml: z.string().max(200_000).optional().nullable(),
      metaTitle: z.string().trim().max(255).optional().nullable(),
      metaDescription: z.string().trim().max(500).optional().nullable(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json({ page: await service.updatePage(req.params.id, req.body, req) });
  }),
);

adminRouter.post(
  '/pages/:id/sections',
  validate({
    ...idParam,
    body: z.object({
      type: z.string().trim().min(1).max(64),
      label: z.string().trim().max(191).optional().nullable(),
      data: z.record(z.any()).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.status(201).json({ section: await service.createSection(req.params.id, req.body, req) });
  }),
);

adminRouter.post(
  '/pages/:id/sections/reorder',
  validate({
    ...idParam,
    body: z.object({ ids: z.array(z.number().int().positive()).min(1).max(100) }),
  }),
  asyncHandler(async (req, res) => {
    await service.reorderSections(req.params.id, req.body.ids, req);
    res.json({ ok: true });
  }),
);

adminRouter.patch(
  '/sections/:id',
  validate({
    ...idParam,
    body: z.object({
      label: z.string().trim().max(191).optional().nullable(),
      isVisible: z.boolean().optional(),
      data: z.record(z.any()).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json({ section: await service.updateSection(req.params.id, req.body, req) });
  }),
);

adminRouter.delete(
  '/sections/:id',
  validate(idParam),
  asyncHandler(async (req, res) => {
    await service.deleteSection(req.params.id, req);
    res.status(204).end();
  }),
);

adminRouter.get(
  '/sections/:id/revisions',
  validate(idParam),
  asyncHandler(async (req, res) => {
    res.json({ items: await revisions.list('PageSection', req.params.id) });
  }),
);

adminRouter.post(
  '/sections/:id/revisions/:revisionId/restore',
  validate({
    params: z.object({
      id: z.coerce.number().int().positive(),
      revisionId: z.coerce.number().int().positive(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const snap = await revisions.get(req.params.revisionId);
    if (!snap) throw ApiError.notFound('That version no longer exists.');
    const section = await service.updateSection(
      req.params.id,
      { label: snap.label, data: snap.data },
      req,
    );
    res.json({ section });
  }),
);

// ---- shared blocks

adminRouter.get(
  '/blocks',
  asyncHandler(async (_req, res) => {
    res.json(await listBlocks({ includeHidden: true }));
  }),
);

const testimonialBody = z.object({
  authorName: z.string().trim().min(1, 'Name is required.').max(191),
  authorMeta: z.string().trim().max(191).optional().nullable(),
  rating: z.coerce.number().int().min(1).max(5).optional().nullable(),
  quote: z.string().trim().min(1, 'Quote is required.').max(2000),
  avatarId: z.number().int().positive().nullable().optional(),
  source: z.string().trim().max(64).optional().nullable(),
  isVisible: z.boolean().optional(),
  menuOrder: z.number().int().min(0).optional(),
});

adminRouter.post(
  '/testimonials',
  validate({ body: testimonialBody }),
  asyncHandler(async (req, res) => {
    const row = await prisma.testimonial.create({
      // Quotes render as text, so markup in them is never intentional.
      data: { ...req.body, quote: sanitize.stripTags(req.body.quote) },
    });
    await writeAudit({ req, action: 'testimonial.created', entityType: 'Testimonial', entityId: row.id });
    res.status(201).json({ testimonial: row });
  }),
);

adminRouter.patch(
  '/testimonials/:id',
  validate({ ...idParam, body: testimonialBody.partial() }),
  asyncHandler(async (req, res) => {
    const row = await prisma.testimonial.update({
      where: { id: req.params.id },
      data: {
        ...req.body,
        ...(req.body.quote ? { quote: sanitize.stripTags(req.body.quote) } : {}),
      },
    });
    res.json({ testimonial: row });
  }),
);

adminRouter.delete(
  '/testimonials/:id',
  validate(idParam),
  asyncHandler(async (req, res) => {
    await prisma.testimonial.delete({ where: { id: req.params.id } });
    await writeAudit({ req, action: 'testimonial.deleted', entityType: 'Testimonial', entityId: req.params.id });
    res.status(204).end();
  }),
);

const faqBody = z.object({
  question: z.string().trim().min(1, 'Question is required.').max(500),
  answer: z.string().trim().min(1, 'Answer is required.').max(5000),
  group: z.enum(['HOME', 'PRODUCT', 'GENERAL']).default('GENERAL'),
  isVisible: z.boolean().optional(),
  menuOrder: z.number().int().min(0).optional(),
});

adminRouter.post(
  '/faqs',
  validate({ body: faqBody }),
  asyncHandler(async (req, res) => {
    const row = await prisma.faq.create({
      data: {
        ...req.body,
        question: sanitize.stripTags(req.body.question),
        answer: sanitize.stripTags(req.body.answer),
      },
    });
    res.status(201).json({ faq: row });
  }),
);

adminRouter.patch(
  '/faqs/:id',
  validate({ ...idParam, body: faqBody.partial() }),
  asyncHandler(async (req, res) => {
    const row = await prisma.faq.update({
      where: { id: req.params.id },
      data: {
        ...req.body,
        ...(req.body.question ? { question: sanitize.stripTags(req.body.question) } : {}),
        ...(req.body.answer ? { answer: sanitize.stripTags(req.body.answer) } : {}),
      },
    });
    res.json({ faq: row });
  }),
);

adminRouter.delete(
  '/faqs/:id',
  validate(idParam),
  asyncHandler(async (req, res) => {
    await prisma.faq.delete({ where: { id: req.params.id } });
    res.status(204).end();
  }),
);

// ---- navigation

adminRouter.put(
  '/nav/:menu',
  validate({
    params: z.object({ menu: z.enum(['HEADER', 'FOOTER_QUICK', 'FOOTER_LEGAL']) }),
    body: z.object({
      items: z
        .array(
          z.object({
            label: z.string().trim().min(1, 'Label is required.').max(191),
            url: z.string().trim().min(1, 'Link is required.').max(500),
            opensInNewTab: z.boolean().optional(),
            isVisible: z.boolean().optional(),
          }),
        )
        .max(40),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { menu } = req.params;

    /*
     * Replaced wholesale rather than diffed. The editor sends the full ordered
     * menu every time, so a delete-and-insert in one transaction is both
     * simpler and correct — nothing references a nav item's id.
     */
    await prisma.$transaction([
      prisma.navItem.deleteMany({ where: { menu } }),
      prisma.navItem.createMany({
        data: req.body.items.map((item, order) => ({
          menu,
          label: sanitize.stripTags(item.label),
          url: item.url,
          order,
          opensInNewTab: item.opensInNewTab ?? false,
          isVisible: item.isVisible ?? true,
        })),
      }),
    ]);

    await writeAudit({
      req, action: 'nav.updated', entityType: 'NavItem',
      after: { menu, count: req.body.items.length },
    });

    const items = await prisma.navItem.findMany({ where: { menu }, orderBy: { order: 'asc' } });
    res.json({ items });
  }),
);

// ---- redirects

adminRouter.get(
  '/redirects',
  asyncHandler(async (_req, res) => {
    const items = await prisma.redirect.findMany({ orderBy: { createdAt: 'desc' }, take: 500 });
    res.json({ items });
  }),
);

adminRouter.post(
  '/redirects',
  validate({
    body: z.object({
      fromPath: z.string().trim().min(1).max(500),
      toPath: z.string().trim().min(1).max(500),
      statusCode: z.coerce.number().int().refine((v) => [301, 302].includes(v)).default(301),
    }),
  }),
  asyncHandler(async (req, res) => {
    const row = await prisma.redirect.upsert({
      where: { fromPath: req.body.fromPath },
      update: { toPath: req.body.toPath, statusCode: req.body.statusCode, isActive: true },
      create: req.body,
    });
    res.status(201).json({ redirect: row });
  }),
);

adminRouter.delete(
  '/redirects/:id',
  validate(idParam),
  asyncHandler(async (req, res) => {
    await prisma.redirect.delete({ where: { id: req.params.id } });
    res.status(204).end();
  }),
);

module.exports = { publicRouter, adminRouter, listBlocks };
