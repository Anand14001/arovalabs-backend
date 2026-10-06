/*
 * Product shapes sent to clients.
 *
 * Deliberately explicit rather than spreading the Prisma row: it keeps internal
 * columns out of responses, and makes the website's contract visible in one
 * place instead of being implied by whatever the database happens to contain.
 *
 * Prices go out in paise *and* rupees. Paise is the truth; rupees is there so
 * the website never has to divide and risk a rounding bug of its own.
 */

const { toRupees, discountLabel, discountPercent } = require('../../lib/money');
const storage = require('../../lib/storage');

const image = (upload) =>
  upload
    ? {
        id: upload.id,
        url: storage.publicUrl(upload),
        alt: upload.altText ?? null,
        width: upload.width ?? null,
        height: upload.height ?? null,
      }
    : null;

const price = (p) => ({
  regular: p.regularPrice,
  sale: p.salePrice,
  regularRupees: toRupees(p.regularPrice),
  saleRupees: toRupees(p.salePrice),
  // Derived rather than stored: a stored label drifts the moment a price is
  // edited and nobody remembers to update it.
  discountPercent: discountPercent(p.regularPrice, p.salePrice),
  discountLabel: discountLabel(p.regularPrice, p.salePrice),
  onSale: p.salePrice < p.regularPrice,
});

const categoryRef = (c) => ({ id: c.id, slug: c.slug, name: c.name, path: c.path });

const tagRef = (t) => ({ id: t.id, slug: t.slug, name: t.name, icon: t.icon });

/*
 * Breadcrumbs are computed from the deepest category rather than stored.
 *
 * The old site kept a hand-written breadcrumb array per product, which is one
 * more thing to forget to update when a product is recategorised.
 */
const breadcrumb = (categories = []) => {
  if (!categories.length) return [];
  const deepest = categories.reduce((a, b) =>
    (b.path?.split('/').length ?? 0) > (a.path?.split('/').length ?? 0) ? b : a,
  );
  const parts = deepest.path.split('/');
  return parts.map((_, i) => {
    const path = parts.slice(0, i + 1).join('/');
    const match = categories.find((c) => c.path === path);
    return {
      label: match?.name ?? parts[i],
      path,
      to: `/product-category/${path}/`,
    };
  });
};

/** The compact shape used by cards, rows, carousels and search. */
const toCard = (p) => ({
  id: p.id,
  slug: p.slug,
  title: p.title,
  type: p.type,
  excerpt: p.cardExcerpt ?? null,
  badges: Array.isArray(p.badges) ? p.badges : [],
  ribbon: p.ribbon ?? null,
  image: image(p.cardImage),
  archiveImage: image(p.archiveImage),
  // The package card's summary line and bullet list.
  profiles: p.profiles ?? null,
  highlights: (p.highlights ?? []).map((h) => h.name),
  price: price(p),
  categories: (p.categories ?? []).map((pc) => categoryRef(pc.category)),
  tags: (p.tags ?? []).map((pt) => tagRef(pt.tag)),
});

/** Everything a product detail page renders. */
const toDetail = (p) => {
  const categories = (p.categories ?? []).map((pc) => pc.category);

  return {
    ...toCard(p),
    excerpt: p.excerpt ?? null,
    excerptSecondary: p.excerptSecondary ?? null,
    cardExcerpt: p.cardExcerpt ?? null,
    overview: p.overview ?? null,
    image: image(p.detailImage) ?? image(p.cardImage),
    cardImage: image(p.cardImage),
    detailImage: image(p.detailImage),
    breadcrumb: breadcrumb(categories),

    parameters: (p.parameters ?? []).map((x) => x.name),
    // The reference site leaks a PHP warning here on one product instead of a
    // parameter list. Modelled so the site can say so deliberately.
    parametersUnavailable: p.parametersUnavailable,
    parameterGroups: (p.parameterGroups ?? []).map((g) => ({
      name: g.name,
      summary: g.summary ?? null,
      items: (g.items ?? []).map((i) => i.name),
    })),
    showAllParametersCta: p.showAllParametersCta,

    preparation: (p.preparation ?? []).map((s) => ({
      title: s.title ?? null,
      text: s.text,
      icon: s.icon ?? null,
    })),
    process: (p.process ?? []).map((s) => ({ icon: s.icon ?? null, text: s.text })),
    audience: (p.audience ?? []).map((a) => a.text),
    faqs: (p.faqs ?? []).map((f) => ({ q: f.question, a: f.answer })),

    logistics: {
      sampleType: p.sampleType ?? null,
      fastingRequired: p.fastingRequired,
      fastingNote: p.fastingNote ?? null,
      turnaroundHours: p.turnaroundHours ?? null,
      reportFormat: p.reportFormat ?? null,
    },

    seo: {
      metaTitle: p.metaTitle ?? p.title,
      metaDescription: p.metaDescription ?? p.cardExcerpt ?? null,
    },
  };
};

/** The admin needs the editorial fields the public shape hides. */
const toAdmin = (p) => ({
  ...toDetail(p),
  status: p.status,
  sku: p.sku ?? null,
  menuOrder: p.menuOrder,
  isFeatured: p.isFeatured,
  categoryIds: (p.categories ?? []).map((pc) => pc.categoryId),
  tagIds: (p.tags ?? []).map((pt) => pt.tagId),
  cardImageId: p.cardImageId ?? null,
  detailImageId: p.detailImageId ?? null,
  archiveImageId: p.archiveImageId ?? null,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
  publishedAt: p.publishedAt ?? null,
});

/** The row shape for the admin products table — no nested content needed. */
const toAdminRow = (p) => ({
  id: p.id,
  slug: p.slug,
  title: p.title,
  type: p.type,
  status: p.status,
  menuOrder: p.menuOrder,
  isFeatured: p.isFeatured,
  price: price(p),
  image: image(p.archiveImage) ?? image(p.cardImage),
  categories: (p.categories ?? []).map((pc) => categoryRef(pc.category)),
  updatedAt: p.updatedAt,
});

module.exports = { toCard, toDetail, toAdmin, toAdminRow, image, price, breadcrumb };
