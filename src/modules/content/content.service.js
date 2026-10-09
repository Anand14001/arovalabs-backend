/*
 * Content: blog posts, pages and their sections, and the shared blocks
 * (testimonials, FAQs, navigation).
 *
 * Two rules run through all of it:
 *
 *   1. **Sanitise on save.** Rich text is cleaned before it is stored, so the
 *      stored value is already safe and nothing downstream has to remember.
 *   2. **Snapshot before change.** Every edit records the previous version
 *      first, so "restore the one from before lunch" is always available.
 */

const prisma = require('../../lib/prisma');
const ApiError = require('../../lib/ApiError');
const storage = require('../../lib/storage');
const { slugify, uniqueSlug } = require('../../lib/slug');
const { toSkipTake, paginated } = require('../../lib/pagination');
const { writeAudit } = require('../../lib/audit');
const revisions = require('../../lib/revisions');
const sanitize = require('../../lib/sanitize');
const { schemaFor } = require('./sections.registry');

// ------------------------------------------------------------------- blog

const POST_INCLUDE = {
  featuredImage: true,
  ogImage: true,
  category: true,
  author: { select: { name: true } },
  tags: { include: { tag: true } },
};

const imageOf = (upload, fallback) =>
  upload ? storage.publicUrl(upload) : (fallback ?? null);

const toPost = (p, { full = false } = {}) => ({
  id: p.id,
  slug: p.slug,
  title: p.title,
  excerpt: p.excerpt ?? null,
  image: imageOf(p.featuredImage),
  category: p.category ? { slug: p.category.slug, name: p.category.name } : null,
  author: p.authorName ?? p.author?.name ?? null,
  readingMinutes: p.readingMinutes,
  publishedAt: p.publishedAt,
  tags: (p.tags ?? []).map((t) => t.tag.name),
  ...(full
    ? {
      content: p.content ?? '',
      seo: {
        metaTitle: p.metaTitle ?? p.title,
        metaDescription: p.metaDescription ?? p.excerpt ?? null,
        ogImage: imageOf(p.ogImage) ?? imageOf(p.featuredImage),
      },
    }
    : {}),
});

