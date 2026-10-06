// Pagination, in one shape across every list endpoint.

const { z } = require('zod');

const MAX_LIMIT = 100;

const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  // Capped so a client cannot ask for the whole table and stall a remote
  // database round trip.
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(20),
});

const toSkipTake = ({ page, limit }) => ({ skip: (page - 1) * limit, take: limit });

const paginated = (items, total, { page, limit }) => ({
  items,
  pagination: {
    page,
    limit,
    total,
    pages: Math.max(1, Math.ceil(total / limit)),
    hasNext: page * limit < total,
    hasPrev: page > 1,
  },
});

module.exports = { pageQuery, toSkipTake, paginated, MAX_LIMIT };
