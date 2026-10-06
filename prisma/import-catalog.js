/*
 * One-way import of the website's static catalogue into the database.
 *
 * Reads website/src/data/{products,taxonomies}.js directly — they are plain ESM
 * modules with no imports, so a dynamic import gets the real exported objects
 * and nothing has to be retyped or kept in sync by hand.
 *
 * Idempotent: keyed on slug throughout, so re-running updates rather than
 * duplicating. Editorial fields are only written on create, because overwriting
 * them on every deploy would discard an admin's edits.
 *
 * Images referenced by the data files are copied out of website/public/assets
 * into the API's own storage and given Upload rows, so the admin can replace
 * them like any other upload instead of them being untouchable static files.
 */

const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const prisma = require('../src/lib/prisma');
const logger = require('../src/lib/logger');
const storage = require('../src/lib/storage');
const fileType = require('../src/lib/fileType');
const { toPaise } = require('../src/lib/money');

const WEBSITE = path.resolve(__dirname, '../../website');
const DATA_DIR = path.join(WEBSITE, 'src/data');
const ASSETS_DIR = path.join(WEBSITE, 'public');

const importData = async (file) =>
  import(pathToFileURL(path.join(DATA_DIR, file)).href);

// ------------------------------------------------------------------ images

/*
 * Copy an asset referenced as "/assets/foo.webp" into storage.
 *
 * Deduplicated by content hash: the data files point several products at the
 * same image, and the reference site's 300x300 / 1024x683 variants of one photo
 * are separate files but a given path should only ever be imported once.
 */
const uploadCache = new Map();