const toAdminPost = (p) => ({
  ...toPost(p, { full: true }),
  status: p.status,
  categoryId: p.categoryId,
  featuredUploadId: p.featuredUploadId,
  ogUploadId: p.ogUploadId,
  isFeatured: p.isFeatured,
  viewCount: p.viewCount,
  metaTitle: p.metaTitle,
  metaDescription: p.metaDescription,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

const listPosts = async ({ page, limit, category, tag, q, status }) => {
  const where = {
    ...(status ? { status } : {}),
    ...(category ? { category: { slug: category } } : {}),
    ...(tag ? { tags: { some: { tag: { slug: tag } } } } : {}),
    ...(q
      ? {
        OR: [
          { title: { contains: q, mode: 'insensitive' } },
          { excerpt: { contains: q, mode: 'insensitive' } },
        ],
      }
      : {}),
  };

  const [items, total] = await prisma.$transaction([
    prisma.blogPost.findMany({
      where,
      include: POST_INCLUDE,
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      ...toSkipTake({ page, limit }),
    }),
    prisma.blogPost.count({ where }),
  ]);

  return { items, total };
};

const getPostBySlug = async (slug) => {
  const post = await prisma.blogPost.findFirst({
    where: { slug, status: 'PUBLISHED' },
    include: POST_INCLUDE,
  });
  if (!post) throw ApiError.notFound('That article does not exist.');

  // Fire-and-forget: a view counter must never slow down or fail a page load.
  prisma.blogPost
    .update({ where: { id: post.id }, data: { viewCount: { increment: 1 } } })
    .catch(() => { });

  const [prev, next] = await Promise.all([
    prisma.blogPost.findFirst({
      where: { status: 'PUBLISHED', publishedAt: { lt: post.publishedAt } },
      orderBy: { publishedAt: 'desc' },
      include: POST_INCLUDE,
    }),
    prisma.blogPost.findFirst({
      where: { status: 'PUBLISHED', publishedAt: { gt: post.publishedAt } },
      orderBy: { publishedAt: 'asc' },
      include: POST_INCLUDE,
    }),
  ]);

  return {
    post: toPost(post, { full: true }),
    prev: prev ? toPost(prev) : null,
    next: next ? toPost(next) : null,
  };
};

/*
 * Changing a published slug leaves a redirect behind.
 *
 * Renaming an article is a normal editorial act; silently 404ing every link to
 * it is not. This is the kind of thing a CMS has to do for you, because nobody
 * remembers to do it by hand.
 */
const recordRedirect = async (fromPath, toPath) => {
  if (!fromPath || fromPath === toPath) return;
  await prisma.redirect.upsert({
    where: { fromPath },
    update: { toPath, isActive: true },
    create: { fromPath, toPath, statusCode: 301 },
  });
};

const postWrites = (data) => {
  const out = {};
  const copy = [
    'title', 'excerpt', 'status', 'categoryId', 'featuredUploadId', 'ogUploadId',
    'authorName', 'isFeatured', 'metaTitle', 'metaDescription',
  ];
  for (const f of copy) if (data[f] !== undefined) out[f] = data[f];

  if (data.content !== undefined) {
    out.content = sanitize.sanitizeRichText(data.content);
    // Derived, not asked for: an editor should not have to estimate this.
    out.readingMinutes = sanitize.readingMinutes(out.content);
    if (!data.excerpt && out.content) {
      out.excerpt = sanitize.toPlainText(out.content).slice(0, 280);
    }
  }

  if (data.title !== undefined) out.title = sanitize.stripTags(data.title);
  if (data.excerpt !== undefined) out.excerpt = sanitize.stripTags(data.excerpt);

  return out;
};

const createPost = async (data, req) => {
  const slug = await uniqueSlug(data.slug || data.title, async (candidate) => {
    const found = await prisma.blogPost.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    return Boolean(found);
  });

  const post = await prisma.blogPost.create({
    data: {
      ...postWrites(data),
      slug,
      authorId: req.user.id,
      publishedAt: data.status === 'PUBLISHED' ? new Date() : null,
      ...(data.tagIds ? { tags: { create: data.tagIds.map((tagId) => ({ tagId })) } } : {}),
    },
    include: POST_INCLUDE,
  });

  await writeAudit({
    req, action: 'post.created', entityType: 'BlogPost', entityId: post.id,
    after: { slug: post.slug, title: post.title },
  });

  return toAdminPost(post);
};

const updatePost = async (id, data, req) => {
  const existing = await prisma.blogPost.findUnique({
    where: { id },
    include: POST_INCLUDE,
  });
  if (!existing) throw ApiError.notFound('Article not found.');

  await revisions.snapshot({
    entityType: 'BlogPost',
    entityId: id,
    data: toAdminPost(existing),
    actorId: req.user.id,
  });

  let slug;
  if (data.slug && slugify(data.slug) !== existing.slug) {
    slug = await uniqueSlug(data.slug, async (candidate) => {
      const found = await prisma.blogPost.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });
      return Boolean(found) && found.id !== id;
    });

    if (existing.status === 'PUBLISHED') {
      await recordRedirect(`/${existing.slug}/`, `/${slug}/`);
    }
  }

  const becomingPublished = data.status === 'PUBLISHED' && existing.status !== 'PUBLISHED';

  const post = await prisma.blogPost.update({
    where: { id },
    data: {
      ...postWrites(data),
      ...(slug ? { slug } : {}),
      ...(becomingPublished && !existing.publishedAt ? { publishedAt: new Date() } : {}),
      ...(data.tagIds
        ? { tags: { deleteMany: {}, create: data.tagIds.map((tagId) => ({ tagId })) } }
        : {}),
    },
    include: POST_INCLUDE,
  });

  await writeAudit({
    req, action: 'post.updated', entityType: 'BlogPost', entityId: id,
    before: { slug: existing.slug, status: existing.status },
    after: { slug: post.slug, status: post.status },
  });

  return toAdminPost(post);
};

