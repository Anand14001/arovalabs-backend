const { Router } = require('express');
const { z } = require('zod');
const asyncHandler = require('../../lib/asyncHandler');
const validate = require('../../middleware/validate');
const { pageQuery } = require('../../lib/pagination');
const service = require('./orders.admin.service');

const router = Router();

const ORDER_STATUS = [
  'PENDING_PAYMENT', 'CONFIRMED', 'SCHEDULED', 'SAMPLE_COLLECTED',
  'IN_LAB', 'REPORT_READY', 'COMPLETED', 'CANCELLED', 'REFUNDED',
];

const PAYMENT_STATUS = [
  'UNPAID', 'PENDING', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'FAILED',
];

const filters = {
  status: z.enum(ORDER_STATUS).optional(),
  paymentStatus: z.enum(PAYMENT_STATUS).optional(),
  collectionType: z.enum(['HOME', 'WALK_IN']).optional(),
  centerId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(120).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
};

const idParam = { params: z.object({ id: z.coerce.number().int().positive() }) };

router.get(
  '/',
  validate({ query: pageQuery.extend(filters) }),
  asyncHandler(async (req, res) => {
    res.json(await service.list(req.query));
  }),
);

// Before /:id, or "counts" and "export" would be read as order ids.
router.get(
  '/counts',
  asyncHandler(async (_req, res) => {
    res.json({ counts: await service.statusCounts() });
  }),
);

router.get(
  '/export',
  validate({ query: z.object(filters) }),
  asyncHandler(async (req, res) => {
    const csv = await service.exportCsv(req.query);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="arova-orders-${stamp}.csv"`);
    // A BOM, so Excel opens it as UTF-8 instead of mangling patient names.
    res.send(`﻿${csv}`);
  }),
);

router.get(
  '/:id',
  validate(idParam),
  asyncHandler(async (req, res) => {
    res.json({ order: await service.getById(req.params.id) });
  }),
);

router.patch(
  '/:id/status',
  validate({
    ...idParam,
    body: z.object({
      status: z.enum(ORDER_STATUS),
      note: z.string().trim().max(500).optional().nullable(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json({ order: await service.setStatus(req.params.id, req.body, req) });
  }),
);

router.patch(
  '/:id/slot',
  validate({
    ...idParam,
    body: z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date.'),
      windowId: z.string().trim().min(1).max(32),
      note: z.string().trim().max(500).optional().nullable(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json({ order: await service.reschedule(req.params.id, req.body, req) });
  }),
);

router.patch(
  '/:id/notes',
  validate({
    ...idParam,
    body: z.object({ internalNotes: z.string().trim().max(5000).nullable() }),
  }),
  asyncHandler(async (req, res) => {
    res.json({ order: await service.setNotes(req.params.id, req.body.internalNotes, req) });
  }),
);

router.post(
  '/:id/cancel',
  validate({
    ...idParam,
    // A reason is required: "why was this cancelled" is the first question
    // anyone asks later, and an empty field makes it unanswerable.
    body: z.object({ reason: z.string().trim().min(1, 'Give a reason.').max(500) }),
  }),
  asyncHandler(async (req, res) => {
    res.json({ order: await service.cancel(req.params.id, req.body, req) });
  }),
);

router.post(
  '/:id/refund',
  validate({
    ...idParam,
    body: z.object({
      // Rupees in, paise stored — the admin types what a person would say.
      amount: z
        .number()
        .positive()
        .transform((v) => Math.round(v * 100))
        .optional()
        .nullable(),
      reason: z.string().trim().max(500).optional().nullable(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json({ order: await service.refund(req.params.id, req.body, req) });
  }),
);

router.post(
  '/:id/resend-confirmation',
  validate(idParam),
  asyncHandler(async (req, res) => {
    res.json(await service.resendConfirmation(req.params.id, req));
  }),
);

module.exports = router;
