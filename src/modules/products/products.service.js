const prisma = require('../../lib/prisma');
const ApiError = require('../../lib/ApiError');
const { slugify, uniqueSlug } = require('../../lib/slug');
const { toSkipTake, paginated } = require('../../lib/pagination');
const { writeAudit } = require('../../lib/audit');
const serializer = require('./products.serializer');

/*
 * Includes.
 *
 * The database is remote, so the cost that matters is round trips, not rows.
 * One query with the nesting it needs beats five tidy ones — hence these shared
 * include shapes rather than fetching children on demand.
 */
const CARD_INCLUDE = {
  cardImage: true,
  archiveImage: true,
  // Package cards render a bullet list of highlights, so these belong in the
  // card shape, not just the detail one.
  highlights: { orderBy: { order: 'asc' } },
  categories: { include: { category: true } },
  tags: { include: { tag: true } },
};

const DETAIL_INCLUDE = {
  ...CARD_INCLUDE,
  detailImage: true,
  parameters: { orderBy: { order: 'asc' } },
  highlights: { orderBy: { order: 'asc' } },
  parameterGroups: {
    orderBy: { order: 'asc' },
    include: { items: { orderBy: { order: 'asc' } } },
  },
  preparation: { orderBy: { order: 'asc' } },
  process: { orderBy: { order: 'asc' } },
  audience: { orderBy: { order: 'asc' } },
  faqs: { orderBy: { order: 'asc' } },
};

// The six orderings the reference site's WooCommerce archives offered.
const ORDER_BY = {
  menu_order: [{ menuOrder: 'asc' }, { id: 'asc' }],
  date: [{ publishedAt: 'desc' }, { id: 'desc' }],
  price: [{ salePrice: 'asc' }],
  'price-desc': [{ salePrice: 'desc' }],
  title: [{ title: 'asc' }],
  // No order or review data exists yet. Rather than invent a ranking, these
  // fall back to curated order — which is what "popular" means here for now.
  popularity: [{ isFeatured: 'desc' }, { menuOrder: 'asc' }],
  rating: [{ isFeatured: 'desc' }, { menuOrder: 'asc' }],
};

const buildWhere = ({ type, category, tag, q, minPrice, maxPrice, status, featured }) => {
  const where = {};

  if (status) where.status = status;
  if (type) where.type = type;
  if (featured !== undefined) where.isFeatured = featured;

  if (category) {
    /*
     * Matches the category and everything beneath it, so /product-category/tests/
     * lists the diabetes and thyroid products too — which is how the reference
     * site's archives behave.
     */
    where.categories = {
      some: {
        category: {
          OR: [{ path: category }, { path: { startsWith: `${category}/` } }],
        },
      },
    };
  }

  if (tag) where.tags = { some: { tag: { slug: tag } } };

  if (q) {
    where.OR = [
      { title: { contains: q, mode: 'insensitive' } },
      { cardExcerpt: { contains: q, mode: 'insensitive' } },
      { excerpt: { contains: q, mode: 'insensitive' } },
      { parameters: { some: { name: { contains: q, mode: 'insensitive' } } } },
    ];
  }

  if (minPrice !== undefined || maxPrice !== undefined) {
    where.salePrice = {};
    if (minPrice !== undefined) where.salePrice.gte = minPrice;
    if (maxPrice !== undefined) where.salePrice.lte = maxPrice;
  }

  return where;
};

// ------------------------------------------------------------------ public

const listPublic = async (query) => {
  const { page, limit, orderby = 'menu_order', ...filters } = query;
  const where = buildWhere({ ...filters, status: 'PUBLISHED' });

  const [items, total] = await prisma.$transaction([
    prisma.product.findMany({
      where,
      include: CARD_INCLUDE,
      orderBy: ORDER_BY[orderby] ?? ORDER_BY.menu_order,
      ...toSkipTake({ page, limit }),
    }),
    prisma.product.count({ where }),
  ]);

  return paginated(items.map(serializer.toCard), total, { page, limit });
};

const getPublicBySlug = async (slug) => {
  const product = await prisma.product.findFirst({
    where: { slug, status: 'PUBLISHED' },
    include: DETAIL_INCLUDE,
  });
  if (!product) throw ApiError.notFound('That test or package does not exist.');
  return serializer.toDetail(product);
};

/*
 * Related products: same categories first, then same type, never itself.
 *
 * Falls back to any published product of the same type so a sparsely
 * categorised product still shows something rather than an empty rail.
 */
