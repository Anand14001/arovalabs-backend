/*
 * Lab reports.
 *
 * The most sensitive thing this system holds. Three rules shape the design:
 *
 *   1. **Uploading is not publishing.** A report sits in UPLOADED until someone
 *      deliberately publishes it. Sending a wrong result to the wrong person is
 *      not an error you can take back, so the destructive-ish step is explicit.
 *   2. **Links expire and are revocable.** Delivery is a random token with an
 *      expiry, so a forwarded WhatsApp message stops working. Withdrawing a
 *      report clears the token immediately.
 *   3. **Every download is logged.** After an incident, "who opened this and
 *      when" has to be answerable.
 */

const { Router } = require('express');
const multer = require('multer');
const { z } = require('zod');
const asyncHandler = require('../../lib/asyncHandler');
const validate = require('../../middleware/validate');
const { requireAdmin } = require('../../middleware/requireAdmin');
const prisma = require('../../lib/prisma');
const ApiError = require('../../lib/ApiError');
const storage = require('../../lib/storage');
const fileType = require('../../lib/fileType');
const env = require('../../config/env');
const settings = require('../../lib/settings');
const { writeAudit } = require('../../lib/audit');
const { sendMail } = require('../../lib/mailer');
const { newToken, sendPrivateFile } = require('../../lib/signedFile');
const { pageQuery, toSkipTake, paginated } = require('../../lib/pagination');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 10 },
});

// A lab report is a PDF. Images are accepted because some analysers emit them,
// but nothing else belongs here.
const ALLOWED = new Set(['application/pdf', 'image/jpeg', 'image/png']);

const TOKEN_TTL_DAYS = 90;
const tokenExpiry = () => new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

const INCLUDE = {
  upload: true,
  patient: { select: { id: true, name: true } },
  orderItem: { select: { id: true, productTitle: true } },
  publishedBy: { select: { name: true } },
  order: { select: { id: true, orderNumber: true, contactName: true, contactEmail: true, contactPhone: true } },
};

const serialize = (r) => ({
  id: r.id,
  title: r.title,
  status: r.status,
  order: r.order
    ? { id: r.order.id, orderNumber: r.order.orderNumber, contactName: r.order.contactName }
    : null,
  patient: r.patient ? { id: r.patient.id, name: r.patient.name } : null,
  test: r.orderItem ? r.orderItem.productTitle : null,
  file: r.upload
    ? {
        originalName: r.upload.originalName,
        mimeType: r.upload.mimeType,
        sizeBytes: r.upload.sizeBytes,
      }
    : null,
  publishedAt: r.publishedAt,
  publishedBy: r.publishedBy?.name ?? null,
  // The token itself is never serialised — only whether delivery is live.
  isShareable: Boolean(r.accessToken && r.tokenExpiresAt && r.tokenExpiresAt > new Date()),
  tokenExpiresAt: r.tokenExpiresAt,
  downloadCount: r.downloadCount,
  lastDownloadedAt: r.lastDownloadedAt,
  deliveredViaEmail: r.deliveredViaEmail,
  deliveredViaWhatsapp: r.deliveredViaWhatsapp,
  withdrawnReason: r.withdrawnReason,
  createdAt: r.createdAt,
});

const shareUrl = (token) => `${env.PUBLIC_URL}/report/?token=${token}`;

// ---------------------------------------------------------------- public

const publicRouter = Router();

/*
 * Report download by token.
 *
 * No account, no order number — the token is the credential, which is what
 * makes an emailed or WhatsApped link work at all. It is long, random, expiring
 * and revocable, and this route deliberately gives the same answer for "no such
 * token", "expired" and "withdrawn": a probe learns nothing from the difference.
 */
publicRouter.get(
  '/:token',
  validate({ params: z.object({ token: z.string().trim().min(20).max(64) }) }),
  asyncHandler(async (req, res) => {
    const report = await prisma.report.findUnique({
      where: { accessToken: req.params.token },
      include: { upload: true, order: { select: { orderNumber: true } }, patient: true },
    });

    const usable =
      report &&
      report.status === 'PUBLISHED' &&
      report.tokenExpiresAt &&
      report.tokenExpiresAt > new Date();

    if (!usable) {
      throw ApiError.notFound(
        'This report link is no longer valid. Please contact us for a new one.',
      );
    }

    await prisma.report.update({
      where: { id: report.id },
      data: { downloadCount: { increment: 1 }, lastDownloadedAt: new Date() },
    });

    await writeAudit({
      req,
      action: 'report.downloaded',
      entityType: 'Report',
      entityId: report.id,
      after: { orderNumber: report.order?.orderNumber, count: report.downloadCount + 1 },
    });

    await sendPrivateFile(res, report.upload, {
      filename: `${report.title}-${report.patient?.name ?? 'report'}.pdf`,
    });
  }),
);

