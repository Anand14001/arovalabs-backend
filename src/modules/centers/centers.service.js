const prisma = require('../../lib/prisma');
const ApiError = require('../../lib/ApiError');
const { uniqueSlug, slugify } = require('../../lib/slug');

const listCenters = async ({ isActive, city, q } = {}) => {
  const where = {};

  if (isActive === 'true') where.isActive = true;
  else if (isActive === 'false') where.isActive = false;

  if (city) where.city = { contains: city, mode: 'insensitive' };

  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { address: { contains: q, mode: 'insensitive' } },
      { city: { contains: q, mode: 'insensitive' } },
      { phone: { contains: q, mode: 'insensitive' } },
    ];
  }

  const items = await prisma.center.findMany({
    where,
    orderBy: [{ menuOrder: 'asc' }, { name: 'asc' }],
    include: {
      _count: {
        select: { orders: true },
      },
    },
  });

  return { items };
};

const getCenter = async (id) => {
  const center = await prisma.center.findUnique({
    where: { id },
    include: {
      _count: { select: { orders: true } },
    },
  });

  if (!center) throw ApiError.notFound('Diagnostic centre not found.');
  return center;
};

const createCenter = async (data) => {
  const slug = await uniqueSlug(data.slug || data.name, async (candidate) => {
    const found = await prisma.center.findUnique({ where: { slug: candidate } });
    return Boolean(found);
  });

  const center = await prisma.center.create({
    data: {
      slug,
      name: data.name,
      address: data.address,
      city: data.city,
      state: data.state || 'Tamil Nadu',
      pincode: data.pincode || null,
      phone: data.phone || null,
      email: data.email || null,
      mapUrl: data.mapUrl || null,
      openingHours: data.openingHours || null,
      isHomeCollectionHub: Boolean(data.isHomeCollectionHub),
      isActive: data.isActive !== undefined ? Boolean(data.isActive) : true,
      menuOrder: data.menuOrder || 0,
    },
  });

  return center;
};

const updateCenter = async (id, data) => {
  const existing = await prisma.center.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Diagnostic centre not found.');

  let slug = existing.slug;
  if (data.slug && data.slug !== existing.slug) {
    const slugExists = await prisma.center.findUnique({ where: { slug: data.slug } });
    if (slugExists) throw ApiError.conflict(`Slug "${data.slug}" is already in use.`);
    slug = slugify(data.slug);
  }

  const updated = await prisma.center.update({
    where: { id },
    data: {
      ...data,
      slug,
      mapUrl: data.mapUrl === '' ? null : data.mapUrl,
    },
  });

  return updated;
};

const deleteCenter = async (id) => {
  const existing = await prisma.center.findUnique({
    where: { id },
    include: { _count: { select: { orders: true } } },
  });

  if (!existing) throw ApiError.notFound('Diagnostic centre not found.');

  // If orders were placed for this center, soft-deactivate instead of breaking orders
  if (existing._count.orders > 0) {
    await prisma.center.update({
      where: { id },
      data: { isActive: false },
    });
    return {
      id,
      message: 'Centre has linked bookings; it was deactivated instead of deleted.',
    };
  }

  await prisma.center.delete({ where: { id } });
  return { id, message: 'Centre deleted successfully.' };
};

module.exports = {
  listCenters,
  getCenter,
  createCenter,
  updateCenter,
  deleteCenter,
};
