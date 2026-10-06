/*
 * Authentication.
 *
 * Two rules shape most of what follows:
 *
 * 1. Login failures never say which half was wrong. "No such account" and
 *    "wrong password" are the same response, and both take roughly the same
 *    time, so the endpoint cannot be used to enumerate staff email addresses.
 * 2. Lockout is per-account and temporary. Five failures buys a 15-minute
 *    cooldown, which stops online guessing without giving anyone a way to lock
 *    a colleague out indefinitely.
 */

const crypto = require('crypto');
const prisma = require('../../lib/prisma');
const ApiError = require('../../lib/ApiError');
const env = require('../../config/env');
const logger = require('../../lib/logger');
const { hashPassword, verifyPassword, wasteTime } = require('../../lib/password');
const { writeAudit } = require('../../lib/audit');
const { sendMail } = require('../../lib/mailer');
const tokens = require('../../lib/tokens');

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const RESET_TOKEN_TTL_MINUTES = 60;

// What the admin client is allowed to know about the signed-in user.
const publicUser = (user) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  phone: user.phone ?? null,
  role: user.role,
  mustChangePassword: user.mustChangePassword,
  lastLoginAt: user.lastLoginAt ?? null,
});

const GENERIC_LOGIN_FAILURE = 'That email and password do not match.';

const login = async ({ email, password }, req) => {
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    // Spend the same time as a real bcrypt comparison would.
    await wasteTime();
    throw ApiError.unauthorized(GENERIC_LOGIN_FAILURE);
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const minutes = Math.ceil((user.lockedUntil - Date.now()) / 60000);
    throw new ApiError(
      423,
      'ACCOUNT_LOCKED',
      `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    );
  }

  const ok = await verifyPassword(password, user.passwordHash);

  if (!ok) {
    const failedLoginCount = user.failedLoginCount + 1;
    const lock = failedLoginCount >= MAX_FAILED_ATTEMPTS;

    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount,
        // Reset the counter alongside the lock, so the next window starts clean.
        ...(lock
          ? {
              lockedUntil: new Date(Date.now() + LOCKOUT_MINUTES * 60_000),
              failedLoginCount: 0,
            }
          : {}),
      },
    });

    await writeAudit({
      req,
      actorId: user.id,
      action: lock ? 'auth.locked_out' : 'auth.login_failed',
      entityType: 'User',
      entityId: user.id,
      after: { failedLoginCount, locked: lock },
    });

    throw ApiError.unauthorized(GENERIC_LOGIN_FAILURE);
  }

  // A deactivated account gets a straight answer — it is not a secret, and the
  // password was correct, so there is nothing left to enumerate.
  if (!user.isActive) {
    throw ApiError.forbidden('This account has been deactivated.');
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  });

  const refreshToken = await tokens.issueRefreshToken(user.id, { req });

  await writeAudit({
    req,
    actorId: user.id,
    action: 'auth.login',
    entityType: 'User',
    entityId: user.id,
  });

  return {
    user: publicUser(updated),
    accessToken: tokens.signAccessToken(updated),
    refreshToken,
  };
};

const refresh = async (refreshToken, req) => {
  const { user, refreshToken: next } = await tokens.rotateRefreshToken(refreshToken, req);
  return {
    user: publicUser(user),
    accessToken: tokens.signAccessToken(user),
    refreshToken: next,
  };
};

const logout = async (refreshToken, req) => {
  await tokens.revokeToken(refreshToken);
  if (req.user) {
    await writeAudit({
      req,
      action: 'auth.logout',
      entityType: 'User',
      entityId: req.user.id,
    });
  }
};

const changePassword = async (userId, { currentPassword, newPassword }, req) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw ApiError.notFound('Account not found.');

  const ok = await verifyPassword(currentPassword, user.passwordHash);
  if (!ok) {
    throw ApiError.unprocessable('Validation failed.', {
      currentPassword: 'That is not your current password.',
    });
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash: await hashPassword(newPassword),
      mustChangePassword: false,
      passwordResetTokenHash: null,
      passwordResetExpiresAt: null,
    },
  });

  /*
   * Every other session is signed out. A password change is often a response to
   * "I think someone has my login", and leaving existing refresh tokens alive
   * would defeat the point. The current session keeps working because the
   * caller is issued a fresh token below.
   */
  await tokens.revokeAllForUser(userId);
  const refreshToken = await tokens.issueRefreshToken(userId, { req });

  await writeAudit({
    req,
    action: 'auth.password_changed',
    entityType: 'User',
    entityId: userId,
  });

  return { accessToken: tokens.signAccessToken(user), refreshToken };
};

/*
 * Always reports success, whether or not the address exists — otherwise this
 * endpoint becomes the account-enumeration oracle that login refuses to be.
 */
const forgotPassword = async ({ email }, req) => {
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user || !user.isActive) {
    logger.info({ email }, 'password reset requested for unknown or inactive account');
    return;
  }

  const token = crypto.randomBytes(32).toString('base64url');

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordResetTokenHash: tokens.hashToken(token),
      passwordResetExpiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60_000),
    },
  });

  const url = `${env.ADMIN_URL}/reset-password?token=${token}`;

  await sendMail({
    to: user.email,
    subject: 'Reset your Arova Labs admin password',
    text: [
      `Hello ${user.name},`,
      '',
      'Use the link below to set a new password. It expires in one hour.',
      '',
      url,
      '',
      'If you did not ask for this, you can ignore this email — your password has not changed.',
    ].join('\n'),
  });

  await writeAudit({
    req,
    actorId: user.id,
    action: 'auth.password_reset_requested',
    entityType: 'User',
    entityId: user.id,
  });
};

const resetPassword = async ({ token, password }, req) => {
  const user = await prisma.user.findFirst({
    where: {
      passwordResetTokenHash: tokens.hashToken(token),
      passwordResetExpiresAt: { gt: new Date() },
    },
  });

  if (!user) {
    throw ApiError.badRequest('That reset link is invalid or has expired.');
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(password),
      passwordResetTokenHash: null,
      passwordResetExpiresAt: null,
      mustChangePassword: false,
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });

  // Whoever used the old password loses their sessions too.
  await tokens.revokeAllForUser(user.id);

  await writeAudit({
    req,
    actorId: user.id,
    action: 'auth.password_reset',
    entityType: 'User',
    entityId: user.id,
  });
};

module.exports = {
  login,
  refresh,
  logout,
  changePassword,
  forgotPassword,
  resetPassword,
  publicUser,
};
