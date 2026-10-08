/*
 * Order management.
 *
 * The status flow is a state machine, enforced here rather than left to the UI.
 * A dropdown that only offers legal transitions is good; a server that only
 * accepts them is what actually prevents an order jumping from "awaiting
 * payment" to "report ready" because someone opened two tabs.
 */

const prisma = require('../../lib/prisma');
const ApiError = require('../../lib/ApiError');
const razorpay = require('../../lib/razorpay');
const settings = require('../../lib/settings');
const { toRupees } = require('../../lib/money');
const { toSkipTake, paginated } = require('../../lib/pagination');
const { writeAudit } = require('../../lib/audit');
const { sendMail } = require('../../lib/mailer');
const env = require('../../config/env');
const orders = require('./orders.service');

/*
 * Legal transitions.
 *
 * Forward through the lab's actual workflow, with cancellation available until
 * the sample is in the lab — after that there is physical work done and a
 * refund decision to make, which is a different conversation from "cancel".
 */
const TRANSITIONS = {
  PENDING_PAYMENT: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['SCHEDULED', 'SAMPLE_COLLECTED', 'CANCELLED'],
  SCHEDULED: ['SAMPLE_COLLECTED', 'CONFIRMED', 'CANCELLED'],
  SAMPLE_COLLECTED: ['IN_LAB', 'SCHEDULED'],
  IN_LAB: ['REPORT_READY', 'SAMPLE_COLLECTED'],
  REPORT_READY: ['COMPLETED', 'IN_LAB'],
  COMPLETED: [],
  CANCELLED: [],
  REFUNDED: [],
};

const ADMIN_INCLUDE = {
  ...orders.ORDER_INCLUDE,
  statusEvents: { orderBy: { createdAt: 'asc' }, include: { actor: { select: { name: true } } } },
  payments: { orderBy: { createdAt: 'desc' }, include: { refunds: true } },
};

const row = (o) => ({
  id: o.id,
  orderNumber: o.orderNumber,
  status: o.status,
  paymentStatus: o.paymentStatus,
  contactName: o.contactName,
  contactPhone: o.contactPhone,
  patientCount: o._count?.patients ?? o.patients?.length ?? 0,
  itemCount: o._count?.items ?? o.items?.length ?? 0,
  total: o.total,
  totalRupees: toRupees(o.total),
  collectionType: o.collectionType,
  centerName: o.center?.name ?? null,
  requestedDate: o.slotDate,
  requestedWindow:
    o.slotStartTime && o.slotEndTime ? `${o.slotStartTime}–${o.slotEndTime}` : null,
  createdAt: o.createdAt,
});

const detail = (o) => ({
  ...orders.serialize(o),
  internalNotes: o.internalNotes,
  cancelReason: o.cancelReason,
  cancelledAt: o.cancelledAt,
  completedAt: o.completedAt,
  // Which buttons the admin should offer. Derived from the same table the
  // server validates against, so the UI cannot drift from the rules.
  allowedTransitions: TRANSITIONS[o.status] ?? [],
  timeline: o.statusEvents.map((e) => ({
    id: e.id,
    from: e.fromStatus,
    to: e.toStatus,
    note: e.note,
    actor: e.actor?.name ?? 'System',
    at: e.createdAt,
  })),
  payments: o.payments.map((p) => ({
    id: p.id,
    provider: p.provider,
    state: p.state,
    amount: p.amount,
    amountRupees: toRupees(p.amount),
    method: p.method,
    razorpayPaymentId: p.razorpayPaymentId,
    razorpayOrderId: p.razorpayOrderId,
    failureReason: p.failureReason,
    capturedAt: p.capturedAt,
    createdAt: p.createdAt,
    refunds: p.refunds.map((r) => ({
      id: r.id,
      amount: r.amount,
      amountRupees: toRupees(r.amount),
      reason: r.reason,
      state: r.state,
      createdAt: r.createdAt,
    })),
  })),
  refundableAmount: refundable(o),
});

/** What is still refundable: captured minus already refunded. */
const refundable = (o) => {
  const captured = o.payments
    .filter((p) => p.state === 'CAPTURED')
    .reduce((sum, p) => sum + p.amount, 0);
  const refunded = o.payments
    .flatMap((p) => p.refunds)
    .filter((r) => r.state !== 'FAILED')
    .reduce((sum, r) => sum + r.amount, 0);
  return Math.max(0, captured - refunded);
};

