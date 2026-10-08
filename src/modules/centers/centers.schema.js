const { z } = require('zod');

const createCenterSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters.').max(191),
  slug: z.string().trim().max(191).optional(),
  address: z.string().trim().min(5, 'Address is required.'),
  city: z.string().trim().min(2, 'City is required.').max(120),
  state: z.string().trim().max(120).default('Tamil Nadu'),
  pincode: z.string().trim().max(16).optional().nullable(),
  phone: z.string().trim().max(64).optional().nullable(),
  email: z.string().trim().email('Invalid email').max(191).optional().nullable(),
  mapUrl: z.string().trim().url('Invalid URL').optional().nullable().or(z.literal('')),
  openingHours: z.any().optional().nullable(),
  isHomeCollectionHub: z.boolean().default(false),
  isActive: z.boolean().default(true),
  menuOrder: z.coerce.number().int().default(0),
});

const updateCenterSchema = createCenterSchema.partial();

const listCentersSchema = z.object({
  isActive: z.enum(['true', 'false', 'all']).optional(),
  city: z.string().trim().optional(),
  q: z.string().trim().optional(),
});

module.exports = {
  createCenterSchema,
  updateCenterSchema,
  listCentersSchema,
};
