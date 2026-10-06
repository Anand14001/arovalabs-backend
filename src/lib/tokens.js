/*
 * Access and refresh tokens.
 *
 * Access token: a short-lived JWT the admin holds in memory only. Never in
 * localStorage — anything that reads the DOM can read localStorage, so an XSS
 * in the admin would hand over a usable credential.
 *
 * Refresh token: a long random string, sent as an httpOnly cookie and stored
 * only as a SHA-256 hash. A database leak therefore yields no usable tokens.
 *
 * Refresh tokens rotate on every use and are grouped into a "family". Presenting
 * an already-used token means either a replay or a stolen cookie, and in both
 * cases the whole family is revoked: the real user gets logged out, which is the
 * correct outcome, because the alternative is leaving the thief with access.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const prisma = require('./prisma');
const ApiError = require('./ApiError');

const ACCESS_AUDIENCE = 'arova-admin';
const ISSUER = 'arova-api';

const signAccessToken = (user) =>
  jwt.sign(
    { sub: String(user.id), email: user.email, role: user.role, name: user.name },
    env.JWT_ACCESS_SECRET,
    { expiresIn: env.ACCESS_TOKEN_TTL, audience: ACCESS_AUDIENCE, issuer: ISSUER },
  );

const verifyAccessToken = (token) => {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET, {
      audience: ACCESS_AUDIENCE,
      issuer: ISSUER,
    });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      // A distinct code so the admin client knows to refresh rather than to
      // bounce the user to the login screen.
      throw new ApiError(401, 'TOKEN_EXPIRED', 'Access token expired.');
    }
    throw ApiError.unauthorized('Invalid access token.');
  }
};

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const refreshExpiry = () =>
  new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

// Returns the plaintext token; only its hash is persisted.
const issueRefreshToken = async (userId, { familyId, req } = {}) => {
  const token = crypto.randomBytes(48).toString('base64url');

  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      familyId: familyId ?? crypto.randomBytes(16).toString('hex'),
      expiresAt: refreshExpiry(),
      userAgent: req?.get('user-agent')?.slice(0, 255),
      ipAddress: req?.ip?.slice(0, 64),
    },
  });

  return token;
};

const revokeFamily = (familyId) =>
  prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

/*
 * Exchange a refresh token for a new pair.
 *
 * Returns { user, refreshToken }. Throws if the token is unknown, expired, or
 * already used — the last of which also kills the family.
 */
const rotateRefreshToken = async (token, req) => {
  if (!token) throw ApiError.unauthorized('No refresh token.');

  const existing = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });

  if (!existing) throw ApiError.unauthorized('Invalid refresh token.');

  if (existing.revokedAt) {
    // Reuse detection. Someone has a copy of a token we already retired.
    await revokeFamily(existing.familyId);
    throw ApiError.unauthorized('Refresh token already used. Please sign in again.');
  }

  if (existing.expiresAt < new Date()) {
    throw ApiError.unauthorized('Refresh token expired.');
  }

  if (!existing.user.isActive) {
    await revokeFamily(existing.familyId);
    throw ApiError.forbidden('This account has been deactivated.');
  }

  await prisma.refreshToken.update({
    where: { id: existing.id },
    data: { revokedAt: new Date() },
  });

  const refreshToken = await issueRefreshToken(existing.userId, {
    familyId: existing.familyId,
    req,
  });

  return { user: existing.user, refreshToken };
};

const revokeToken = async (token) => {
  if (!token) return;
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
};

const revokeAllForUser = (userId) =>
  prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

const REFRESH_COOKIE = 'arova_refresh';

/*
 * The admin is served from a different subdomain than the API, so the cookie
 * has to be SameSite=None — and browsers only accept that with Secure, which
 * means HTTPS. In development everything is localhost (same site), so Lax works
 * and no certificate is needed.
 */
const refreshCookieOptions = () => ({
  httpOnly: true,
  secure: env.isProduction,
  sameSite: env.isProduction ? 'none' : 'lax',
  domain: env.isProduction ? env.COOKIE_DOMAIN : undefined,
  path: `${env.API_PREFIX}/admin/auth`,
  maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
});

const setRefreshCookie = (res, token) =>
  res.cookie(REFRESH_COOKIE, token, refreshCookieOptions());

const clearRefreshCookie = (res) =>
  res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions(), maxAge: undefined });

module.exports = {
  signAccessToken,
  verifyAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeToken,
  revokeFamily,
  revokeAllForUser,
  hashToken,
  REFRESH_COOKIE,
  setRefreshCookie,
  clearRefreshCookie,
};