const importAsset = async (assetPath) => {
  if (!assetPath) return null;
  if (uploadCache.has(assetPath)) return uploadCache.get(assetPath);

  const source = path.join(ASSETS_DIR, assetPath.replace(/^\//, ''));

  let buffer;
  try {
    buffer = await fs.readFile(source);
  } catch {
    // The data files reference a few assets that were never exported from the
    // reference site. Skipped rather than failing the whole import.
    logger.warn({ assetPath }, 'asset missing — skipping');
    uploadCache.set(assetPath, null);
    return null;
  }

  const checksum = crypto.createHash('sha256').update(buffer).digest('hex');

  const existing = await prisma.upload.findFirst({
    where: { checksum, kind: 'PRODUCT_IMAGE' },
    select: { id: true },
  });
  if (existing) {
    uploadCache.set(assetPath, existing.id);
    return existing.id;
  }

  const detected = fileType.detect(buffer);
  if (!detected) {
    logger.warn({ assetPath }, 'asset is not a recognised image — skipping');
    uploadCache.set(assetPath, null);
    return null;
  }

  const originalName = path.basename(source);
  const saved = await storage.save(buffer, {
    kind: 'PRODUCT_IMAGE',
    originalName,
    mimeType: detected.mime,
  });

  const row = await prisma.upload.create({
    data: {
      kind: 'PRODUCT_IMAGE',
      originalName,
      storedPath: saved.storedPath,
      mimeType: detected.mime,
      sizeBytes: saved.sizeBytes,
      checksum: saved.checksum,
      // Imported images have no alt text on the reference site. Left null so
      // the admin's media screen can flag them as needing one.
      altText: null,
      scanStatus: 'SKIPPED',
    },
  });

  uploadCache.set(assetPath, row.id);
  return row.id;
};

// -------------------------------------------------------------- taxonomies

const importCategories = async () => {
  const { productCategories } = await importData('taxonomies.js');

  // Parents first, so a child's parentId always resolves.
  const sorted = [...productCategories].sort(
    (a, b) => (a.parent ? 1 : 0) - (b.parent ? 1 : 0),
  );

  const idBySlugPath = new Map();

  for (const [index, c] of sorted.entries()) {
    const parentId = c.parent ? idBySlugPath.get(c.parent) ?? null : null;

    const existing = await prisma.category.findUnique({ where: { path: c.path } });

    const row = existing
      ? await prisma.category.update({
          where: { id: existing.id },
          data: { name: c.name, parentId, menuOrder: index },
        })
      : await prisma.category.create({
          data: {
            slug: c.slug,
            name: c.name,
            path: c.path,
            parentId,
            menuOrder: index,
            isVisible: true,
          },
        });

    idBySlugPath.set(c.slug, row.id);
  }

  logger.info({ count: sorted.length }, 'categories imported');
  return idBySlugPath;
};

const importTags = async () => {
  const { productTags } = await importData('taxonomies.js');
  const idBySlug = new Map();

  for (const [index, t] of productTags.entries()) {
    const row = await prisma.tag.upsert({
      where: { slug: t.slug },
      update: { name: t.name, icon: t.icon ?? null, menuOrder: index },
      create: {
        slug: t.slug,
        name: t.name,
        icon: t.icon ?? null,
        menuOrder: index,
        isVisible: true,
      },
    });
    idBySlug.set(t.slug, row.id);
  }

  logger.info({ count: productTags.length }, 'tags imported');
  return idBySlug;
};

// ---------------------------------------------------------------- products

/*
 * The data files use two shapes for preparation steps: plain strings on tests,
 * and {icon, title, text} objects on packages. Both normalise to the same row.
 */
const normaliseStep = (step) =>
  typeof step === 'string'
    ? { title: null, text: step, icon: null }
    : { title: step.title ?? null, text: step.text, icon: step.icon ?? null };

/*
 * Package parameter groups store their items as one comma-separated string
 * ("HDL, LDL, VLDL, …"), which is a display artefact of the old site. Split
 * into rows so the admin can edit them individually.
 */
const splitGroupItems = (items) =>
  String(items ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const importProducts = async (categoryIds, tagIds) => {
  const { products } = await importData('products.js');

  let created = 0;
  let updated = 0;

  for (const [index, p] of products.entries()) {
    const [cardImageId, detailImageId, archiveImageId] = await Promise.all([
      importAsset(p.cardImage),
      importAsset(p.detailImage),
      importAsset(p.archiveImage),
    ]);

    const existing = await prisma.product.findUnique({
      where: { slug: p.slug },
      select: { id: true },
    });

    /*
     * Prices in the data files are rupees; the database stores paise.
     * The website's own display divides by 100 after this import.
     */
    const prices = {
      regularPrice: toPaise(p.regularPrice),
      salePrice: toPaise(p.salePrice),
    };

    const scalars = {
      title: p.title,
      type: p.type === 'package' ? 'PACKAGE' : 'TEST',
      status: 'PUBLISHED',
      ...prices,
      cardExcerpt: p.cardExcerpt ?? null,
      excerpt: p.excerpt ?? null,
      excerptSecondary: p.excerptSecondary ?? null,
      overview: p.overview ?? null,
      profiles: p.profiles ?? null,
      badges: p.badges ?? [],
      ribbon: p.ribbon ?? null,
      menuOrder: index,
      parametersUnavailable: Boolean(p.parametersUnavailable),
      showAllParametersCta: Boolean(p.showAllParametersButton),
      cardImageId,
      detailImageId,
      archiveImageId,
    };

    // No `deleteMany` anywhere below: these are only ever used on create, and
    // Prisma rejects a nested delete on a row that does not exist yet.
    const nested = {
      parameters: {
        create: (p.parameters ?? []).map((name, order) => ({ name, order })),
      },
      parameterGroups: {
        create: (p.parameterGroups ?? []).map((g, order) => ({
          name: g.name,
          order,
          items: {
            create: splitGroupItems(g.items).map((name, i) => ({ name, order: i })),
          },
        })),
      },
      preparation: {
        create: (p.preparation ?? p.preTest ?? []).map((s, order) => ({
          ...normaliseStep(s),
          order,
        })),
      },
      highlights: {
        create: (p.highlights ?? []).map((name, order) => ({ name, order })),
      },
      process: {
        create: (p.process ?? []).map((s, order) => ({
          icon: s.icon ?? null,
          text: s.text,
          order,
        })),
      },
      audience: {
        create: (p.audience ?? []).map((text, order) => ({ text, order })),
      },
      faqs: {
        create: (p.faqs ?? []).map((f, order) => ({
          question: f.q,
          answer: f.a,
          order,
        })),
      },
      categories: {
        create: (p.cats ?? [])
          .map((slug) => categoryIds.get(slug))
          .filter(Boolean)
          .map((categoryId) => ({ categoryId })),
      },
      tags: {
        create: (p.tags ?? [])
          .map((slug) => tagIds.get(slug))
          .filter(Boolean)
          .map((tagId) => ({ tagId })),
      },
    };

    if (existing) {
      /*
       * On re-run only the structural fields are refreshed. Editorial text is
       * left alone: someone may have fixed the reference site's placeholder
       * copy ("Abcd test", "scascascas") in the admin, and a re-import must not
       * put it back.
       */
      await prisma.product.update({
        where: { id: existing.id },
        data: { menuOrder: index, cardImageId, detailImageId, archiveImageId },
      });
      updated += 1;
    } else {
      await prisma.product.create({
        data: { slug: p.slug, publishedAt: new Date(), ...scalars, ...nested },
      });
      created += 1;
    }
  }

  logger.info({ created, updated, total: products.length }, 'products imported');
};

const importCatalog = async () => {
  await storage.ensureDirs();
  const categoryIds = await importCategories();
  const tagIds = await importTags();
  await importProducts(categoryIds, tagIds);
};

module.exports = { importCatalog };
