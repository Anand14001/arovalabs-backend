const { z } = require('zod');

// Indian mobile numbers, tolerant of the ways people type them.
const phone = z
  .string()
  .trim()
  .min(8, 'Enter a phone number.')
  .max(20)
  .refine((v) => /^[+]?[\d\s-]{8,20}$/.test(v), 'Enter a valid phone number.');

const patient = z.object({
  name: z.string().trim().min(1, 'Enter the patient’s name.').max(191),
  age: z.number().int().min(0).max(130).nullable().optional(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'UNDISCLOSED']).default('UNDISCLOSED'),
  phone: phone.nullable().optional(),
  relation: z.string().trim().max(64).nullable().optional(),
});

const address = z.object({
  line1: z.string().trim().min(1, 'Enter the address.').max(255),
  line2: z.string().trim().max(255).nullable().optional(),
  landmark: z.string().trim().max(255).nullable().optional(),
  city: z.string().trim().min(1, 'Enter the city.').max(120),
  state: z.string().trim().min(1, 'Enter the state.').max(120),
  pincode: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter a 6-digit pincode.'),
  phone: phone.nullable().optional(),
});

const placeOrderSchema = {
  body: z
    .object({
      cartToken: z.string().trim().min(10).max(64),

      contact: z.object({
        name: z.string().trim().min(1, 'Enter your name.').max(191),
        phone,
        email: z.string().trim().email('Enter a valid email.').max(191).nullable().optional(),
      }),

      // At least one patient, capped so nobody posts a thousand.
      patients: z.array(patient).min(1, 'Add at least one patient.').max(10),

      collectionType: z.enum(['HOME', 'WALK_IN']).default('HOME'),
      centerId: z.number().int().positive().nullable().optional(),
      address: address.nullable().optional(),

      collectionDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a collection date.'),
      collectionWindow: z.string().trim().min(1, 'Choose a collection time.').max(32),

      notes: z.string().trim().max(2000).nullable().optional(),
    })
    .superRefine((v, ctx) => {
      // A home collection without an address is the one combination that cannot
      // be fulfilled, so it is rejected here rather than discovered by a
      // phlebotomist with nowhere to go.
      if (v.collectionType === 'HOME' && !v.address) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['address'],
          message: 'Enter the address for home collection.',
        });
      }
    }),
};

const lookupSchema = {
  params: z.object({ orderNumber: z.string().trim().min(3).max(32) }),
  query: z.object({ token: z.string().trim().min(10).max(64) }),
};

const verifyPaymentSchema = {
  body: z.object({
    razorpayOrderId: z.string().trim().min(1).max(191),
    razorpayPaymentId: z.string().trim().min(1).max(191),
    signature: z.string().trim().min(1).max(255),
  }),
};

module.exports = { placeOrderSchema, lookupSchema, verifyPaymentSchema };
