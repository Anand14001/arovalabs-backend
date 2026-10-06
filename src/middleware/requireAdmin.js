/*
 * The single auth gate.
 *
 * One role exists (SUPER_ADMIN), so this checks authentication and account
 * status and nothing else — there is no permission matrix by decision. If finer
 * roles are added later, the check belongs here rather than scattered per route.
 *
 * The user is re-read from the database on every request rather than trusted
 * from the JWT payload. A deactivated account must lose access immediately, not
 * when its 15-minute access token happens to expire.
 */

const ApiError = require('../lib/ApiError');
const prisma = require('../lib/prisma');
const { verifyAccessToken } = require('../lib/tokens');
const asyncHandler = require('../lib/asyncHandler');

const bearerFrom = (req) => {
  const header = req.get('authorization');
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!/^Bearer$/i.test(scheme) || !value) return null;
  return value.trim();
};

const requireAdmin = asyncHandler(async (req, _res, next) => {
  const token = bearerFrom(req);
  if (!token) throw ApiError.unauthorized('Sign in to continue.');

  const payload = verifyAccessToken(token);

  const user = await prisma.user.findUnique({
    where: { id: Number(payload.sub) },
    // Selected explicitly rather than taking the whole row, so passwordHash and
    // the reset-token fields cannot reach a response by accident. Must cover
    // everything auth.service.publicUser() reads, or /me quietly returns nulls.
    select: {
      id: true,
      email: true,
      name: true,
      phone: true,
      role: true,
      isActive: true,
      mustChangePassword: true,
      lastLoginAt: true,
    },
  });

  if (!user) throw ApiError.unauthorized('Account no longer exists.');
  if (!user.isActive) throw ApiError.forbidden('This account has been deactivated.');

  req.user = user;
  next();
});

/*
 * Guards the routes that cPanel cron calls, which carry no user session.
 *
 * Compared with a constant-time comparison so the token cannot be discovered a
 * byte at a time by timing the responses.
 */
const requireJobToken = (req, _res, next) => {
  const env = require('../config/env');
  const crypto = require('crypto');

  if (!env.INTERNAL_JOB_TOKEN) {
    return next(ApiError.forbidden('Internal jobs are not enabled.'));
  }

  const provided = bearerFrom(req) ?? '';
  const a = Buffer.from(provided);
  const b = Buffer.from(env.INTERNAL_JOB_TOKEN);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return next(ApiError.unauthorized('Invalid job token.'));
  }

  return next();
};

module.exports = { requireAdmin, requireJobToken };