/** Lets the download page say something useful before triggering the download. */
publicRouter.get(
  '/:token/meta',
  validate({ params: z.object({ token: z.string().trim().min(20).max(64) }) }),
  asyncHandler(async (req, res) => {
    const report = await prisma.report.findUnique({
      where: { accessToken: req.params.token },
      include: { order: { select: { orderNumber: true } }, patient: true, upload: true },
    });

    const usable =
      report &&
      report.status === 'PUBLISHED' &&
      report.tokenExpiresAt &&
      report.tokenExpiresAt > new Date();

    if (!usable) throw ApiError.notFound('This report link is no longer valid.');

    res.json({
      report: {
        title: report.title,
        patientName: report.patient?.name ?? null,
        orderNumber: report.order?.orderNumber ?? null,
        publishedAt: report.publishedAt,
        expiresAt: report.tokenExpiresAt,
        sizeBytes: report.upload?.sizeBytes ?? null,
      },
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
      status: z.enum(['PENDING', 'UPLOADED', 'PUBLISHED', 'WITHDRAWN']).optional(),
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
              { title: { contains: q, mode: 'insensitive' } },
              { order: { orderNumber: { contains: q, mode: 'insensitive' } } },
              { order: { contactName: { contains: q, mode: 'insensitive' } } },
              { patient: { name: { contains: q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const [items, total] = await prisma.$transaction([
      prisma.report.findMany({
        where,
        include: INCLUDE,
        orderBy: { createdAt: 'desc' },
        ...toSkipTake({ page, limit }),
      }),
      prisma.report.count({ where }),
    ]);

    res.json(paginated(items.map(serialize), total, { page, limit }));
  }),
);

/*
 * Orders whose reports are outstanding, ordered by how overdue they are.
 *
 * This is the lab's actual worklist: a sample is in, the customer was promised
 * a turnaround, and nothing has been uploaded yet.
 */
adminRouter.get(
  '/awaiting',
  asyncHandler(async (_req, res) => {
    const orders = await prisma.order.findMany({
      where: {
        status: { in: ['SAMPLE_COLLECTED', 'IN_LAB', 'REPORT_READY'] },
      },
      include: {
        items: true,
        patients: true,
        reports: { select: { id: true, status: true } },
      },
      orderBy: { slotDate: 'asc' },
      take: 100,
    });

    const items = orders
      .map((o) => {
        const published = o.reports.filter((r) => r.status === 'PUBLISHED').length;
        return {
          id: o.id,
          orderNumber: o.orderNumber,
          contactName: o.contactName,
          status: o.status,
          collectedOn: o.slotDate,
          testCount: o.items.length,
          patientCount: o.patients.length,
          reportsPublished: published,
          reportsTotal: o.reports.length,
          // The turnaround promise lives on the product; surfacing "how long has
          // this been sitting" is what makes the queue actionable.
          daysSinceCollection: o.slotDate
            ? Math.floor((Date.now() - new Date(o.slotDate).getTime()) / 86_400_000)
            : null,
        };
      })
      .filter((o) => o.reportsPublished < o.testCount)
      .sort((a, b) => (b.daysSinceCollection ?? 0) - (a.daysSinceCollection ?? 0));

    res.json({ items });
  }),
);

/*
 * Upload one or more report files against an order.
 *
 * Mapping to a patient and a test is optional — a single combined PDF for a
 * whole family is how a lot of small labs actually work, and forcing a mapping
 * that does not exist would mean staff inventing one.
 */
adminRouter.post(
  '/orders/:orderId',
  validate({ params: z.object({ orderId: z.coerce.number().int().positive() }) }),
  upload.array('files', 10),
  asyncHandler(async (req, res) => {
    const order = await prisma.order.findUnique({
      where: { id: req.params.orderId },
      include: { patients: true, items: true },
    });
    if (!order) throw ApiError.notFound('Order not found.');

    const files = req.files ?? [];
    if (!files.length) throw ApiError.badRequest('No files were uploaded.');

    const patientId = req.body.orderPatientId ? Number(req.body.orderPatientId) : null;
    const orderItemId = req.body.orderItemId ? Number(req.body.orderItemId) : null;

    if (patientId && !order.patients.some((p) => p.id === patientId)) {
      throw ApiError.unprocessable('Validation failed.', {
        orderPatientId: 'That patient is not on this order.',
      });
    }
    if (orderItemId && !order.items.some((i) => i.id === orderItemId)) {
      throw ApiError.unprocessable('Validation failed.', {
        orderItemId: 'That test is not on this order.',
      });
    }

    const created = [];
    const rejected = [];

    for (const file of files) {
      const detected = fileType.detect(file.buffer);
      if (!detected || !ALLOWED.has(detected.mime)) {
        rejected.push({ name: file.originalname, reason: 'Upload a PDF, JPG or PNG.' });
        continue;
      }

      const saved = await storage.save(file.buffer, {
        kind: 'REPORT',
        originalName: file.originalname,
        mimeType: detected.mime,
      });

      /*
       * The Upload row is created first, then the Report that points at it.
       *
       * Not a nested write: `Report.uploadId` is an optional one-to-one, and
       * Prisma will not accept a nested create through it. Doing it in two
       * steps is better here anyway — if the report insert fails, the orphaned
       * row and its file are cleaned up rather than left behind as a file
       * nothing references.
       */
      const uploadRow = await prisma.upload.create({
        data: {
          kind: 'REPORT',
          originalName: file.originalname.slice(0, 255),
          storedPath: saved.storedPath,
          mimeType: detected.mime,
          sizeBytes: saved.sizeBytes,
          checksum: saved.checksum,
          uploadedById: req.user.id,
          orderId: order.id,
          scanStatus: 'SKIPPED',
        },
      });

      try {
        const report = await prisma.report.create({
          data: {
            orderId: order.id,
            orderItemId,
            orderPatientId: patientId,
            uploadId: uploadRow.id,
            title:
              (req.body.title && String(req.body.title).slice(0, 255)) ||
              file.originalname.replace(/\.[^.]+$/, '').slice(0, 255),
            // Uploaded, not published. Publishing is a separate, deliberate act.
            status: 'UPLOADED',
          },
          include: INCLUDE,
        });

        created.push(serialize(report));
      } catch (err) {
        await prisma.upload.delete({ where: { id: uploadRow.id } }).catch(() => {});
        await storage.remove(saved.storedPath);
        throw err;
      }
    }

    await writeAudit({
      req,
      action: 'report.uploaded',
      entityType: 'Order',
      entityId: order.id,
      after: { created: created.map((c) => c.id), rejected },
    });

    res.status(rejected.length && created.length ? 207 : created.length ? 201 : 422).json({
      items: created,
      rejected,
    });
  }),
);

const idParam = { params: z.object({ id: z.coerce.number().int().positive() }) };

/*
 * One report in full.
 *
 * Declared after /awaiting so that path is not read as an id — Express matches
 * in declaration order.
 */
adminRouter.get(
  '/:id',
  validate(idParam),
  asyncHandler(async (req, res) => {
    const report = await prisma.report.findUnique({
      where: { id: req.params.id },
      include: INCLUDE,
    });
    if (!report) throw ApiError.notFound('Report not found.');
    res.json({ report: serialize(report) });
  }),
);

/** Admin preview — authenticated, and logged like any other access. */
adminRouter.get(
  '/:id/download',
  validate(idParam),
  asyncHandler(async (req, res) => {
    const report = await prisma.report.findUnique({
      where: { id: req.params.id },
      include: { upload: true, patient: true },
    });
    if (!report?.upload) throw ApiError.notFound('Report not found.');

    await writeAudit({
      req,
      action: 'report.viewed_by_staff',
      entityType: 'Report',
      entityId: report.id,
    });

    await sendPrivateFile(res, report.upload, { filename: report.title });
  }),
);

/*
 * Publish: mint the share token and move the order along.
 *
 * Nothing is emailed here — `notify` is a separate call, so publishing can be
 * done in bulk by the lab and the sending decided separately.
 */
adminRouter.post(
  '/:id/publish',
  validate(idParam),
  asyncHandler(async (req, res) => {
    const existing = await prisma.report.findUnique({
      where: { id: req.params.id },
      include: { order: true },
    });
    if (!existing) throw ApiError.notFound('Report not found.');
    if (!existing.uploadId) throw ApiError.conflict('There is no file on this report yet.');

    const report = await prisma.$transaction(async (tx) => {
      const updated = await tx.report.update({
        where: { id: existing.id },
        data: {
          status: 'PUBLISHED',
          publishedAt: new Date(),
          publishedById: req.user.id,
          // A fresh token on every publish, so re-publishing after a withdrawal
          // invalidates the old link rather than reviving it.
          accessToken: newToken(),
          tokenExpiresAt: tokenExpiry(),
          withdrawnReason: null,
        },
        include: INCLUDE,
      });

      if (['SAMPLE_COLLECTED', 'IN_LAB'].includes(existing.order.status)) {
        await tx.order.update({
          where: { id: existing.orderId },
          data: { status: 'REPORT_READY' },
        });
        await tx.orderStatusEvent.create({
          data: {
            orderId: existing.orderId,
            fromStatus: existing.order.status,
            toStatus: 'REPORT_READY',
            note: `Report published: ${updated.title}`,
            actorId: req.user.id,
          },
        });
      }

      return updated;
    });

    await writeAudit({
      req,
      action: 'report.published',
      entityType: 'Report',
      entityId: report.id,
      after: { orderNumber: existing.order.orderNumber, title: report.title },
    });

    res.json({ report: serialize(report) });
  }),
);

/*
 * Withdraw: kill the link immediately.
 *
 * The file is kept — a withdrawn report is usually a corrected one, and the
 * original matters if anyone asks what was sent. The token is cleared, so the
 * link stops working the moment this returns.
 */
adminRouter.post(
  '/:id/withdraw',
  validate({
    ...idParam,
    body: z.object({ reason: z.string().trim().min(1, 'Give a reason.').max(500) }),
  }),
  asyncHandler(async (req, res) => {
    const report = await prisma.report.update({
      where: { id: req.params.id },
      data: {
        status: 'WITHDRAWN',
        accessToken: null,
        tokenExpiresAt: null,
        withdrawnReason: req.body.reason,
      },
      include: INCLUDE,
    });

    await writeAudit({
      req,
      action: 'report.withdrawn',
      entityType: 'Report',
      entityId: report.id,
      after: { reason: req.body.reason },
    });

    res.json({ report: serialize(report) });
  }),
);

/** Send the share link to the customer. */
adminRouter.post(
  '/:id/notify',
  validate(idParam),
  asyncHandler(async (req, res) => {
    const report = await prisma.report.findUnique({
      where: { id: req.params.id },
      include: INCLUDE,
    });
    if (!report) throw ApiError.notFound('Report not found.');
    if (report.status !== 'PUBLISHED' || !report.accessToken) {
      throw ApiError.conflict('Publish the report before sending it.');
    }
    if (!report.order?.contactEmail) {
      throw ApiError.conflict('This booking has no email address on it.');
    }

    const url = shareUrl(report.accessToken);
    const days = Math.round((report.tokenExpiresAt - Date.now()) / 86_400_000);

    const result = await sendMail({
      to: report.order.contactEmail,
      subject: `Your Arova Labs report is ready — ${report.order.orderNumber}`,
      text: [
        `Hello ${report.order.contactName},`,
        '',
        `Your report for ${report.order.orderNumber} is ready.`,
        '',
        'Download it here:',
        url,
        '',
        `This link works for ${days} days and is personal to you — please don't forward it.`,
        '',
        'Questions? Call 9442218998.',
      ].join('\n'),
    });

    if (result.sent) {
      await prisma.report.update({
        where: { id: report.id },
        data: { deliveredViaEmail: true, notifiedAt: new Date() },
      });
    }

    await writeAudit({
      req,
      action: 'report.notified',
      entityType: 'Report',
      entityId: report.id,
      after: { to: report.order.contactEmail, sent: result.sent },
    });

    // Honest: with no SMTP configured the mailer logs instead of sending, and
    // the admin is told that rather than shown a false success.
    res.json({ ...result, shareUrl: url });
  }),
);

/** The share link, for sending by hand over WhatsApp. */
adminRouter.get(
  '/:id/share-link',
  validate(idParam),
  asyncHandler(async (req, res) => {
    const report = await prisma.report.findUnique({ where: { id: req.params.id } });
    if (!report) throw ApiError.notFound('Report not found.');
    if (report.status !== 'PUBLISHED' || !report.accessToken) {
      throw ApiError.conflict('Publish the report before sharing it.');
    }

    await writeAudit({
      req,
      action: 'report.share_link_viewed',
      entityType: 'Report',
      entityId: report.id,
    });

    res.json({ url: shareUrl(report.accessToken), expiresAt: report.tokenExpiresAt });
  }),
);

adminRouter.delete(
  '/:id',
  validate(idParam),
  asyncHandler(async (req, res) => {
    const report = await prisma.report.findUnique({
      where: { id: req.params.id },
      include: { upload: true },
    });
    if (!report) throw ApiError.notFound('Report not found.');

    if (report.status === 'PUBLISHED') {
      // Deleting something a customer may already hold a link to is not a
      // deletion, it is a withdrawal — and should be recorded as one.
      throw ApiError.conflict('Withdraw the report before deleting it.');
    }

    await prisma.report.delete({ where: { id: report.id } });
    if (report.upload) {
      await prisma.upload.delete({ where: { id: report.upload.id } }).catch(() => {});
      await storage.remove(report.upload.storedPath);
    }

    await writeAudit({
      req,
      action: 'report.deleted',
      entityType: 'Report',
      entityId: report.id,
      before: { title: report.title },
    });

    res.status(204).end();
  }),
);

module.exports = { publicRouter, adminRouter };