const getRelated = async (slug, take = 8) => {
  const product = await prisma.product.findFirst({
    where: { slug, status: 'PUBLISHED' },
    include: { categories: true },
  });
  if (!product) throw ApiError.notFound('That test or package does not exist.');

  const categoryIds = product.categories.map((c) => c.categoryId);

  const sameCategory = categoryIds.length
    ? await prisma.product.findMany({
      where: {
        status: 'PUBLISHED',
        id: { not: product.id },
        categories: { some: { categoryId: { in: categoryIds } } },
      },
      include: CARD_INCLUDE,
      orderBy: ORDER_BY.menu_order,
      take,
    })
    : [];

  if (sameCategory.length >= take) return sameCategory.map(serializer.toCard);

  const filler = await prisma.product.findMany({
    where: {
      status: 'PUBLISHED',
      type: product.type,
      id: { notIn: [product.id, ...sameCategory.map((p) => p.id)] },
    },
    include: CARD_INCLUDE,
    orderBy: ORDER_BY.menu_order,
    take: take - sameCategory.length,
  });

  return [...sameCategory, ...filler].map(serializer.toCard);
};

// ------------------------------------------------------------------- admin

const listAdmin = async (query) => {
  const { page, limit, orderby = 'menu_order', ...filters } = query;
  const where = buildWhere(filters);

  const [items, total] = await prisma.$transaction([
    prisma.product.findMany({
      where,
      include: CARD_INCLUDE,
      orderBy: ORDER_BY[orderby] ?? ORDER_BY.menu_order,
      ...toSkipTake({ page, limit }),
    }),
    prisma.product.count({ where }),
  ]);

  return paginated(items.map(serializer.toAdminRow), total, { page, limit });
};

const getAdminById = async (id) => {
  const product = await prisma.product.findUnique({
    where: { id },
    include: DETAIL_INCLUDE,
  });
  if (!product) throw ApiError.notFound('Product not found.');
  return serializer.toAdmin(product);
};

const slugTaken = (slug, exceptId) => async (candidate) => {
  const found = await prisma.product.findUnique({
    where: { slug: candidate ?? slug },
    select: { id: true },
  });
  return Boolean(found) && found.id !== exceptId;
};

/*
 * Nested content is replaced wholesale on save rather than diffed.
 *
 * The editor hands back the full ordered list every time, so a delete-and-insert
 * inside one transaction is both simpler and correct; diffing would add a lot of
 * code whose only benefit is preserving row ids nothing references.
 *
 * `deleteMany` is only a valid nested operation on update — on create there is
 * nothing to clear yet, and Prisma rejects it — so `mode` drops it.
 */
const nestedWrites = (data, mode = 'update') => {
  const clear = mode === 'update' ? { deleteMany: {} } : {};
  const writes = {};

  if (data.parameters) {
    writes.parameters = {
      ...clear,
      create: data.parameters.map((name, order) => ({ name, order })),
    };
  }

  if (data.highlights) {
    writes.highlights = {
      ...clear,
      create: data.highlights.map((name, order) => ({ name, order })),
    };
  }

  if (data.parameterGroups) {
    writes.parameterGroups = {
      ...clear,
      create: data.parameterGroups.map((g, order) => ({
        name: g.name,
        summary: g.summary ?? null,
        order,
        items: { create: (g.items ?? []).map((name, i) => ({ name, order: i })) },
      })),
    };
  }

  if (data.preparation) {
    writes.preparation = {
      ...clear,
      create: data.preparation.map((s, order) => ({
        title: s.title ?? null,
        text: s.text,
        icon: s.icon ?? null,
        order,
      })),
    };
  }

  if (data.process) {
    writes.process = {
      ...clear,
      create: data.process.map((s, order) => ({
        icon: s.icon ?? null,
        text: s.text,
        order,
      })),
    };
  }

  if (data.audience) {
    writes.audience = {
      ...clear,
      create: data.audience.map((text, order) => ({ text, order })),
    };
  }

  if (data.faqs) {
    writes.faqs = {
      ...clear,
      create: data.faqs.map((f, order) => ({
        question: f.question,
        answer: f.answer,
        order,
      })),
    };
  }

  return writes;
};

const relationWrites = (data, mode = 'update') => {
  const clear = mode === 'update' ? { deleteMany: {} } : {};
  const writes = {};
  if (data.categoryIds) {
    writes.categories = {
      ...clear,
      create: data.categoryIds.map((categoryId) => ({ categoryId })),
    };
  }
  if (data.tagIds) {
    writes.tags = {
      ...clear,
      create: data.tagIds.map((tagId) => ({ tagId })),
    };
  }
  return writes;
};