const list = async (query) => {
  const { page, limit, status, paymentStatus, collectionType, centerId, q, from, to } = query;

  const where = {
    ...(status ? { status } : {}),
    ...(paymentStatus ? { paymentStatus } : {}),
    ...(collectionType ? { collectionType } : {}),
    ...(centerId ? { centerId } : {}),
    ...(from || to
      ? {
          // Filters on the requested collection date, not the order date: the
          // question an admin actually asks is "what are we collecting today".
          slotDate: {
            ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}),
            ...(to ? { lte: new Date(`${to}T23:59:59.999Z`) } : {}),
          },
        }
      : {}),
    ...(q
      ? {
          OR: [
            { orderNumber: { contains: q, mode: 'insensitive' } },
            { contactName: { contains: q, mode: 'insensitive' } },
            { contactPhone: { contains: q } },
            { contactEmail: { contains: q, mode: 'insensitive' } },
            { patients: { some: { name: { contains: q, mode: 'insensitive' } } } },
          ],
        }
      : {}),
  };

  const [items, total] = await prisma.$transaction([
    prisma.order.findMany({
      where,
      include: {
        center: { select: { name: true } },
        _count: { select: { patients: true, items: true } },
      },
      orderBy: { createdAt: 'desc' },
      ...toSkipTake({ page, limit }),
    }),
    prisma.order.count({ where }),
  ]);

  return paginated(items.map(row), total, { page, limit });
};

/** Counts per status, for the queue tabs. One query, not nine. */
const statusCounts = async () => {
  const rows = await prisma.order.groupBy({ by: ['status'], _count: { _all: true } });
  const counts = Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
  counts.ALL = rows.reduce((sum, r) => sum + r._count._all, 0);
  return counts;
};

const getById = async (id) => {
  const order = await prisma.order.findUnique({ where: { id }, include: ADMIN_INCLUDE });
  if (!order) throw ApiError.notFound('Order not found.');
  return detail(order);
};

const setStatus = async (id, { status, note }, req) => {
  const existing = await prisma.order.findUnique({
    where: { id },
    select: { id: true, status: true, orderNumber: true, paymentStatus: true },
  });
  if (!existing) throw ApiError.notFound('Order not found.');

  if (existing.status === status) {
    throw ApiError.conflict(`This order is already ${status.toLowerCase().replace(/_/g, ' ')}.`);
  }

  const allowed = TRANSITIONS[existing.status] ?? [];
  if (!allowed.includes(status)) {
    throw ApiError.conflict(
      `An order that is ${existing.status.toLowerCase().replace(/_/g, ' ')} cannot move to ${status.toLowerCase().replace(/_/g, ' ')}.`,
    );
  }

  // Confirming an unpaid order is allowed — cash on collection happens — but it
  // is worth recording that it was a deliberate choice.
  const unpaidNote =
    status === 'CONFIRMED' && existing.paymentStatus !== 'PAID'
      ? 'Confirmed without payment'
      : null;

  const order = await prisma.$transaction(async (tx) => {
    const updated = await tx.order.update({
      where: { id },
      data: {
        status,
        ...(status === 'COMPLETED' ? { completedAt: new Date() } : {}),
        ...(status === 'CONFIRMED' && !existing.placedAt ? { placedAt: new Date() } : {}),
      },
    });

    await tx.orderStatusEvent.create({
      data: {
        orderId: id,
        fromStatus: existing.status,
        toStatus: status,
        note: note ?? unpaidNote ?? null,
        actorId: req.user?.id ?? null,
      },
    });

    return updated;
  });

  await writeAudit({
    req,
    action: 'order.status_changed',
    entityType: 'Order',
    entityId: id,
    before: { status: existing.status },
    after: { status: order.status, note },
  });

  return getById(id);
};