const restorePost = async (id, revisionId, req) => {
  const snap = await revisions.get(revisionId);
  if (!snap) throw ApiError.notFound('That version no longer exists.');

  const current = await prisma.blogPost.findUnique({ where: { id }, include: POST_INCLUDE });
  if (!current) throw ApiError.notFound('Article not found.');

  // The restore is itself a change, so the current version is snapshotted too —
  // restoring the wrong version must also be undoable.
  await revisions.snapshot({
    entityType: 'BlogPost',
    entityId: id,
    data: toAdminPost(current),
    note: 'Before restore',
    actorId: req.user.id,
  });

  const post = await prisma.blogPost.update({
    where: { id },
    data: {
      title: snap.title,
      excerpt: snap.excerpt,
      content: sanitize.sanitizeRichText(snap.content),
      readingMinutes: snap.readingMinutes,
      metaTitle: snap.metaTitle,
      metaDescription: snap.metaDescription,
      categoryId: snap.categoryId ?? null,
      featuredUploadId: snap.featuredUploadId ?? null,
    },
    include: POST_INCLUDE,
  });

  await writeAudit({
    req, action: 'post.restored', entityType: 'BlogPost', entityId: id,
    after: { revisionId },
  });

  return toAdminPost(post);
};

const deletePost = async (id, req) => {
  const existing = await prisma.blogPost.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Article not found.');

  // A deleted published article still has links pointing at it from elsewhere.
  if (existing.status === 'PUBLISHED') {
    await recordRedirect(`/${existing.slug}/`, '/');
  }

  await prisma.blogPost.delete({ where: { id } });

  await writeAudit({
    req, action: 'post.deleted', entityType: 'BlogPost', entityId: id,
    before: { slug: existing.slug, title: existing.title },
  });
};

// ------------------------------------------------------------------ pages

const PAGE_INCLUDE = { sections: { orderBy: { order: 'asc' } } };

const toPage = (page, { includeHidden = false } = {}) => ({
  id: page.id,
  slug: page.slug,
  title: page.title,
  status: page.status,
  layout: page.layout,
  bodyHtml: page.bodyHtml ?? null,
  isSystem: page.isSystem,
  seo: {
    metaTitle: page.metaTitle ?? page.title,
    metaDescription: page.metaDescription ?? null,
  },
  sections: (page.sections ?? [])
    .filter((s) => includeHidden || s.isVisible)
    .map((s) => ({
      id: s.id,
      type: s.type,
      label: s.label,
      order: s.order,
      isVisible: s.isVisible,
      data: s.data,
    })),
});

const getPageBySlug = async (slug) => {
  const page = await prisma.page.findUnique({ where: { slug }, include: PAGE_INCLUDE });
  if (!page || page.status !== 'PUBLISHED') throw ApiError.notFound('That page does not exist.');
  return toPage(page);
};

/*
 * Validate a section's data against its declared shape.
 *
 * Unknown types are refused rather than stored: a section the website has no
 * component for would render as nothing, which looks like data loss.
 */
const validateSectionData = (type, data) => {
  const schema = schemaFor(type);
  if (!schema) {
    throw ApiError.unprocessable('Validation failed.', {
      type: `"${type}" is not a section type this site can render.`,
    });
  }

  const parsed = schema.safeParse(data ?? {});
  if (!parsed.success) {
    const fields = {};
    for (const issue of parsed.error.issues) {
      fields[issue.path.join('.') || 'data'] = issue.message;
    }
    throw ApiError.unprocessable('Validation failed.', fields);
  }

  // Rich text inside a section is sanitised like any other rich text.
  if (parsed.data.body && type === 'RICH_TEXT') {
    parsed.data.body = sanitize.sanitizeRichText(parsed.data.body);
  }

  return parsed.data;
};

