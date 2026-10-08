/*
 * Payments.
 *
 * Two independent routes lead to "this order is paid", and that is on purpose:
 *
 *   - the browser's success callback, which is fast but comes from an untrusted
 *     client, so it is only believed once its signature checks out;
 *   - the webhook, which the browser cannot influence at all, and which arrives
 *     even when the customer closes the tab mid-payment.
 *
 * Either can arrive first, or twice, or out of order. Everything below is
 * written to be idempotent so that none of that matters: marking a paid order
 * paid again is a no-op, not a second confirmation.
 */

const prisma = require('../../lib/prisma');
const ApiError = require('../../lib/ApiError');
const razorpay = require('../../lib/razorpay');
const logger = require('../../lib/logger');
const { writeAudit } = require('../../lib/audit');

/*
 * Mark an order paid.
 *
 * Returns { changed } so callers can tell a real transition from a replay, and
 * only send a confirmation email on the former.
 */
const markPaid = async ({ orderId, paymentId, method, rawPayload }, req) => {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { id: true, orderNumber: true, status: true, paymentStatus: true },
    });
    if (!order) throw ApiError.notFound('Order not found.');

    /*
     * The payment row is reconciled on every call, including replays.
     *
     * This used to be skipped once the order was already PAID, which meant a
     * second callback — a double-submitted handler, a retry, or the webhook
     * arriving after the browser — left the payment stuck at AUTHORIZED. An
     * order in that state reports nothing refundable, so refunding a booking
     * that was genuinely charged became impossible.
     */
    await tx.payment.updateMany({
      where: {
        orderId,
        ...(paymentId ? { razorpayPaymentId: paymentId } : {}),
        state: { not: 'CAPTURED' },
      },
      data: { state: 'CAPTURED', method: method ?? null, capturedAt: new Date(), rawPayload },
    });

    if (order.paymentStatus === 'PAID') {
      return { changed: false, order };
    }

    await tx.order.update({
      where: { id: orderId },
      data: {
        paymentStatus: 'PAID',
        // Payment is what turns a pending booking into a real one. Any later
        // status — already collected, already in the lab — is left alone.
        ...(order.status === 'PENDING_PAYMENT'
          ? { status: 'CONFIRMED', placedAt: new Date() }
          : {}),
      },
    });

    await tx.orderStatusEvent.create({
      data: {
        orderId,
        fromStatus: order.status,
        toStatus: order.status === 'PENDING_PAYMENT' ? 'CONFIRMED' : order.status,
        note: 'Payment received',
      },
    });

    return { changed: true, order };
  });
};

const markFailed = async ({ orderId, paymentId, reason, rawPayload }) => {
  await prisma.payment.updateMany({
    where: { orderId, ...(paymentId ? { razorpayPaymentId: paymentId } : {}) },
    data: { state: 'FAILED', failureReason: reason?.slice(0, 500) ?? null, rawPayload },
  });

  // The order stays PENDING_PAYMENT, not cancelled: a failed card is usually
  // followed by a successful retry, and cancelling would throw away the booking.
  await prisma.order.updateMany({
    where: { id: orderId, paymentStatus: { in: ['UNPAID', 'PENDING'] } },
    data: { paymentStatus: 'FAILED' },
  });
};

/**
 * The browser's success callback.
 *
 * The signature is the whole security boundary here — without it this endpoint
 * would let anyone mark any order paid by posting an id.
 */
const verifyFromCheckout = async (
  { razorpayOrderId, razorpayPaymentId, signature },
  req,
) => {
  const payment = await prisma.payment.findUnique({
    where: { razorpayOrderId },
    include: { order: { select: { id: true, orderNumber: true } } },
  });

  if (!payment) throw ApiError.notFound('We could not find that payment.');

  if (!razorpay.verifyPaymentSignature({ razorpayOrderId, razorpayPaymentId, signature })) {
    await writeAudit({
      req,
      action: 'payment.signature_invalid',
      entityType: 'Order',
      entityId: payment.orderId,
      after: { razorpayOrderId, razorpayPaymentId },
    });
    throw ApiError.badRequest('We could not verify that payment.');
  }

  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      razorpayPaymentId,
      razorpaySignature: signature,
      // Forward only. Setting AUTHORIZED unconditionally pulled an already
      // captured payment backwards whenever this callback was replayed.
      ...(payment.state === 'CREATED' ? { state: 'AUTHORIZED' } : {}),
    },
  });

  const { changed } = await markPaid(
    { orderId: payment.orderId, paymentId: razorpayPaymentId },
    req,
  );

  await writeAudit({
    req,
    action: changed ? 'payment.captured' : 'payment.captured_replay',
    entityType: 'Order',
    entityId: payment.orderId,
    after: { razorpayPaymentId, amount: payment.amount },
  });

  return { orderNumber: payment.order.orderNumber, orderId: payment.orderId };
};

