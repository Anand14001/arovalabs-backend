const prisma = require('../../lib/prisma');
const logger = require('../../lib/logger');
const mailer = require('../../lib/mailer');
const env = require('../../config/env');
const ApiError = require('../../lib/ApiError');

/**
 * Creates a new contact message / lead from public enquiry submission.
 */
const createContactMessage = async (data, req) => {
  // Check honeypot: if filled, reject silently or with forbidden
  if (data.website_hp) {
    logger.warn({ ip: req.ip }, 'Contact submission dropped due to non-empty honeypot');
    throw ApiError.badRequest('Submission rejected.');
  }

  const { name, email, phone, topic, message, source } = data;

  // Format combined message if topic was specified
  const formattedMessage = topic && topic !== 'General'
    ? `[Topic: ${topic}]\n\n${message}`
    : message;

  const lead = await prisma.contactMessage.create({
    data: {
      name: name?.trim() || null,
      email: email.trim().toLowerCase(),
      phone: phone?.trim() || null,
      message: formattedMessage,
      source: source || 'website_contact',
      ipAddress: req.ip || null,
      status: 'NEW',
    },
  });

  logger.info({ leadId: lead.id, email: lead.email }, 'New contact message enquiry recorded');

  // Trigger non-blocking notifications
  sendNotifications(lead, topic).catch((err) => {
    logger.error({ err, leadId: lead.id }, 'Failed to dispatch contact message notifications');
  });

  return {
    id: lead.id,
    message: 'Your enquiry has been received. Our team will get in touch shortly.',
  };
};

/**
 * Sends notification emails (operations alert and acknowledgement).
 */
const sendNotifications = async (lead, topic) => {
  // 1. Alert internal admin / lab team
  const adminSubject = `[New Enquiry] ${topic ? `[${topic}] ` : ''}${lead.name || lead.email}`;
  const adminText = [
    `New enquiry received on Arova Labs:`,
    `Name: ${lead.name || 'Not provided'}`,
    `Email: ${lead.email}`,
    `Phone: ${lead.phone || 'Not provided'}`,
    `Topic: ${topic || 'General'}`,
    `Received: ${new Date().toLocaleString('en-IN')}`,
    `\nMessage:\n${lead.message}`,
  ].join('\n');

  await mailer.sendMail({
    to: env.ADMIN_EMAIL,
    subject: adminSubject,
    text: adminText,
  });

  // 2. Optional acknowledgment to the user
  if (lead.email) {
    const userSubject = `We've received your enquiry — Arova Labs`;
    const userText = [
      `Dear ${lead.name || 'Valued Patient'},`,
      ``,
      `Thank you for contacting Arova Labs. We have received your enquiry regarding "${topic || 'General'}".`,
      `Our diagnostics team will review your message and reach out to you shortly.`,
      ``,
      `Warm regards,`,
      `Arova Labs Team`,
    ].join('\n');

    await mailer.sendMail({
      to: lead.email,
      subject: userSubject,
      text: userText,
    });
  }
};

/**
 * Admin: List contact messages with status filter, search and pagination.
 */
const listContactMessages = async ({ page = 1, limit = 20, status, q }) => {
  const where = {};

  if (status) {
    where.status = status;
  }

  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
      { phone: { contains: q, mode: 'insensitive' } },
      { message: { contains: q, mode: 'insensitive' } },
    ];
  }

  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    prisma.contactMessage.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: {
        assignedTo: {
          select: { id: true, name: true, email: true },
        },
      },
    }),
    prisma.contactMessage.count({ where }),
  ]);

  return {
    items,
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

/**
 * Admin: Get counts per status.
 */
const getContactMessageCounts = async () => {
  const groups = await prisma.contactMessage.groupBy({
    by: ['status'],
    _count: { _all: true },
  });

  const counts = { ALL: 0, NEW: 0, IN_PROGRESS: 0, RESOLVED: 0, SPAM: 0 };
  for (const g of groups) {
    counts[g.status] = g._count._all;
    counts.ALL += g._count._all;
  }
  return counts;
};

/**
 * Admin: Update message status, notes or assign staff.
 */
const updateContactMessage = async (id, data) => {
  const existing = await prisma.contactMessage.findUnique({ where: { id } });
  if (!existing) {
    throw ApiError.notFound('Enquiry message not found.');
  }

  const updated = await prisma.contactMessage.update({
    where: { id },
    data,
    include: {
      assignedTo: { select: { id: true, name: true, email: true } },
    },
  });

  return updated;
};

module.exports = {
  createContactMessage,
  listContactMessages,
  getContactMessageCounts,
  updateContactMessage,
};
