/*
 * Categories.
 *
 * The tree is stored as parent pointers plus a materialised `path`
 * ("tests/diabetes-tests"). The path is what makes the website's nested archive
 * URLs resolve in a single indexed lookup instead of walking parents.
 *
 * The cost is that the path must be maintained: renaming or reparenting a
 * category has to rewrite every descendant's path. `recomputePaths` does that,
 * and every mutation goes through it rather than setting `path` by hand.
 */

const prisma = require('../../lib/prisma');
const ApiError = require('../../lib/ApiError');
const { slugify } = require('../../lib/slug');
const { writeAudit } = require('../../lib/audit');
const storage = require('../../lib/storage');

const serialize = (c, counts = {}) => ({
  id: c.id,
  slug: c.slug,
  name: c.name,
  path: c.path,
  parentId: c.parentId,
  description: c.description ?? null,
  image: c.image
    ? { id: c.image.id, url: storage.publicUrl(c.image), alt: c.image.altText ?? null }
    : null,
  menuOrder: c.menuOrder,
  isVisible: c.isVisible,
  productCount: counts[c.id] ?? c._count?.products ?? 0,
  seo: {
    metaTitle: c.metaTitle ?? c.name,
    metaDescription: c.metaDescription ?? null,
  },
});

/** Flat rows → nested tree, in one pass. */
const buildTree = (rows) => {
  const byId = new Map();
  const roots = [];

  for (const row of rows) byId.set(row.id, { ...row, children: [] });

  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) {
      byId.get(node.parentId).children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sort = (nodes) => {
    nodes.sort((a, b) => a.menuOrder - b.menuOrder || a.name.localeCompare(b.name));
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);

  return roots;
};

const listTree = async ({ includeHidden = false } = {}) => {
  const rows = await prisma.category.findMany({
    where: includeHidden ? {} : { isVisible: true },
    include: { image: true, _count: { select: { products: true } } },
    orderBy: [{ menuOrder: 'asc' }, { name: 'asc' }],
  });

  const serialized = rows.map((r) => ({ ...serialize(r), parentId: r.parentId }));
  return buildTree(serialized);
};

const getByPath = async (path) => {
  const category = await prisma.category.findUnique({
    where: { path },
    include: { image: true, _count: { select: { products: true } } },
  });
  if (!category) throw ApiError.notFound('That category does not exist.');
  return serialize(category);
};

/*
 * Rebuild `path` for a subtree.
 *
 * Called after any change that can move a node: create, rename, reparent. Walks
 * down from the given root, so a deep rename fixes every descendant rather than
 * leaving them pointing at a path that no longer exists.
 */
const recomputePaths = async (tx, rootId) => {
  const all = await tx.category.findMany({
    select: { id: true, slug: true, parentId: true, path: true },
  });

  const byId = new Map(all.map((c) => [c.id, c]));

  const pathOf = (id, seen = new Set()) => {
    // A cycle would otherwise recurse until the stack gives out.
    if (seen.has(id)) throw ApiError.badRequest('That would create a loop in the category tree.');
    seen.add(id);
    const node = byId.get(id);
    if (!node) return '';
    return node.parentId ? `${pathOf(node.parentId, seen)}/${node.slug}` : node.slug;
  };

  const descendants = (id) => {
    const out = [id];
    for (const c of all) if (c.parentId === id) out.push(...descendants(c.id));
    return out;
  };

  const affected = rootId ? descendants(rootId) : all.map((c) => c.id);

  const updates = [];
  for (const id of affected) {
    const next = pathOf(id);
    if (byId.get(id)?.path !== next) {
      updates.push(tx.category.update({ where: { id }, data: { path: next } }));
    }
  }

  await Promise.all(updates);
};

const assertNotDescendant = async (id, parentId) => {
  if (!parentId) return;
  if (id === parentId) {
    throw ApiError.badRequest('A category cannot be its own parent.');
  }
  const all = await prisma.category.findMany({ select: { id: true, parentId: true } });
  let cursor = parentId;
  const seen = new Set();
  while (cursor) {
    if (cursor === id) {
      throw ApiError.badRequest('A category cannot be moved inside one of its own children.');
    }
    if (seen.has(cursor)) break;
    seen.add(cursor);
    cursor = all.find((c) => c.id === cursor)?.parentId ?? null;
  }
};