const scalarWrites = (data) => {
  const fields = [
    'title', 'type', 'status', 'sku', 'regularPrice', 'salePrice',
    'cardExcerpt', 'excerpt', 'excerptSecondary', 'overview', 'profiles',
    'ribbon', 'menuOrder', 'isFeatured',
    'sampleType', 'fastingRequired', 'fastingNote', 'turnaroundHours',
    'reportFormat', 'parametersUnavailable', 'showAllParametersCta',
    'metaTitle', 'metaDescription',
    'cardImageId', 'detailImageId', 'archiveImageId',
  ];

  const out = {};
  for (const f of fields) if (data[f] !== undefined) out[f] = data[f];
  if (data.badges !== undefined) out.badges = data.badges;
  return out;
};

const assertPricesSane = (regular, sale) => {
  if (regular === undefined || sale === undefined) return;
  if (sale > regular) {
    throw ApiError.unprocessable('Validation failed.', {
      salePrice: 'The sale price cannot be higher than the regular price.',
    });
  }
};

const create = async (data, req) => {
  assertPricesSane(data.regularPrice, data.salePrice);

  const slug = await uniqueSlug(data.slug || data.title, async (candidate) => {
    const found = await prisma.product.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    return Boolean(found);
  });

  const product = await prisma.product.create({
    data: {
      ...scalarWrites(data),
      slug,
      // Publishing stamps the date here rather than relying on the client,
      // so "latest" ordering cannot be gamed by a wrong clock.
      publishedAt: data.status === 'PUBLISHED' ? new Date() : null,
      ...nestedWrites(data, 'create'),
      ...relationWrites(data, 'create'),
    },
    include: DETAIL_INCLUDE,
  });

  await writeAudit({
    req,
    action: 'product.created',
    entityType: 'Product',
    entityId: product.id,
    after: { slug: product.slug, title: product.title, status: product.status },
  });

  return serializer.toAdmin(product);
};

const update = async (id, data, req) => {
  const existing = await prisma.product.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Product not found.');

  assertPricesSane(
    data.regularPrice ?? existing.regularPrice,
    data.salePrice ?? existing.salePrice,
  );

  let slug;
  if (data.slug && data.slug !== existing.slug) {
    slug = await uniqueSlug(data.slug, slugTaken(data.slug, id));
  }

  const becomingPublished =
    data.status === 'PUBLISHED' && existing.status !== 'PUBLISHED';

  const product = await prisma.product.update({
    where: { id },
    data: {
      ...scalarWrites(data),
      ...(slug ? { slug } : {}),
      ...(becomingPublished && !existing.publishedAt ? { publishedAt: new Date() } : {}),
      ...nestedWrites(data),
      ...relationWrites(data),
    },
    include: DETAIL_INCLUDE,
  });

  await writeAudit({
    req,
    action: 'product.updated',
    entityType: 'Product',
    entityId: id,
    before: {
      slug: existing.slug, title: existing.title, status: existing.status,
      regularPrice: existing.regularPrice, salePrice: existing.salePrice
    },
    after: {
      slug: product.slug, title: product.title, status: product.status,
      regularPrice: product.regularPrice, salePrice: product.salePrice
    },
  });

  return serializer.toAdmin(product);
};

const setStatus = async (id, status, req) => {
  const existing = await prisma.product.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Product not found.');

  const product = await prisma.product.update({
    where: { id },
    data: {
      status,
      ...(status === 'PUBLISHED' && !existing.publishedAt
        ? { publishedAt: new Date() }
        : {}),
    },
    include: DETAIL_INCLUDE,
  });

  await writeAudit({
    req,
    action: 'product.status_changed',
    entityType: 'Product',
    entityId: id,
    before: { status: existing.status },
    after: { status },
  });

  return serializer.toAdmin(product);
};

/*
 * Duplicate.
 *
 * Copies as a draft with "(copy)" appended — the reference site is full of
 * products literally titled "Women Wellness Essential (Copy) (Copy)" because
 * duplicates were published by accident. A draft cannot do that.
 */
