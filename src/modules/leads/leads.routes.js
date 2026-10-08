const { Router } = require('express');
const asyncHandler = require('../../lib/asyncHandler');
const validate = require('../../middleware/validate');
const { formLimiter } = require('../../middleware/rateLimit');
const { createContactMessageSchema, listContactMessagesSchema, updateLeadSchema } = require('./leads.schema');
const leadsService = require('./leads.service');

const publicRouter = Router();
const adminRouter = Router();

/**
 * POST /contact
 * Public enquiry form submission with rate limiting and schema validation.
 */
publicRouter.post(
  '/',
  formLimiter,
  validate({ body: createContactMessageSchema }),
  asyncHandler(async (req, res) => {
    const result = await leadsService.createContactMessage(req.body, req);
    res.status(201).json(result);
  }),
);

/**
 * GET /admin/leads/messages
 * List enquiry messages with pagination and filtering.
 */
adminRouter.get(
  '/messages',
  validate({ query: listContactMessagesSchema }),
  asyncHandler(async (req, res) => {
    const result = await leadsService.listContactMessages(req.query);
    res.json(result);
  }),
);

/**
 * GET /admin/leads/messages/counts
 * Status counts.
 */
adminRouter.get(
  '/messages/counts',
  asyncHandler(async (_req, res) => {
    const counts = await leadsService.getContactMessageCounts();
    res.json(counts);
  }),
);

/**
 * PATCH /admin/leads/messages/:id
 * Update status, notes, or assignment.
 */
adminRouter.patch(
  '/messages/:id',
  validate({ body: updateLeadSchema }),
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const updated = await leadsService.updateContactMessage(id, req.body);
    res.json(updated);
  }),
);

module.exports = {
  publicRouter,
  adminRouter,
};
