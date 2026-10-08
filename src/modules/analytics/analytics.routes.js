const { Router } = require('express');
const { z } = require('zod');
const asyncHandler = require('../../lib/asyncHandler');
const validate = require('../../middleware/validate');
const { requireAdmin } = require('../../middleware/requireAdmin');
const prisma = require('../../lib/prisma');

const router = Router();
router.use(requireAdmin);

const dateQuery = z.object({
  from: z.string().date(),
  to: z.string().date(),
});
const startOf = (day) => new Date(`${day}T00:00:00.000Z`);
const endOf = (day) => new Date(`${day}T23:59:59.999Z`);
const dayKey = (date) => date.toISOString().slice(0, 10);
const indiaToday = () => {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
};

router.get('/', validate({ query: dateQuery }), asyncHandler(async (req, res) => {
  const from = startOf(req.query.from);
  const to = endOf(req.query.to);
  if (from > to) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'The start date must be on or before the end date.' } });
  const dayCount = Math.max(1, Math.round((startOf(req.query.to) - from) / 86_400_000) + 1);
  const previousFrom = new Date(from.getTime() - dayCount * 86_400_000);
  const previousTo = new Date(from.getTime() - 1);

  const [orders, payments, refunds, priorOrders, priorPayments, priorRefunds, statusRows,
    pendingReports, prescriptions, leadRows, collectionRows, productRows] = await Promise.all([
    prisma.order.findMany({ where: { createdAt: { gte: from, lte: to } }, select: { id: true, createdAt: true, total: true, paymentStatus: true, status: true } }),
    prisma.payment.findMany({ where: { state: 'CAPTURED', capturedAt: { gte: from, lte: to } }, select: { amount: true, capturedAt: true } }),
    prisma.refund.findMany({ where: { state: 'PROCESSED', createdAt: { gte: from, lte: to } }, select: { amount: true, createdAt: true } }),
    prisma.order.count({ where: { createdAt: { gte: previousFrom, lte: previousTo } } }),
    prisma.payment.aggregate({ where: { state: 'CAPTURED', capturedAt: { gte: previousFrom, lte: previousTo } }, _sum: { amount: true } }),
    prisma.refund.aggregate({ where: { state: 'PROCESSED', createdAt: { gte: previousFrom, lte: previousTo } }, _sum: { amount: true } }),
    prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.order.findMany({ where: { status: { in: ['SAMPLE_COLLECTED', 'IN_LAB', 'REPORT_READY'] } }, select: { id: true, status: true, items: { select: { id: true } }, reports: { where: { status: 'PUBLISHED' }, select: { id: true } } } }),
    prisma.prescription.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.contactMessage.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.order.findMany({ where: { slotDate: { gte: startOf(indiaToday()), lte: endOf(indiaToday()) }, status: { notIn: ['CANCELLED', 'REFUNDED'] } }, select: { slotStartTime: true, slotEndTime: true, collectionType: true, center: { select: { name: true } } }, orderBy: { slotStartTime: 'asc' } }),
    prisma.orderItem.groupBy({ by: ['productTitle'], where: { order: { createdAt: { gte: from, lte: to }, paymentStatus: 'PAID' } }, _sum: { quantity: true, lineTotal: true }, orderBy: { _sum: { lineTotal: 'desc' } }, take: 5 }),
  ]);

  const trend = new Map();
  for (let i = 0; i < dayCount; i += 1) {
    const date = new Date(from.getTime() + i * 86_400_000);
    trend.set(dayKey(date), { date: dayKey(date), orders: 0, revenue: 0 });
  }
  for (const order of orders) {
    const point = trend.get(dayKey(order.createdAt));
    if (point) point.orders += 1;
  }
  for (const payment of payments) {
    const point = payment.capturedAt && trend.get(dayKey(payment.capturedAt));
    if (point) point.revenue += payment.amount;
  }
  for (const refund of refunds) {
    const point = trend.get(dayKey(refund.createdAt));
    if (point) point.revenue -= refund.amount;
  }

  const revenue = payments.reduce((sum, p) => sum + p.amount, 0) - refunds.reduce((sum, r) => sum + r.amount, 0);
  const previousRevenue = (priorPayments._sum.amount ?? 0) - (priorRefunds._sum.amount ?? 0);
  const statusCounts = Object.fromEntries(statusRows.map((r) => [r.status, r._count._all]));
  const reportQueue = pendingReports.filter((o) => o.reports.length < o.items.length).length;
  const prescriptionCounts = Object.fromEntries(prescriptions.map((r) => [r.status, r._count._all]));
  const leadCounts = Object.fromEntries(leadRows.map((r) => [r.status, r._count._all]));

  res.json({
    range: { from: req.query.from, to: req.query.to, previousFrom: dayKey(previousFrom), previousTo: dayKey(previousTo) },
    kpis: {
      revenue, previousRevenue,
      orders: orders.length, previousOrders: priorOrders,
      averageOrderValue: orders.filter((o) => o.paymentStatus === 'PAID').length
        ? Math.round(revenue / orders.filter((o) => o.paymentStatus === 'PAID').length)
        : 0,
      paidOrders: orders.filter((o) => o.paymentStatus === 'PAID').length,
    },
    trend: [...trend.values()],
    orderStatuses: statusCounts,
    attention: {
      failedPayments: await prisma.payment.count({ where: { state: 'FAILED', createdAt: { gte: from, lte: to } } }),
      reportQueue,
      prescriptionsToReview: prescriptionCounts.RECEIVED ?? 0,
      newEnquiries: leadCounts.NEW ?? 0,
    },
    todayCollections: Object.values(collectionRows.reduce((groups, o) => {
      const time = o.slotStartTime && o.slotEndTime ? `${o.slotStartTime}–${o.slotEndTime}` : 'Time not set';
      const center = o.center?.name ?? (o.collectionType === 'HOME' ? 'Home collection' : 'Walk-in');
      const key = `${time}|${center}`;
      groups[key] ??= { time, center, bookings: 0 };
      groups[key].bookings += 1;
      return groups;
    }, {})),
    topProducts: productRows.map((p) => ({ title: p.productTitle, quantity: p._sum.quantity ?? 0, revenue: p._sum.lineTotal ?? 0 })),
  });
}));

module.exports = router;
