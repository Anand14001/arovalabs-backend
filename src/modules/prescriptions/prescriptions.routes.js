/*
 * Prescriptions.
 *
 * The reference site's /upload-prescription/ form discarded whatever it was
 * given. Here it becomes a lead pipeline: someone photographs a doctor's
 * prescription, the lab reads it, quotes the tests, and can turn it into a draft
 * order without retyping the customer's details.
 *
 * The file is patient data, so it goes to private storage and is only ever
 * served to a signed-in admin.
 */

const { Router } = require('express');
const multer = require('multer');
const { z } = require('zod');
const asyncHandler = require('../../lib/asyncHandler');
const validate = require('../../middleware/validate');
const { formLimiter } = require('../../middleware/rateLimit');
const { requireAdmin } = require('../../middleware/requireAdmin');
const prisma = require('../../lib/prisma');
const ApiError = require('../../lib/ApiError');
const storage = require('../../lib/storage');
const fileType = require('../../lib/fileType');
const env = require('../../config/env');
const { writeAudit } = require('../../lib/audit');
const { sendPrivateFile } = require('../../lib/signedFile');
const { pageQuery, toSkipTake, paginated } = require('../../lib/pagination');

// Buffered so the bytes can be checked before anything touches the filesystem.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
});

// A photo of a prescription, or a scan. Nothing else is useful here.
const ALLOWED = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf',
]);

const serialize = (p) => ({
  id: p.id,
  patientName: p.patientName,
  phone: p.phone,
  email: p.email,
  notes: p.notes,
  status: p.status,
  internalNotes: p.internalNotes,
  reviewedBy: p.reviewedBy?.name ?? null,
  reviewedAt: p.reviewedAt,
  linkedOrder: p.linkedOrder
    ? { id: p.linkedOrder.id, orderNumber: p.linkedOrder.orderNumber }
    : null,
  file: p.upload
    ? {
        originalName: p.upload.originalName,
        mimeType: p.upload.mimeType,
        sizeBytes: p.upload.sizeBytes,
        // Deliberately no URL: the only way to the bytes is the admin download
        // route, which checks authentication first.
        isImage: p.upload.mimeType.startsWith('image/'),
      }
    : null,
  createdAt: p.createdAt,
});

const INCLUDE = {
  upload: true,
  reviewedBy: { select: { name: true } },
  linkedOrder: { select: { id: true, orderNumber: true } },
};

// ---------------------------------------------------------------- public

const publicRouter = Router();

publicRouter.post(
  '/',
  formLimiter,
  upload.single('file'),
  validate({
    body: z.object({
      patientName: z.string().trim().min(1, 'Enter the patient’s name.').max(191),
      phone: z
        .string()
        .trim()
        .min(8, 'Enter a phone number.')
        .max(20)
        .refine((v) => /^[+]?[\d\s-]{8,20}$/.test(v), 'Enter a valid phone number.'),
      email: z.string().trim().email('Enter a valid email.').max(191).optional().nullable(),
      notes: z.string().trim().max(2000).optional().nullable(),
    }),
  }),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      throw ApiError.unprocessable('Validation failed.', {
        file: 'Attach a photo or PDF of the prescription.',
      });
    }

    // The declared type and the extension are both client-supplied; the bytes
    // are not.
    const detected = fileType.detect(req.file.buffer);
    if (!detected || !ALLOWED.has(detected.mime)) {
      throw ApiError.unprocessable('Validation failed.', {
        file: 'Upload a photo (JPG, PNG) or a PDF.',
      });
    }

    const saved = await storage.save(req.file.buffer, {
      kind: 'PRESCRIPTION',
      originalName: req.file.originalname,
      mimeType: detected.mime,
    });

    const record = await prisma.prescription.create({
      data: {
        patientName: req.body.patientName,
        phone: req.body.phone,
        email: req.body.email ?? null,
        notes: req.body.notes ?? null,
        status: 'RECEIVED',
        upload: {
          create: {
            kind: 'PRESCRIPTION',
            originalName: req.file.originalname.slice(0, 255),
            storedPath: saved.storedPath,
            mimeType: detected.mime,
            sizeBytes: saved.sizeBytes,
            checksum: saved.checksum,
            scanStatus: 'SKIPPED',
          },
        },
      },
      include: INCLUDE,
    });

    await writeAudit({
      req,
      action: 'prescription.received',
      entityType: 'Prescription',
      entityId: record.id,
      after: { patientName: record.patientName, phone: record.phone },
    });

    /*
     * The response says what happens next rather than just "ok". Someone who
     * has photographed a prescription wants to know a human will look at it.
     */
    res.status(201).json({
      ok: true,
      reference: `RX-${String(record.id).padStart(5, '0')}`,
      message: 'We have your prescription. Our team will call you with a quote.',
    });
  }),
);

// ----------------------------------------------------------------- admin

const adminRouter = Router();

adminRouter.use(requireAdmin);

