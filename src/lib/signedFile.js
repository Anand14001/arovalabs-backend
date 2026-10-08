/*
 * Serving private files.
 *
 * Prescriptions and lab reports are patient data. They live outside any
 * document root, so nothing can reach them by URL guessing, and they are only
 * ever streamed by a handler that has already decided the caller is allowed.
 *
 * Two properties this file is responsible for:
 *
 *   1. **The response is never rendered.** A PDF or image is sent as an
 *      attachment with a CSP that permits nothing, so a crafted file cannot run
 *      script in the site's origin.
 *   2. **Links expire.** Report tokens carry an expiry, so a forwarded WhatsApp
 *      message stops working rather than exposing someone's results forever.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const storage = require('./storage');
const ApiError = require('./ApiError');

const newToken = () => crypto.randomBytes(24).toString('base64url');

/*
 * A filename safe to put in a Content-Disposition header.
 *
 * Quotes and newlines in a header value are a header-injection vector, and a
 * patient-supplied filename reaches here unmodified from an upload form.
 */
const safeFilename = (name, fallback = 'download') => {
  const cleaned = String(name ?? '')
    .replace(/[\r\n"\\]/g, '')
    .replace(/[^\w.\- ()]/g, '_')
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
};

/**
 * Stream a stored file to the client as a download.
 *
 * Authorisation is the caller's job — by the time this runs, the decision has
 * been made.
 */
const sendPrivateFile = async (res, upload, { filename } = {}) => {
  if (!upload?.storedPath) throw ApiError.notFound('That file is no longer available.');

  const absolute = storage.absolutePath(upload.storedPath);

  if (!(await storage.exists(upload.storedPath))) {
    // The row exists but the file does not — worth saying plainly rather than
    // streaming an empty response.
    throw ApiError.notFound('That file is missing from storage.');
  }

  const name = safeFilename(filename ?? upload.originalName, 'file');

  res.setHeader('Content-Type', upload.mimeType);
  res.setHeader('Content-Length', upload.sizeBytes);
  // `attachment`, always: an inline PDF or SVG is rendered by the browser, and
  // a rendered file is a file that can run things.
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Patient data should not sit in a shared cache or a proxy.
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Referrer-Policy', 'no-referrer');

  const stream = fs.createReadStream(absolute);
  stream.on('error', () => {
    if (!res.headersSent) res.status(500).end();
    else res.end();
  });
  stream.pipe(res);
};

module.exports = { newToken, safeFilename, sendPrivateFile };
