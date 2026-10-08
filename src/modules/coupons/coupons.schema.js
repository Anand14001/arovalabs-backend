const { z } = require('zod');

const createCouponSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2, 'Code must be at least 2 characters.')
    .max(64)
    .transform((c) => c.toUpperCase()),
  description: z.string().trim().max(500).optional().nullable(),
  type: z.enum(['PERCENT', 'FIXED']),
  // Percent: e.g. 15 for 15%; Fixed: amount in Rupees e.g. 200 for ₹200
  value: z.coerce.number().positive('Value must be greater than zero.'),
  scope: z.enum(['ALL', 'PRODUCTS', 'CATEGORIES']).default('ALL'),
  // Amounts in Rupees from user input
  minOrderValue: z.coerce.number().min(0).optional().nullable(),
  maxDiscount: z.coerce.number().min(0).optional().nullable(),
  usageLimit: z.coerce.number().int().positive().optional().nullable(),
  perCustomerLimit: z.coerce.number().int().positive().optional().nullable(),
  startsAt: z.coerce.date().optional().nullable(),
  endsAt: z.coerce.date().optional().nullable(),
  isActive: z.boolean().default(true),
  productIds: z.array(z.number().int().positive()).optional(),
  categoryIds: z.array(z.number().int().positive()).optional(),
});

const updateCouponSchema = createCouponSchema.partial();

const listCouponsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['ACTIVE', 'INACTIVE', 'EXPIRED', 'UPCOMING', 'DEPLETED']).optional(),
  q: z.string().trim().optional(),
});

module.exports = {
  createCouponSchema,
  updateCouponSchema,
  listCouponsSchema,
};
