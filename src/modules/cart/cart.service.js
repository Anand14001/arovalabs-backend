/*
 * The cart.
 *
 * Server-owned, which is the whole point: the browser holds an opaque token and
 * nothing else. Quantities and product ids come from the client; every price
 * comes from the database, recomputed on each read. A client that posts its own
 * prices is ignored rather than trusted, which is the difference between a cart
 * and a suggestion.
 *
 * The token lives in the browser's localStorage rather than a cookie. A cookie
 * would be marginally safer against XSS, but the website and the API are on
 * different origins in production, which makes it a cross-site cookie needing
 * SameSite=None — more moving parts for a token whose worst-case compromise is
 * that someone sees or edits a cart. Nothing is charged from a cart; payment is
 * authorised against an order.
 */

const crypto = require('node:crypto');
const prisma = require('../../lib/prisma');
const ApiError = require('../../lib/ApiError');
const settings = require('../../lib/settings');
const { toRupees, discountLabel } = require('../../lib/money');
const storage = require('../../lib/storage');

// Long enough that guessing is pointless, short enough to sit in a URL.
const newToken = () => crypto.randomBytes(24).toString('base64url');

const CART_TTL_DAYS = 30;
const expiry = () => new Date(Date.now() + CART_TTL_DAYS * 24 * 60 * 60 * 1000);

const ITEM_INCLUDE = {
  items: {
    orderBy: { createdAt: 'asc' },
    include: { product: { include: { cardImage: true, archiveImage: true } } },
  },
  coupon: true,
};

const findOrThrow = async (token) => {
  const cart = await prisma.cart.findUnique({ where: { token }, include: ITEM_INCLUDE });
  if (!cart) throw ApiError.notFound('That cart no longer exists.');
  if (cart.status === 'CONVERTED') {
    throw ApiError.conflict('This cart has already been turned into an order.');
  }
  return cart;
};

// ------------------------------------------------------------------ totals

/*
 * Coupon validity, checked at the moment of use rather than when it was applied.
 *
 * A coupon can expire, be deactivated or hit its usage limit while it is sitting
 * in someone's cart, so this runs on every read. An invalid one is dropped with
 * a reason rather than silently discounting an order it should not.
 */
const couponProblem = (coupon, subtotal) => {
  if (!coupon) return null;
  const now = new Date();

  if (!coupon.isActive) return 'This code is no longer active.';
  if (coupon.startsAt && coupon.startsAt > now) return 'This code is not valid yet.';
  if (coupon.endsAt && coupon.endsAt < now) return 'This code has expired.';
  if (coupon.usageLimit !== null && coupon.usageCount >= coupon.usageLimit) {
    return 'This code has been fully redeemed.';
  }
  if (coupon.minOrderValue && subtotal < coupon.minOrderValue) {
    return `This code needs a minimum order of ₹${toRupees(coupon.minOrderValue)}.`;
  }
  return null;
};

const discountFor = (coupon, subtotal) => {
  if (!coupon) return 0;

  const raw =
    coupon.type === 'PERCENT'
      ? Math.round((subtotal * coupon.value) / 100)
      : coupon.value;

  const capped = coupon.maxDiscount ? Math.min(raw, coupon.maxDiscount) : raw;

  // Never discount below zero: a fixed-value coupon larger than the cart would
  // otherwise produce a negative total.
  return Math.max(0, Math.min(capped, subtotal));
};

/*
 * Totals.
 *
 * Computed from the database every time, never stored on the client and never
 * trusted from it. The stored columns on Cart are a cache for the admin, written
 * from this result.
 */
const computeTotals = async (cart) => {
  const { taxPercent, collectionFeePaise, freeCollectionThresholdPaise } =
    await settings.commerce();

  const lines = cart.items.map((item) => {
    // The live price wins. A product repriced after it was added should show
    // its new price, not the one captured at add time.
    const unitPrice = item.product.salePrice;
    const lineTotal = unitPrice * item.quantity;
    return {
      item,
      unitPrice,
      lineTotal,
      priceChanged: unitPrice !== item.unitPrice,
    };
  });

  const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);

  const problem = couponProblem(cart.coupon, subtotal);
  const coupon = problem ? null : cart.coupon;
  const discountTotal = discountFor(coupon, subtotal);

  const afterDiscount = subtotal - discountTotal;

  const collectionFee =
    collectionFeePaise > 0 && afterDiscount < freeCollectionThresholdPaise
      ? collectionFeePaise
      : collectionFeePaise > 0 && freeCollectionThresholdPaise === 0
        ? collectionFeePaise
        : 0;

  const taxTotal = taxPercent > 0 ? Math.round((afterDiscount * taxPercent) / 100) : 0;

  return {
    lines,
    subtotal,
    discountTotal,
    collectionFee,
    taxTotal,
    total: afterDiscount + collectionFee + taxTotal,
    couponProblem: problem,
    appliedCoupon: coupon,
  };
};

// -------------------------------------------------------------- serializer

