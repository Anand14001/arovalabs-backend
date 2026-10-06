/*
 * Transactional email.
 *
 * With no SMTP configured, mail is written to the log instead of being silently
 * dropped. That keeps the password-reset flow usable in development — the reset
 * link appears in the terminal — and makes a misconfigured production host
 * obvious rather than mysterious.
 */

const nodemailer = require('nodemailer');
const env = require('../config/env');
const logger = require('./logger');

const isConfigured = Boolean(env.SMTP_HOST && env.SMTP_PORT);

let transport = null;

const getTransport = () => {
  if (!isConfigured) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    });
  }
  return transport;
};

/*
 * Never throws. A failed notification must not roll back the thing it was
 * notifying about — an order that is paid for stays paid for even if its
 * confirmation email bounces.
 */
const sendMail = async ({ to, subject, text, html }) => {
  const tx = getTransport();

  if (!tx) {
    logger.warn(
      { to, subject, text },
      'SMTP not configured — email logged instead of sent',
    );
    return { sent: false, reason: 'smtp_not_configured' };
  }

  try {
    const info = await tx.sendMail({ from: env.MAIL_FROM, to, subject, text, html });
    logger.info({ to, subject, messageId: info.messageId }, 'email sent');
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    logger.error({ err, to, subject }, 'email send failed');
    return { sent: false, reason: err.message };
  }
};

const verifyTransport = async () => {
  const tx = getTransport();
  if (!tx) return { ok: false, reason: 'smtp_not_configured' };
  try {
    await tx.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
};

module.exports = { sendMail, verifyTransport, isConfigured };
