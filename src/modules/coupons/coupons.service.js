const prisma = require('../../lib/prisma');
const ApiError = require('../../lib/ApiError');
const { toPaise, toRupees } = require('../../lib/money');

/**
 * Calculates current validity status for display.
 */
const resolveStatus = (c) => {
  if (!c.isActive) return 'INACTIVE';
  const now = new Date();
  if (c.startsAt && new Date(c.startsAt) > now) return 'UPCOMING';
  if (c.endsAt && new Date(c.endsAt) < now) return 'EXPIRED';
  if (c.usageLimit !== null && c.usageCount >= c.usageLimit) return 'DEPLETED';
  return 'ACTIVE';
};

const serializeCoupon = (c) => ({
  id: c.id,
  code: c.code,
  description: c.description,
  type: c.type,
  value: c.type === 'FIXED' ? toRupees(c.value) : c.value,
  valueRaw: c.value,
  scope: c.scope,
  minOrderValue: c.minOrderValue ? toRupees(c.minOrderValue) : null,
  maxDiscount: c.maxDiscount ? toRupees(c.maxDiscount) : null,
  usageLimit: c.usageLimit,
  usageCount: c.usageCount,
  startsAt: c.startsAt,
  endsAt: c.endsAt,
  isActive: c.isActive,
  computedStatus: resolveStatus(c),
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
  products: c.products?.map((p) => ({ id: p.product.id, title: p.product.title })) || [],
  categories: c.categories?.map((cat) => ({ id: cat.category.id, name: cat.category.name })) || [],
});

const listCoupons = async ({ page = 1, limit = 20, status, q }) => {
  const where = {};

  if (q) {
    where.OR = [
      { code: { contains: q, mode: 'insensitive' } },
      { description: { contains: q, mode: 'insensitive' } },
    ];
  }

  const now = new Date();
  if (status === 'INACTIVE') {
    where.isActive = false;
  } else if (status === 'ACTIVE') {
    where.isActive = true;
    where.OR = [{ startsAt: null }, { startsAt: { lte: now } }];
    where.AND = [
      { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
      { OR: [{ usageLimit: null }, { usageCount: { lt: prisma.coupon.fields.usageLimit } }] },
    ];
  } else if (status === 'EXPIRED') {
    where.endsAt = { lt: now };
  } else if (status === 'UPCOMING') {
    where.startsAt = { gt: now };
  }

  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    prisma.coupon.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: {
        products: { include: { product: { select: { id: true, title: true } } } },
        categories: { include: { category: { select: { id: true, name: true } } } },
      },
    }),
    prisma.coupon.count({ where }),
  ]);

  return {
    items: items.map(serializeCoupon),
    pagination: {
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    },
  };
};

const getCoupon = async (id) => {
  const coupon = await prisma.coupon.findUnique({
    where: { id },
    include: {
      products: { include: { product: { select: { id: true, title: true } } } },
      categories: { include: { category: { select: { id: true, name: true } } } },
    },
  });

  if (!coupon) throw ApiError.notFound('Coupon not found.');
  return serializeCoupon(coupon);
};

const createCoupon = async (data) => {
  const existing = await prisma.coupon.findUnique({ where: { code: data.code } });
  if (existing) {
    throw ApiError.conflict(`A coupon with code "${data.code}" already exists.`);
  }

  const storedValue = data.type === 'FIXED' ? toPaise(data.value) : Math.round(data.value);
  const storedMinOrder = data.minOrderValue ? toPaise(data.minOrderValue) : null;
  const storedMaxDiscount = data.maxDiscount ? toPaise(data.maxDiscount) : null;

  const coupon = await prisma.coupon.create({
    data: {
      code: data.code,
      description: data.description || null,
      type: data.type,
      value: storedValue,
      scope: data.scope || 'ALL',
      minOrderValue: storedMinOrder,
      maxDiscount: storedMaxDiscount,
      usageLimit: data.usageLimit || null,
      startsAt: data.startsAt || null,
      endsAt: data.endsAt || null,
      isActive: data.isActive !== undefined ? data.isActive : true,
      products: data.productIds?.length
        ? { create: data.productIds.map((productId) => ({ productId })) }
        : undefined,
      categories: data.categoryIds?.length
        ? { create: data.categoryIds.map((categoryId) => ({ categoryId })) }
        : undefined,
    },
    include: {
      products: { include: { product: { select: { id: true, title: true } } } },
      categories: { include: { category: { select: { id: true, name: true } } } },
    },
  });

  return serializeCoupon(coupon);
};

const updateCoupon = async (id, data) => {
  const existing = await prisma.coupon.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Coupon not found.');

  if (data.code && data.code !== existing.code) {
    const codeConflict = await prisma.coupon.findUnique({ where: { code: data.code } });
    if (codeConflict) throw ApiError.conflict(`Code "${data.code}" is already in use.`);
  }

  const updateData = {};
  if (data.code !== undefined) updateData.code = data.code;
  if (data.description !== undefined) updateData.description = data.description;
  if (data.type !== undefined) updateData.type = data.type;
  if (data.value !== undefined) {
    const type = data.type || existing.type;
    updateData.value = type === 'FIXED' ? toPaise(data.value) : Math.round(data.value);
  }
  if (data.scope !== undefined) updateData.scope = data.scope;
  if (data.minOrderValue !== undefined) {
    updateData.minOrderValue = data.minOrderValue ? toPaise(data.minOrderValue) : null;
  }
  if (data.maxDiscount !== undefined) {
    updateData.maxDiscount = data.maxDiscount ? toPaise(data.maxDiscount) : null;
  }
  if (data.usageLimit !== undefined) updateData.usageLimit = data.usageLimit;
  if (data.startsAt !== undefined) updateData.startsAt = data.startsAt;
  if (data.endsAt !== undefined) updateData.endsAt = data.endsAt;
  if (data.isActive !== undefined) updateData.isActive = data.isActive;

  const updated = await prisma.coupon.update({
    where: { id },
    data: updateData,
    include: {
      products: { include: { product: { select: { id: true, title: true } } } },
      categories: { include: { category: { select: { id: true, name: true } } } },
    },
  });

  return serializeCoupon(updated);
};

const deleteCoupon = async (id) => {
  const existing = await prisma.coupon.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Coupon not found.');

  // If already used in orders, soft delete by deactivating to preserve relational integrity
  if (existing.usageCount > 0) {
    await prisma.coupon.update({
      where: { id },
      data: { isActive: false },
    });
    return { id, message: 'Coupon has order history; it has been deactivated rather than deleted.' };
  }

  await prisma.coupon.delete({ where: { id } });
  return { id, message: 'Coupon deleted successfully.' };
};

module.exports = {
  listCoupons,
  getCoupon,
  createCoupon,
  updateCoupon,
  deleteCoupon,
};