const serialize = (cart, totals) => ({
  token: cart.token,
  items: totals.lines.map(({ item, unitPrice, lineTotal, priceChanged }) => ({
    id: item.id,
    productId: item.productId,
    slug: item.product.slug,
    title: item.product.title,
    type: item.product.type,
    image:
      storage.publicUrl(item.product.cardImage) ??
      storage.publicUrl(item.product.archiveImage),
    quantity: item.quantity,
    unitPrice,
    unitPriceRupees: toRupees(unitPrice),
    lineTotal,
    lineTotalRupees: toRupees(lineTotal),
    regularPrice: item.product.regularPrice,
    discountLabel: discountLabel(item.product.regularPrice, unitPrice),
    // Surfaced so the cart can say so rather than quietly changing the number.
    priceChanged,
    unavailable: item.product.status !== 'PUBLISHED',
  })),
  count: cart.items.reduce((n, i) => n + i.quantity, 0),
  totals: {
    subtotal: totals.subtotal,
    discount: totals.discountTotal,
    collectionFee: totals.collectionFee,
    tax: totals.taxTotal,
    total: totals.total,
    subtotalRupees: toRupees(totals.subtotal),
    discountRupees: toRupees(totals.discountTotal),
    collectionFeeRupees: toRupees(totals.collectionFee),
    taxRupees: toRupees(totals.taxTotal),
    totalRupees: toRupees(totals.total),
  },
  coupon: totals.appliedCoupon
    ? {
        code: totals.appliedCoupon.code,
        type: totals.appliedCoupon.type,
        value: totals.appliedCoupon.value,
        description: totals.appliedCoupon.description,
      }
    : null,
  couponProblem: totals.couponProblem,
});

/** Writes the computed totals back onto the row, for the admin's benefit. */
const persistTotals = (cart, totals) =>
  prisma.cart.update({
    where: { id: cart.id },
    data: {
      subtotal: totals.subtotal,
      discountTotal: totals.discountTotal,
      total: totals.total,
      // A cart that is being used should not expire in the middle of using it.
      expiresAt: expiry(),
      ...(totals.couponProblem ? { couponId: null } : {}),
    },
  });

const present = async (cart) => {
  const totals = await computeTotals(cart);
  await persistTotals(cart, totals);
  return serialize(cart, totals);
};

// ------------------------------------------------------------------ actions

const create = async () => {
  const cart = await prisma.cart.create({
    data: { token: newToken(), expiresAt: expiry() },
    include: ITEM_INCLUDE,
  });
  return present(cart);
};

const get = async (token) => present(await findOrThrow(token));

/*
 * Add an item.
 *
 * Creates the cart if the token is unknown rather than erroring: a visitor whose
 * cart expired mid-session should be able to keep shopping, not hit a wall.
 * Returns the (possibly new) token so the client can store it.
 */
const addItem = async (token, { productId, quantity }) => {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) throw ApiError.notFound('That test or package does not exist.');
  if (product.status !== 'PUBLISHED') {
    throw ApiError.conflict('That test is not available for booking.');
  }

  let cart = token
    ? await prisma.cart.findUnique({ where: { token }, include: ITEM_INCLUDE })
    : null;

  if (!cart || cart.status === 'CONVERTED') {
    cart = await prisma.cart.create({
      data: { token: newToken(), expiresAt: expiry() },
      include: ITEM_INCLUDE,
    });
  }

  const existing = cart.items.find((i) => i.productId === productId);

  if (existing) {
    await prisma.cartItem.update({
      where: { id: existing.id },
      data: { quantity: existing.quantity + quantity, unitPrice: product.salePrice },
    });
  } else {
    await prisma.cartItem.create({
      data: {
        cartId: cart.id,
        productId,
        quantity,
        unitPrice: product.salePrice,
      },
    });
  }

  return present(await findOrThrow(cart.token));
};

const setQuantity = async (token, itemId, quantity) => {
  const cart = await findOrThrow(token);
  const item = cart.items.find((i) => i.id === itemId);
  if (!item) throw ApiError.notFound('That item is not in this cart.');

  if (quantity <= 0) {
    await prisma.cartItem.delete({ where: { id: itemId } });
  } else {
    await prisma.cartItem.update({ where: { id: itemId }, data: { quantity } });
  }

  return present(await findOrThrow(token));
};

const removeItem = async (token, itemId) => {
  const cart = await findOrThrow(token);
  const item = cart.items.find((i) => i.id === itemId);
  if (!item) throw ApiError.notFound('That item is not in this cart.');

  await prisma.cartItem.delete({ where: { id: itemId } });
  return present(await findOrThrow(token));
};

const clear = async (token) => {
  const cart = await findOrThrow(token);
  await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
  await prisma.cart.update({ where: { id: cart.id }, data: { couponId: null } });
  return present(await findOrThrow(token));
};

const applyCoupon = async (token, code) => {
  const cart = await findOrThrow(token);

  const coupon = await prisma.coupon.findUnique({
    where: { code: code.trim().toUpperCase() },
  });

  // Deliberately the same message for "no such code" and "not valid for you":
  // a code is a secret of sorts, and confirming one exists invites probing.
  if (!coupon) throw ApiError.unprocessable('Validation failed.', { code: 'That code is not valid.' });

  const totals = await computeTotals(cart);
  const problem = couponProblem(coupon, totals.subtotal);
  if (problem) throw ApiError.unprocessable('Validation failed.', { code: problem });

  if (discountFor(coupon, totals.subtotal) === 0) {
    throw ApiError.unprocessable('Validation failed.', {
      code: 'That code does not reduce this order.',
    });
  }

  await prisma.cart.update({ where: { id: cart.id }, data: { couponId: coupon.id } });
  return present(await findOrThrow(token));
};

const removeCoupon = async (token) => {
  const cart = await findOrThrow(token);
  await prisma.cart.update({ where: { id: cart.id }, data: { couponId: null } });
  return present(await findOrThrow(token));
};

module.exports = {
  create,
  get,
  addItem,
  setQuantity,
  removeItem,
  clear,
  applyCoupon,
  removeCoupon,
  computeTotals,
  findOrThrow,
  present,
  ITEM_INCLUDE,
};
