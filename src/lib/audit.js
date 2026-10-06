/*
 * Audit log writer.
 *
 * Deliberately never throws: an audit write failing must not fail the operation
 * the user asked for. A failure is logged loudly instead, so it is visible
 * without being destructive.
 *
 * `before`/`after` are passed through `redact()` because audit rows are shown in
 * the admin UI and must never carry password hashes or tokens.
 */

const prisma = require('./prisma');
const logger = require('./logger');

const SENSITIVE_KEYS = new Set([
  'password',
  'passwordHash',
  'currentPassword',
  'newPassword',
  'tokenHash',
  'accessToken',
  'refreshToken',
  'passwordResetTokenHash',
  'razorpaySignature',
  'unsubscribeToken',
  'accessTokenValue',
]);

const redact = (value) => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEYS.has(k) ? '[redacted]' : redact(v);
  }
  return out;
};

/*
 * `action` reads as a dotted verb phrase — "auth.login", "order.status_changed",
 * "product.updated" — so the admin can group and filter on a prefix.
 */
const writeAudit = async ({ req, actorId, action, entityType, entityId, before, after }) => {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: actorId ?? req?.user?.id ?? null,
        action,
        entityType,
        entityId: entityId === undefined || entityId === null ? null : String(entityId),
        before: before === undefined ? undefined : redact(before),
        after: after === undefined ? undefined : redact(after),
        ipAddress: req?.ip?.slice(0, 64),
        userAgent: req?.get?.('user-agent')?.slice(0, 255),
      },
    });
  } catch (err) {
    (req?.log ?? logger).error({ err, action, entityType, entityId }, 'audit write failed');
  }
};

module.exports = { writeAudit, redact };