const reschedule = async (id, { date, windowId, note }, req) => {
  const existing = await prisma.order.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Order not found.');

  const { windows } = await settings.collection();
  const window = windows.find((w) => w.id === windowId);
  if (!window) {
    throw ApiError.unprocessable('Validation failed.', { windowId: 'Choose a time window.' });
  }

  /*
   * No notice-period check here, unlike checkout. An admin rescheduling on the
   * phone may well be moving a collection to this afternoon, and refusing that
   * because a customer-facing rule says four hours would be absurd.
   */
  const order = await prisma.$transaction(async (tx) => {
    const updated = await tx.order.update({
      where: { id },
      data: {
        slotDate: new Date(`${date}T00:00:00.000Z`),
        slotStartTime: window.start,
        slotEndTime: window.end,
      },
    });
    await tx.orderStatusEvent.create({
      data: {
        orderId: id,
        fromStatus: existing.status,
        toStatus: existing.status,
        note: note ?? `Rescheduled to ${date} ${window.start}–${window.end}`,
        actorId: req.user?.id ?? null,
      },
    });
    return updated;
  });

  await writeAudit({
    req,
    action: 'order.rescheduled',
    entityType: 'Order',
    entityId: id,
    before: { date: existing.slotDate, start: existing.slotStartTime },
    after: { date: order.slotDate, start: order.slotStartTime },
  });

  return getById(id);
};

const setNotes = async (id, internalNotes, req) => {
  const existing = await prisma.order.findUnique({
    where: { id },
    select: { internalNotes: true },
  });
  if (!existing) throw ApiError.notFound('Order not found.');

  await prisma.order.update({ where: { id }, data: { internalNotes } });

  await writeAudit({
    req,
    action: 'order.notes_updated',
    entityType: 'Order',
    entityId: id,
    before: { internalNotes: existing.internalNotes },
    after: { internalNotes },
  });

  return getById(id);
};

const cancel = async (id, { reason }, req) => {
  const existing = await prisma.order.findUnique({
    where: { id },
    select: { id: true, status: true, paymentStatus: true, orderNumber: true },
  });
  if (!existing) throw ApiError.notFound('Order not found.');

  if (!(TRANSITIONS[existing.status] ?? []).includes('CANCELLED')) {
    throw ApiError.conflict(
      `An order that is ${existing.status.toLowerCase().replace(/_/g, ' ')} can no longer be cancelled.`,
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason },
    });
    await tx.orderStatusEvent.create({
      data: {
        orderId: id,
        fromStatus: existing.status,
        toStatus: 'CANCELLED',
        note: reason,
        actorId: req.user?.id ?? null,
      },
    });
  });

  await writeAudit({
    req,
    action: 'order.cancelled',
    entityType: 'Order',
    entityId: id,
    before: { status: existing.status },
    after: { reason },
  });

  /*
   * Cancelling does not refund. Money moving is always a separate, deliberate
   * action — bundling them would mean a mis-click on "cancel" sends money.
   */
  return getById(id);
};

const refund = async (id, { amount, reason }, req) => {
  const order = await prisma.order.findUnique({
    where: { id },
    include: { payments: { include: { refunds: true } } },
  });
  if (!order) throw ApiError.notFound('Order not found.');

  const available = refundable(order);
  if (available <= 0) {
    throw ApiError.conflict('There is nothing left to refund on this order.');
  }

  const value = amount ?? available;
  if (value > available) {
    throw ApiError.unprocessable('Validation failed.', {
      amount: `At most ₹${toRupees(available)} can be refunded.`,
    });
  }

  const payment = order.payments.find((p) => p.state === 'CAPTURED' && p.razorpayPaymentId);
  if (!payment) throw ApiError.conflict('No captured payment to refund against.');

  // The row is created first so a Razorpay call that succeeds but whose response
  // is lost still leaves a trace to reconcile against.
  const record = await prisma.refund.create({
    data: {
      paymentId: payment.id,
      amount: value,
      reason: reason ?? null,
      state: 'PENDING',
      actorId: req.user?.id ?? null,
    },
  });

  try {
    const result = await razorpay.refund({
      paymentId: payment.razorpayPaymentId,
      amount: value,
      notes: { orderNumber: order.orderNumber, reason: reason ?? '' },
    });

    await prisma.refund.update({
      where: { id: record.id },
      data: { razorpayRefundId: result.id, state: 'PROCESSED', rawPayload: result },
    });
  } catch (err) {
    await prisma.refund.update({
      where: { id: record.id },
      data: { state: 'FAILED', rawPayload: { error: String(err?.message ?? err) } },
    });
    throw err;
  }

  const fullyRefunded = value >= available;

  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id },
      data: {
        paymentStatus: fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
        ...(fullyRefunded ? { status: 'REFUNDED' } : {}),
      },
    });
    await tx.orderStatusEvent.create({
      data: {
        orderId: id,
        fromStatus: order.status,
        toStatus: fullyRefunded ? 'REFUNDED' : order.status,
        note: `Refunded ₹${toRupees(value)}${reason ? ` — ${reason}` : ''}`,
        actorId: req.user?.id ?? null,
      },
    });
  });

  await writeAudit({
    req,
    action: 'order.refunded',
    entityType: 'Order',
    entityId: id,
    after: { amount: value, reason, full: fullyRefunded },
  });

  return getById(id);
};