const createSection = async (pageId, { type, label, data }, req) => {
  const page = await prisma.page.findUnique({ where: { id: pageId } });
  if (!page) throw ApiError.notFound('Page not found.');

  const clean = validateSectionData(type, data);

  const last = await prisma.pageSection.findFirst({
    where: { pageId },
    orderBy: { order: 'desc' },
    select: { order: true },
  });

  const section = await prisma.pageSection.create({
    data: {
      pageId,
      type,
      label: label ?? null,
      data: clean,
      order: (last?.order ?? -1) + 1,
    },
  });

  await writeAudit({
    req, action: 'section.created', entityType: 'PageSection', entityId: section.id,
    after: { pageId, type },
  });

  return section;
};

const updateSection = async (id, { label, data, isVisible }, req) => {
  const existing = await prisma.pageSection.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Section not found.');

  await revisions.snapshot({
    entityType: 'PageSection',
    entityId: id,
    data: { type: existing.type, label: existing.label, data: existing.data },
    actorId: req.user.id,
  });

  const section = await prisma.pageSection.update({
    where: { id },
    data: {
      ...(label !== undefined ? { label } : {}),
      ...(isVisible !== undefined ? { isVisible } : {}),
      ...(data !== undefined ? { data: validateSectionData(existing.type, data) } : {}),
    },
  });

  await writeAudit({
    req, action: 'section.updated', entityType: 'PageSection', entityId: id,
    after: { type: section.type, isVisible: section.isVisible },
  });

  return section;
};

const reorderSections = async (pageId, ids, req) => {
  await prisma.$transaction(
    ids.map((id, order) =>
      prisma.pageSection.update({ where: { id }, data: { order } }),
    ),
  );
  await writeAudit({
    req, action: 'section.reordered', entityType: 'Page', entityId: pageId, after: { ids },
  });
};

const deleteSection = async (id, req) => {
  const existing = await prisma.pageSection.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Section not found.');

  // Snapshotted so a deleted section can be recovered from the revision list.
  await revisions.snapshot({
    entityType: 'PageSection',
    entityId: id,
    data: { type: existing.type, label: existing.label, data: existing.data },
    note: 'Before delete',
    actorId: req.user.id,
  });

  await prisma.pageSection.delete({ where: { id } });

  await writeAudit({
    req, action: 'section.deleted', entityType: 'PageSection', entityId: id,
    before: { type: existing.type },
  });
};

const updatePage = async (id, data, req) => {
  const existing = await prisma.page.findUnique({ where: { id }, include: PAGE_INCLUDE });
  if (!existing) throw ApiError.notFound('Page not found.');

  await revisions.snapshot({
    entityType: 'Page',
    entityId: id,
    data: toPage(existing, { includeHidden: true }),
    actorId: req.user.id,
  });

  let slug;
  if (data.slug && slugify(data.slug) !== existing.slug) {
    if (existing.isSystem) {
      // The navigation and the router both point at these.
      throw ApiError.conflict('This is a built-in page — its address cannot change.');
    }
    slug = slugify(data.slug);
    if (existing.status === 'PUBLISHED') {
      await recordRedirect(`/${existing.slug}/`, `/${slug}/`);
    }
  }

  const page = await prisma.page.update({
    where: { id },
    data: {
      ...(slug ? { slug } : {}),
      ...(data.title !== undefined ? { title: sanitize.stripTags(data.title) } : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.bodyHtml !== undefined
        ? { bodyHtml: sanitize.sanitizeRichText(data.bodyHtml) }
        : {}),
      ...(data.metaTitle !== undefined ? { metaTitle: data.metaTitle } : {}),
      ...(data.metaDescription !== undefined
        ? { metaDescription: data.metaDescription }
        : {}),
    },
    include: PAGE_INCLUDE,
  });

  await writeAudit({
    req, action: 'page.updated', entityType: 'Page', entityId: id,
    before: { slug: existing.slug }, after: { slug: page.slug },
  });

  return toPage(page, { includeHidden: true });
};

module.exports = {
  // blog
  listPosts, getPostBySlug, createPost, updatePost, restorePost, deletePost,
  toPost, toAdminPost, POST_INCLUDE,
  // pages
  getPageBySlug, toPage, PAGE_INCLUDE, updatePage,
  createSection, updateSection, reorderSections, deleteSection, validateSectionData,
  recordRedirect,
};