/*
 * Webhook.
 *
 * Razorpay retries until it gets a 2xx, and it is explicitly allowed to deliver
 * the same event more than once. Events are recorded by id first, so a repeat
 * is recognised and skipped rather than reprocessed.
 *
 * Anything unexpected still returns 2xx: a non-2xx makes Razorpay retry, and
 * retrying an event we will never understand just fills the log.
 */
const handleWebhook = async ({ rawBody, signature }, req) => {
  if (!razorpay.verifyWebhookSignature(rawBody, signature)) {
    // The one case that must *not* be acknowledged — an unsigned request is not
    // from Razorpay, and pretending to accept it hides an attack.
    throw ApiError.unauthorized('Invalid webhook signature.');
  }

  const event = JSON.parse(rawBody.toString('utf8'));
  const eventId = req.get('x-razorpay-event-id') ?? event.id ?? `${event.event}-${Date.now()}`;

  const existing = await prisma.webhookEvent.findUnique({
    where: { provider_eventId: { provider: 'razorpay', eventId } },
  });

  if (existing?.processedAt) {
    return { received: true, duplicate: true };
  }

  const record = await prisma.webhookEvent.upsert({
    where: { provider_eventId: { provider: 'razorpay', eventId } },
    update: {},
    create: {
      provider: 'razorpay',
      eventId,
      eventType: event.event ?? 'unknown',
      payload: event,
    },
  });

  try {
    const entity = event.payload?.payment?.entity;

    switch (event.event) {
      case 'payment.captured':
      case 'order.paid': {
        const rzpOrderId = entity?.order_id ?? event.payload?.order?.entity?.id;
        const payment = rzpOrderId
          ? await prisma.payment.findUnique({ where: { razorpayOrderId: rzpOrderId } })
          : null;

        if (!payment) {
          logger.warn({ eventId, rzpOrderId }, 'webhook for an unknown payment');
          break;
        }

        /*
         * Amount is checked against what we recorded. A mismatch means either a
         * partial payment or something tampered with, and in both cases the
         * order must not be marked paid.
         */
        if (entity?.amount && entity.amount !== payment.amount) {
          logger.error(
            { eventId, expected: payment.amount, received: entity.amount },
            'webhook payment amount mismatch — not marking paid',
          );
          break;
        }

        await prisma.payment.update({
          where: { id: payment.id },
          data: { razorpayPaymentId: entity?.id ?? payment.razorpayPaymentId },
        });

        await markPaid({
          orderId: payment.orderId,
          paymentId: entity?.id,
          method: entity?.method,
          rawPayload: event,
        });
        break;
      }

      case 'payment.failed': {
        const payment = entity?.order_id
          ? await prisma.payment.findUnique({ where: { razorpayOrderId: entity.order_id } })
          : null;
        if (payment) {
          await markFailed({
            orderId: payment.orderId,
            paymentId: entity?.id,
            reason: entity?.error_description,
            rawPayload: event,
          });
        }
        break;
      }

      case 'refund.processed': {
        const refundEntity = event.payload?.refund?.entity;
        if (refundEntity?.payment_id) {
          await prisma.refund.updateMany({
            where: { razorpayRefundId: refundEntity.id },
            data: { state: 'PROCESSED', rawPayload: event },
          });
        }
        break;
      }

      default:
        logger.info({ event: event.event, eventId }, 'unhandled webhook event');
    }

    await prisma.webhookEvent.update({
      where: { id: record.id },
      data: { processedAt: new Date() },
    });

    return { received: true, handled: true };
  } catch (err) {
    // Recorded against the event so a failure is visible and replayable, rather
    // than vanishing into a 500 that Razorpay will retry blindly.
    await prisma.webhookEvent.update({
      where: { id: record.id },
      data: { error: String(err?.message ?? err).slice(0, 2000) },
    });
    logger.error({ err, eventId }, 'webhook processing failed');
    return { received: true, handled: false };
  }
};

module.exports = { verifyFromCheckout, handleWebhook, markPaid, markFailed };