const resendConfirmation = async (id, req) => {
  const order = await prisma.order.findUnique({ where: { id }, include: ADMIN_INCLUDE });
  if (!order) throw ApiError.notFound('Order not found.');
  if (!order.contactEmail) {
    throw ApiError.conflict('This booking has no email address on it.');
  }

  const token = await orders.ensureAccessToken(order.id);
  const url = `${env.PUBLIC_URL}/booking-confirmation/?order=${encodeURIComponent(order.orderNumber)}&token=${token}`;

  const result = await sendMail({
    to: order.contactEmail,
    subject: `Your Arova Labs booking ${order.orderNumber}`,
    text: [
      `Hello ${order.contactName},`,
      '',
      `Your booking reference is ${order.orderNumber}.`,
      `Total: ₹${toRupees(order.total)}`,
      '',
      'View your booking:',
      url,
      '',
      'Our team will call to confirm the collection time.',
    ].join('\n'),
  });

  await writeAudit({
    req,
    action: 'order.confirmation_resent',
    entityType: 'Order',
    entityId: id,
    after: { to: order.contactEmail, sent: result.sent },
  });

  // Honest about the outcome: with no SMTP configured the mailer logs instead of
  // sending, and the admin is told that rather than shown a false success.
  return result;
};

/*
 * CSV export of whatever the current filters select.
 *
 * Built by hand rather than with a library: the escaping rule for CSV is one
 * line, and a dependency for it is not worth the install on shared hosting.
 */
const exportCsv = async (query) => {
  const rows = await prisma.order.findMany({
    // Capped: an export is a download, not a reason to pull an unbounded table
    // across a remote connection.
    where: {
      ...(query.status ? { status: query.status } : {}),
      ...(query.paymentStatus ? { paymentStatus: query.paymentStatus } : {}),
      ...(query.collectionType ? { collectionType: query.collectionType } : {}),
      ...(query.from || query.to
        ? {
            slotDate: {
              ...(query.from ? { gte: new Date(`${query.from}T00:00:00.000Z`) } : {}),
              ...(query.to ? { lte: new Date(`${query.to}T23:59:59.999Z`) } : {}),
            },
          }
        : {}),
    },
    include: {
      center: { select: { name: true } },
      items: true,
      patients: true,
      address: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 5000,
  });

  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const header = [
    'Order', 'Placed', 'Status', 'Payment', 'Customer', 'Phone', 'Email',
    'Patients', 'Tests', 'Collection', 'Centre', 'Requested date', 'Window',
    'Address', 'Pincode', 'Subtotal', 'Discount', 'Total',
  ];

  const lines = rows.map((o) =>
    [
      o.orderNumber,
      o.createdAt.toISOString().slice(0, 16).replace('T', ' '),
      o.status,
      o.paymentStatus,
      o.contactName,
      o.contactPhone,
      o.contactEmail ?? '',
      o.patients.map((p) => p.name).join('; '),
      o.items.map((i) => `${i.productTitle} x${i.quantity}`).join('; '),
      o.collectionType,
      o.center?.name ?? '',
      o.slotDate ? o.slotDate.toISOString().slice(0, 10) : '',
      o.slotStartTime && o.slotEndTime ? `${o.slotStartTime}-${o.slotEndTime}` : '',
      o.address ? [o.address.line1, o.address.city, o.address.state].filter(Boolean).join(', ') : '',
      o.address?.pincode ?? '',
      toRupees(o.subtotal),
      toRupees(o.discountTotal),
      toRupees(o.total),
    ]
      .map(esc)
      .join(','),
  );

  return [header.join(','), ...lines].join('\n');
};

module.exports = {
  list,
  statusCounts,
  getById,
  setStatus,
  reschedule,
  setNotes,
  cancel,
  refund,
  resendConfirmation,
  exportCsv,
  TRANSITIONS,
};