adminRouter.get(
  '/',
  validate({
    query: pageQuery.extend({
      status: z.enum(['RECEIVED', 'REVIEWED', 'QUOTED', 'CONVERTED', 'REJECTED']).optional(),
      q: z.string().trim().max(120).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { page, limit, status, q } = req.query;

    const where = {
      ...(status ? { status } : {}),
      ...(q
        ? {
            OR: [
              { patientName: { contains: q, mode: 'insensitive' } },
              { phone: { contains: q } },
              { email: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [items, total] = await prisma.$transaction([
      prisma.prescription.findMany({
        where,
        include: INCLUDE,
        orderBy: { createdAt: 'desc' },
        ...toSkipTake({ page, limit }),
      }),
      prisma.prescription.count({ where }),
    ]);

    res.json(paginated(items.map(serialize), total, { page, limit }));
  }),
);

adminRouter.get(
  '/counts',
  asyncHandler(async (_req, res) => {
    const rows = await prisma.prescription.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    const counts = Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
    counts.ALL = rows.reduce((sum, r) => sum + r._count._all, 0);
    res.json({ counts });
  }),
);

const idParam = { params: z.object({ id: z.coerce.number().int().positive() }) };

adminRouter.get(
  '/:id',
  validate(idParam),
  asyncHandler(async (req, res) => {
    const record = await prisma.prescription.findUnique({
      where: { id: req.params.id },
      include: INCLUDE,
    });
    if (!record) throw ApiError.notFound('Prescription not found.');
    res.json({ prescription: serialize(record) });
  }),
);

/*
 * The only route to the bytes, and it is behind requireAdmin.
 *
 * Every download is written to the audit log: who opened whose prescription and
 * when is exactly the question that gets asked after a data incident.
 */
adminRouter.get(
  '/:id/download',
  validate(idParam),
  asyncHandler(async (req, res) => {
    const record = await prisma.prescription.findUnique({
      where: { id: req.params.id },
      include: { upload: true },
    });
    if (!record?.upload) throw ApiError.notFound('Prescription not found.');

    await writeAudit({
      req,
      action: 'prescription.downloaded',
      entityType: 'Prescription',
      entityId: record.id,
      after: { patientName: record.patientName },
    });

    await sendPrivateFile(res, record.upload, {
      filename: `prescription-${record.id}-${record.patientName}`,
    });
  }),
);

adminRouter.patch(
  '/:id',
  validate({
    ...idParam,
    body: z.object({
      status: z
        .enum(['RECEIVED', 'REVIEWED', 'QUOTED', 'CONVERTED', 'REJECTED'])
        .optional(),
      internalNotes: z.string().trim().max(5000).optional().nullable(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const existing = await prisma.prescription.findUnique({ where: { id: req.params.id } });
    if (!existing) throw ApiError.notFound('Prescription not found.');

    const record = await prisma.prescription.update({
      where: { id: req.params.id },
      data: {
        ...req.body,
        // Stamp the reviewer the first time it moves off RECEIVED, so "who
        // handled this" survives later status changes.
        ...(req.body.status && req.body.status !== 'RECEIVED' && !existing.reviewedAt
          ? { reviewedById: req.user.id, reviewedAt: new Date() }
          : {}),
      },
      include: INCLUDE,
    });

    await writeAudit({
      req,
      action: 'prescription.updated',
      entityType: 'Prescription',
      entityId: record.id,
      before: { status: existing.status },
      after: { status: record.status },
    });

    res.json({ prescription: serialize(record) });
  }),
);

/*
 * Link a prescription to an order that was placed for it.
 *
 * Deliberately a link, not an order-creating action: the tests to book come off
 * a doctor's handwriting and a phone call, and no automatic reading of that is
 * trustworthy enough to charge someone for.
 */
adminRouter.post(
  '/:id/link-order',
  validate({
    ...idParam,
    body: z.object({ orderNumber: z.string().trim().min(3).max(32) }),
  }),
  asyncHandler(async (req, res) => {
    const order = await prisma.order.findUnique({
      where: { orderNumber: req.body.orderNumber.trim().toUpperCase() },
      select: { id: true, orderNumber: true },
    });
    if (!order) {
      throw ApiError.unprocessable('Validation failed.', {
        orderNumber: 'No order with that number.',
      });
    }

    const existing = await prisma.prescription.findUnique({
      where: { id: req.params.id },
      select: { reviewedAt: true },
    });
    if (!existing) throw ApiError.notFound('Prescription not found.');

    const record = await prisma.prescription.update({
      where: { id: req.params.id },
      data: {
        linkedOrderId: order.id,
        status: 'CONVERTED',
        // Only stamp the reviewer if nobody has been recorded yet.
        ...(existing.reviewedAt
          ? {}
          : { reviewedById: req.user.id, reviewedAt: new Date() }),
      },
      include: INCLUDE,
    });

    await writeAudit({
      req,
      action: 'prescription.linked_to_order',
      entityType: 'Prescription',
      entityId: record.id,
      after: { orderNumber: order.orderNumber },
    });

    res.json({ prescription: serialize(record) });
  }),
);

module.exports = { publicRouter, adminRouter };
