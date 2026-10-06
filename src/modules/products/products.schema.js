const { z } = require('zod');
const { pageQuery } = require('../../lib/pagination');

const ORDER_BY = [
  'menu_order', 'popularity', 'rating', 'date', 'price', 'price-desc', 'title',
];

const listQuery = {
  query: pageQuery.extend({
    type: z.enum(['TEST', 'PACKAGE']).optional(),
    category: z.string().trim().max(191).optional(),
    tag: z.string().trim().max(191).optional(),
    q: z.string().trim().max(120).optional(),
    // Filters come in as rupees because that is what a human types into the
    // admin's price box; the service compares against paise.
    minPrice: z.coerce.number().min(0).transform((v) => Math.round(v * 100)).optional(),
    maxPrice: z.coerce.number().min(0).transform((v) => Math.round(v * 100)).optional(),
    orderby: z.enum(ORDER_BY).default('menu_order'),
  }),
};

const adminListQuery = {
  query: listQuery.query.extend({
    status: z.enum(['DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED']).optional(),
    featured: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
  }),
};

const slugParam = { params: z.object({ slug: z.string().trim().min(1).max(191) }) };
const idParam = { params: z.object({ id: z.coerce.number().int().positive() }) };

// Prices arrive as rupees from the admin form and are stored as paise.
const priceField = z
  .number({ invalid_type_error: 'Enter a number.' })
  .min(0, 'Price cannot be negative.')
  .max(10_000_000, 'That price looks wrong.')
  .transform((v) => Math.round(v * 100));

const faq = z.object({
  question: z.string().trim().min(1, 'Question is required.').max(500),
  answer: z.string().trim().min(1, 'Answer is required.').max(5000),
});

const step = z.object({
  title: z.string().trim().max(255).optional().nullable(),
  text: z.string().trim().min(1, 'Text is required.').max(2000),
  icon: z.string().trim().max(255).optional().nullable(),
});

const parameterGroup = z.object({
  name: z.string().trim().min(1, 'Group name is required.').max(255),
  summary: z.string().trim().max(2000).optional().nullable(),
  items: z.array(z.string().trim().min(1).max(255)).default([]),
});

const productBody = z.object({
  title: z.string().trim().min(1, 'Title is required.').max(255),
  slug: z.string().trim().max(191).optional(),
  type: z.enum(['TEST', 'PACKAGE']),
  status: z.enum(['DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED']).default('DRAFT'),
  sku: z.string().trim().max(64).optional().nullable(),

  regularPrice: priceField,
  salePrice: priceField,

  cardExcerpt: z.string().trim().max(500).optional().nullable(),
  excerpt: z.string().trim().max(5000).optional().nullable(),
  excerptSecondary: z.string().trim().max(5000).optional().nullable(),
  profiles: z.string().trim().max(191).optional().nullable(),
  highlights: z.array(z.string().trim().min(1).max(255)).optional(),
  overview: z.string().trim().max(20000).optional().nullable(),

  badges: z.array(z.string().trim().max(80)).max(8).optional(),
  ribbon: z.string().trim().max(120).optional().nullable(),

  menuOrder: z.number().int().min(0).optional(),
  isFeatured: z.boolean().optional(),

  sampleType: z.string().trim().max(120).optional().nullable(),
  fastingRequired: z.boolean().optional(),
  fastingNote: z.string().trim().max(255).optional().nullable(),
  turnaroundHours: z.number().int().min(0).max(8760).optional().nullable(),
  reportFormat: z.string().trim().max(120).optional().nullable(),

  parameters: z.array(z.string().trim().min(1).max(255)).optional(),
  parametersUnavailable: z.boolean().optional(),
  parameterGroups: z.array(parameterGroup).optional(),
  showAllParametersCta: z.boolean().optional(),

  preparation: z.array(step).optional(),
  process: z.array(step).optional(),
  audience: z.array(z.string().trim().min(1).max(1000)).optional(),
  faqs: z.array(faq).optional(),

  categoryIds: z.array(z.number().int().positive()).optional(),
  tagIds: z.array(z.number().int().positive()).optional(),

  cardImageId: z.number().int().positive().nullable().optional(),
  detailImageId: z.number().int().positive().nullable().optional(),
  archiveImageId: z.number().int().positive().nullable().optional(),

  metaTitle: z.string().trim().max(255).optional().nullable(),
  metaDescription: z.string().trim().max(500).optional().nullable(),
});

const createSchema = { body: productBody };

// Every field optional on update, so the admin can save one tab at a time
// without having to send the whole product back.
const updateSchema = { ...idParam, body: productBody.partial() };

const statusSchema = {
  ...idParam,
  body: z.object({
    status: z.enum(['DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED']),
  }),
};

const reorderSchema = {
  body: z.object({
    ids: z.array(z.number().int().positive()).min(1).max(500),
  }),
};

const bulkSchema = {
  body: z.object({
    ids: z.array(z.number().int().positive()).min(1).max(500),
    action: z.enum(['publish', 'draft', 'archive', 'feature', 'unfeature']),
    value: z.any().optional(),
  }),
};

module.exports = {
  listQuery,
  adminListQuery,
  slugParam,
  idParam,
  createSchema,
  updateSchema,
  statusSchema,
  reorderSchema,
  bulkSchema,
};