const create = async (data, req) => {
  await assertNotDescendant(-1, data.parentId);

  const slug = slugify(data.slug || data.name);

  // Uniqueness is per parent, not global: "heart-health" exists under both
  // tests and packages on the reference site, and both must keep working.
  const clash = await prisma.category.findFirst({
    where: { parentId: data.parentId ?? null, slug },
    select: { id: true },
  });
  if (clash) {
    throw ApiError.conflict('A category with that slug already exists here.', {
      slug: 'Already used under this parent.',
    });
  }

  const category = await prisma.$transaction(async (tx) => {
    const created = await tx.category.create({
      data: {
        slug,
        name: data.name,
        parentId: data.parentId ?? null,
        description: data.description ?? null,
        imageId: data.imageId ?? null,
        menuOrder: data.menuOrder ?? 0,
        isVisible: data.isVisible ?? true,
        metaTitle: data.metaTitle ?? null,
        metaDescription: data.metaDescription ?? null,
        // Placeholder; recomputePaths sets the real value below. The column is
        // unique and non-null, so it cannot simply be left empty.
        path: `${slug}-${Date.now()}`,
      },
    });
    await recomputePaths(tx, created.id);
    return tx.category.findUnique({
      where: { id: created.id },
      include: { image: true, _count: { select: { products: true } } },
    });
  });

  await writeAudit({
    req,
    action: 'category.created',
    entityType: 'Category',
    entityId: category.id,
    after: { name: category.name, path: category.path },
  });

  return serialize(category);
};

const update = async (id, data, req) => {
  const existing = await prisma.category.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Category not found.');

  if (data.parentId !== undefined) await assertNotDescendant(id, data.parentId);

  const slug = data.slug || data.name ? slugify(data.slug || data.name) : existing.slug;
  const parentId = data.parentId !== undefined ? data.parentId : existing.parentId;

  if (slug !== existing.slug || parentId !== existing.parentId) {
    const clash = await prisma.category.findFirst({
      where: { parentId: parentId ?? null, slug, id: { not: id } },
      select: { id: true },
    });
    if (clash) {
      throw ApiError.conflict('A category with that slug already exists here.', {
        slug: 'Already used under this parent.',
      });
    }
  }

  const category = await prisma.$transaction(async (tx) => {
    await tx.category.update({
      where: { id },
      data: {
        slug,
        parentId,
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.imageId !== undefined ? { imageId: data.imageId } : {}),
        ...(data.menuOrder !== undefined ? { menuOrder: data.menuOrder } : {}),
        ...(data.isVisible !== undefined ? { isVisible: data.isVisible } : {}),
        ...(data.metaTitle !== undefined ? { metaTitle: data.metaTitle } : {}),
        ...(data.metaDescription !== undefined
          ? { metaDescription: data.metaDescription }
          : {}),
      },
    });
    // Rewrites this node and everything under it.
    await recomputePaths(tx, id);
    return tx.category.findUnique({
      where: { id },
      include: { image: true, _count: { select: { products: true } } },
    });
  });

  await writeAudit({
    req,
    action: 'category.updated',
    entityType: 'Category',
    entityId: id,
    before: { name: existing.name, path: existing.path, parentId: existing.parentId },
    after: { name: category.name, path: category.path, parentId: category.parentId },
  });

  return serialize(category);
};

const remove = async (id, req) => {
  const existing = await prisma.category.findUnique({
    where: { id },
    include: { _count: { select: { products: true, children: true } } },
  });
  if (!existing) throw ApiError.notFound('Category not found.');

  // Deleting would orphan products or silently promote children to the root.
  // Both are surprising, so refuse and say what to do.
  if (existing._count.children > 0) {
    throw ApiError.conflict(
      'This category has sub-categories. Move or delete those first.',
    );
  }
  if (existing._count.products > 0) {
    throw ApiError.conflict(
      `${existing._count.products} product(s) are in this category. Move them first, or hide the category instead.`,
    );
  }

  await prisma.category.delete({ where: { id } });

  await writeAudit({
    req,
    action: 'category.deleted',
    entityType: 'Category',
    entityId: id,
    before: { name: existing.name, path: existing.path },
  });
};

/** Drag-reorder sends siblings in their new order, optionally with a new parent. */
const reorder = async (items, req) => {
  await prisma.$transaction(async (tx) => {
    for (const [index, item] of items.entries()) {
      await tx.category.update({
        where: { id: item.id },
        data: {
          menuOrder: index,
          ...(item.parentId !== undefined ? { parentId: item.parentId } : {}),
        },
      });
    }
    await recomputePaths(tx, null);
  });

  await writeAudit({
    req,
    action: 'category.reordered',
    entityType: 'Category',
    after: { items },
  });
};

module.exports = { listTree, getByPath, create, update, remove, reorder, serialize };