const duplicate = async (id, req) => {
  const source = await prisma.product.findUnique({
    where: { id },
    include: DETAIL_INCLUDE,
  });
  if (!source) throw ApiError.notFound('Product not found.');

  const slug = await uniqueSlug(`${source.slug}-copy`, async (candidate) => {
    const found = await prisma.product.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    return Boolean(found);
  });

  const product = await prisma.product.create({
    data: {
      title: `${source.title} (copy)`,
      slug,
      type: source.type,
      status: 'DRAFT',
      publishedAt: null,
      sku: null, // a duplicated SKU is never what anyone wants
      regularPrice: source.regularPrice,
      salePrice: source.salePrice,
      cardExcerpt: source.cardExcerpt,
      excerpt: source.excerpt,
      overview: source.overview,
      excerptSecondary: source.excerptSecondary,
      profiles: source.profiles,
      badges: source.badges ?? undefined,
      ribbon: source.ribbon,
      menuOrder: source.menuOrder,
      isFeatured: false,
      sampleType: source.sampleType,
      fastingRequired: source.fastingRequired,
      fastingNote: source.fastingNote,
      turnaroundHours: source.turnaroundHours,
      reportFormat: source.reportFormat,
      parametersUnavailable: source.parametersUnavailable,
      showAllParametersCta: source.showAllParametersCta,
      metaTitle: source.metaTitle,
      metaDescription: source.metaDescription,
      cardImageId: source.cardImageId,
      detailImageId: source.detailImageId,
      archiveImageId: source.archiveImageId,

      parameters: { create: source.parameters.map((p) => ({ name: p.name, order: p.order })) },
      highlights: { create: source.highlights.map((h) => ({ name: h.name, order: h.order })) },
      parameterGroups: {
        create: source.parameterGroups.map((g) => ({
          name: g.name,
          summary: g.summary,
          order: g.order,
          items: { create: g.items.map((i) => ({ name: i.name, order: i.order })) },
        })),
      },
      preparation: {
        create: source.preparation.map((s) => ({
          title: s.title, text: s.text, icon: s.icon, order: s.order,
        })),
      },
      process: {
        create: source.process.map((s) => ({ icon: s.icon, text: s.text, order: s.order })),
      },
      audience: { create: source.audience.map((a) => ({ text: a.text, order: a.order })) },
      faqs: {
        create: source.faqs.map((f) => ({
          question: f.question, answer: f.answer, order: f.order,
        })),
      },
      categories: { create: source.categories.map((c) => ({ categoryId: c.categoryId })) },
      tags: { create: source.tags.map((t) => ({ tagId: t.tagId })) },
    },
    include: DETAIL_INCLUDE,
  });

  await writeAudit({
    req,
    action: 'product.duplicated',
    entityType: 'Product',
    entityId: product.id,
    after: { from: id, slug: product.slug },
  });

  return serializer.toAdmin(product);
};

const remove = async (id, req) => {
  const existing = await prisma.product.findUnique({
    where: { id },
    select: { id: true, slug: true, title: true, _count: { select: { orderItems: true } } },
  });
  if (!existing) throw ApiError.notFound('Product not found.');

  /*
   * A product that has been ordered is never deleted.
   *
   * OrderItem snapshots the title and price, so history would survive — but the
   * product link would break, and "why does this old order point at nothing"
   * is a worse problem than an archived row. Archiving is the correct action.
   */
  if (existing._count.orderItems > 0) {
    throw ApiError.conflict(
      'This product has been ordered, so it cannot be deleted. Archive it instead.',
    );
  }

  await prisma.product.delete({ where: { id } });

  await writeAudit({
    req,
    action: 'product.deleted',
    entityType: 'Product',
    entityId: id,
    before: { slug: existing.slug, title: existing.title },
  });
};

/** Drag-to-reorder in the admin sends the whole visible order at once. */
const reorder = async (ids, req) => {
  await prisma.$transaction(
    ids.map((id, menuOrder) =>
      prisma.product.update({ where: { id }, data: { menuOrder } }),
    ),
  );
  await writeAudit({
    req,
    action: 'product.reordered',
    entityType: 'Product',
    after: { ids },
  });
};

const bulk = async ({ ids, action, value }, req) => {
  const data = {
    publish: { status: 'PUBLISHED' },
    draft: { status: 'DRAFT' },
    archive: { status: 'ARCHIVED' },
    feature: { isFeatured: true },
    unfeature: { isFeatured: false },
  }[action];

  if (!data) throw ApiError.badRequest(`Unknown bulk action: ${action}`);

  const result = await prisma.product.updateMany({ where: { id: { in: ids } }, data });

  // Newly published products need a publish date if they have never had one.
  if (action === 'publish') {
    await prisma.product.updateMany({
      where: { id: { in: ids }, publishedAt: null },
      data: { publishedAt: new Date() },
    });
  }

  await writeAudit({
    req,
    action: `product.bulk_${action}`,
    entityType: 'Product',
    after: { ids, value, count: result.count },
  });

  return { updated: result.count };
};

module.exports = {
  listPublic,
  getPublicBySlug,
  getRelated,
  listAdmin,
  getAdminById,
  create,
  update,
  setStatus,
  duplicate,
  remove,
  reorder,
  bulk,
  CARD_INCLUDE,
  DETAIL_INCLUDE,
};
