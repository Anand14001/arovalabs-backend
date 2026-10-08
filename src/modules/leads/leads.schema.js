const { z } = require('zod');

// Schema for enquiry / contact message submissions from the website
const createContactMessageSchema = z.object({
  name: z.string().trim().max(191).optional().nullable(),
  email: z.string().trim().email('Enter a valid email address so we can reply.').max(191),
  phone: z
    .string()
    .trim()
    .regex(/^[\d\s+()-]{7,18}$/, 'Enter a valid phone number, or leave this blank.')
    .optional()
    .or(z.literal(''))
    .nullable(),
  topic: z.string().trim().max(64).optional().default('General'),
  message: z.string().trim().min(5, 'Tell us how we can help.').max(5000),
  source: z.string().trim().max(64).optional().default('website_contact'),
  // Honeypot field for bot mitigation. Must be blank or undefined.
  website_hp: z.string().max(0, 'Spam detected').optional(),
});

// Admin list query filter
const listContactMessagesSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['NEW', 'IN_PROGRESS', 'RESOLVED', 'SPAM']).optional(),
  q: z.string().trim().optional(),
});

// Admin update lead status & notes
const updateLeadSchema = z.object({
  status: z.enum(['NEW', 'IN_PROGRESS', 'RESOLVED', 'SPAM']).optional(),
  internalNotes: z.string().trim().max(5000).optional().nullable(),
  assignedToId: z.coerce.number().int().positive().optional().nullable(),
});

module.exports = {
  createContactMessageSchema,
  listContactMessagesSchema,
  updateLeadSchema,
};
