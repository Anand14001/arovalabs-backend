/*
 * Media library — images for products, categories, tags and content.
 *
 * Patient documents (prescriptions, reports) do not go through here: they are a
 * different kind with different rules and their own routes in step 6.
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
const { writeAudit } = require('../../lib/audit');
const { pageQuery, toSkipTake, paginated } = require('../../lib/pagination');

const router = Router();

router.use(requireAdmin);

/*
 * Buffered in memory, not streamed to disk.
 *
 * The bytes have to be inspected before anything is written, so that a file
 * which fails validation never reaches the filesystem at all. Limited to
 * MAX_UPLOAD_MB, which keeps the memory cost bounded.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 10 },
});

const ALLOWED_IMAGE_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/svg+xml',
]);

const serialize = (u) => ({
  id: u.id,
  kind: u.kind,
  url: storage.publicUrl(u),
  originalName: u.originalName,
  mimeType: u.mimeType,
  sizeBytes: u.sizeBytes,
  width: u.width ?? null,
  height: u.height ?? null,
  alt: u.altText ?? null,
  createdAt: u.createdAt,
});

/*
 * Image dimensions, read from the header bytes.
 *
 * Dimensions are useful in the picker (and for width/height attributes that
 * stop layout shift), but decoding images needs a native library, which cPanel
 * cannot reliably build. Reading the few bytes that carry the size avoids the
 * dependency entirely; anything unrecognised simply reports null.
 */
const readDimensions = (buffer, mime) => {
  try {
    if (mime === 'image/png' && buffer.length > 24) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }

    if (mime === 'image/gif' && buffer.length > 10) {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }

    if (mime === 'image/webp' && buffer.length > 30) {
      const format = buffer.slice(12, 16).toString('ascii');
      if (format === 'VP8 ') {
        return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
      }
      if (format === 'VP8L') {
        const bits = buffer.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (format === 'VP8X') {
        return {
          width: (buffer.readUIntLE(24, 3) & 0xffffff) + 1,
          height: (buffer.readUIntLE(27, 3) & 0xffffff) + 1,
        };
      }
    }

    if (mime === 'image/jpeg') {
      // Walk the segment markers to the frame header, which carries the size.
      let offset = 2;
      while (offset < buffer.length - 9) {
        if (buffer[offset] !== 0xff) break;
        const marker = buffer[offset + 1];
        const length = buffer.readUInt16BE(offset + 2);
        // SOF0..SOF15, excluding the non-frame markers in that range.
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return {
            height: buffer.readUInt16BE(offset + 5),
            width: buffer.readUInt16BE(offset + 7),
          };
        }
        offset += 2 + length;
      }
    }
  } catch {
    // Malformed header — not worth failing an upload over.
  }
  return { width: null, height: null };
};

router.get(
  '/',
  validate({
    query: pageQuery.extend({
      kind: z.enum(['PRODUCT_IMAGE', 'CONTENT_IMAGE']).optional(),
      q: z.string().trim().max(120).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { page, limit, kind, q } = req.query;

    // Only ever lists public kinds, so a patient document cannot surface in the
    // image picker even if its row were somehow mislabelled.
    const where = {
      kind: kind ? kind : { in: ['PRODUCT_IMAGE', 'CONTENT_IMAGE'] },
      ...(q ? { originalName: { contains: q, mode: 'insensitive' } } : {}),
    };

    const [items, total] = await prisma.$transaction([
      prisma.upload.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...toSkipTake({ page, limit }),
      }),
      prisma.upload.count({ where }),
    ]);

    res.json(paginated(items.map(serialize), total, { page, limit }));
  }),
);

router.post(
  '/',
  upload.array('files', 10),
  asyncHandler(async (req, res) => {
    const files = req.files ?? [];
    if (!files.length) throw ApiError.badRequest('No files were uploaded.');

    const kind = req.body.kind === 'CONTENT_IMAGE' ? 'CONTENT_IMAGE' : 'PRODUCT_IMAGE';

    const created = [];
    const rejected = [];

    for (const file of files) {
      const detected = fileType.detect(file.buffer);

      if (!detected || !ALLOWED_IMAGE_MIMES.has(detected.mime)) {
        rejected.push({
          name: file.originalname,
          reason: detected
            ? `${detected.mime} is not an allowed image type.`
            : 'Not a recognised image file.',
        });
        continue;
      }

      if (detected.mime === 'image/svg+xml' && fileType.svgIsSuspicious(file.buffer)) {
        rejected.push({
          name: file.originalname,
          reason: 'That SVG contains script or external references.',
        });
        continue;
      }

      const saved = await storage.save(file.buffer, {
        kind,
        originalName: file.originalname,
        mimeType: detected.mime,
      });

      const { width, height } = readDimensions(file.buffer, detected.mime);

      const row = await prisma.upload.create({
        data: {
          kind,
          originalName: file.originalname.slice(0, 255),
          storedPath: saved.storedPath,
          // The detected type, never the declared one.
          mimeType: detected.mime,
          sizeBytes: saved.sizeBytes,
          checksum: saved.checksum,
          width,
          height,
          altText: req.body.alt ? String(req.body.alt).slice(0, 255) : null,
          uploadedById: req.user.id,
          scanStatus: 'SKIPPED',
        },
      });

      created.push(serialize(row));
    }

    await writeAudit({
      req,
      action: 'media.uploaded',
      entityType: 'Upload',
      after: { created: created.map((c) => c.id), rejected },
    });

    // 207 when some succeeded and some did not, so the client can show both
    // rather than treating a partial upload as a flat success or failure.
    res.status(rejected.length && created.length ? 207 : created.length ? 201 : 422).json({
      items: created,
      rejected,
    });
  }),
);

router.patch(
  '/:id',
  validate({
    params: z.object({ id: z.coerce.number().int().positive() }),
    body: z.object({ alt: z.string().trim().max(255).nullable() }),
  }),
  asyncHandler(async (req, res) => {
    const row = await prisma.upload.update({
      where: { id: req.params.id },
      data: { altText: req.body.alt },
    });
    res.json({ item: serialize(row) });
  }),
);

router.delete(
  '/:id',
  validate({ params: z.object({ id: z.coerce.number().int().positive() }) }),
  asyncHandler(async (req, res) => {
    const row = await prisma.upload.findUnique({ where: { id: req.params.id } });
    if (!row) throw ApiError.notFound('File not found.');

    /*
     * Refuse while anything still points at it.
     *
     * The foreign keys are onDelete: SetNull, so deleting would succeed and
     * quietly blank the image on whatever was using it. Better to say which
     * products are in the way.
     */
    const [products, categories, tags] = await prisma.$transaction([
      prisma.product.count({
        where: {
          OR: [
            { cardImageId: row.id },
            { detailImageId: row.id },
            { archiveImageId: row.id },
          ],
        },
      }),
      prisma.category.count({ where: { imageId: row.id } }),
      prisma.tag.count({ where: { iconId: row.id } }),
    ]);

    const inUse = products + categories + tags;
    if (inUse > 0) {
      throw ApiError.conflict(
        `This image is still used by ${inUse} item(s). Replace it there first.`,
      );
    }

    // Row first, then the file: an orphaned file wastes disk, but a row
    // pointing at a missing file renders as a broken image.
    await prisma.upload.delete({ where: { id: row.id } });
    await storage.remove(row.storedPath);

    await writeAudit({
      req,
      action: 'media.deleted',
      entityType: 'Upload',
      entityId: row.id,
      before: { originalName: row.originalName, storedPath: row.storedPath },
    });

    res.status(204).end();
  }),
);

module.exports = router;
