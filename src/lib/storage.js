/*
 * File storage.
 *
 * Two visibility classes, kept in separate directories:
 *
 *   public/   product and content images. Served directly by Express with a long
 *             cache. Nothing here is sensitive.
 *   private/  prescriptions and lab reports. Patient data. Never served
 *             statically — only through a signed, expiring download route.
 *
 * The split is a directory rather than a flag so a mistake in a query cannot
 * expose a report: the static middleware is only ever pointed at public/.
 *
 * Paths stored in the database are relative to the root, so moving the root or
 * switching to S3 later does not require rewriting rows.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const env = require('../config/env');

const ROOT = path.resolve(env.STORAGE_LOCAL_ROOT);
const PUBLIC_DIR = path.join(ROOT, 'public');
const PRIVATE_DIR = path.join(ROOT, 'private');

const PUBLIC_KINDS = new Set(['PRODUCT_IMAGE', 'CONTENT_IMAGE']);

const isPublicKind = (kind) => PUBLIC_KINDS.has(kind);

const ensureDirs = async () => {
  await fs.mkdir(PUBLIC_DIR, { recursive: true });
  await fs.mkdir(PRIVATE_DIR, { recursive: true });
};

/*
 * A stored name is derived, never taken from the client.
 *
 * An uploaded filename can contain path separators, null bytes, or a name that
 * collides with an existing file. Only the extension is kept, and only after
 * being checked against a short allowlist.
 */
const SAFE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg', '.avif', '.pdf',
]);

const safeExtension = (originalName, mimeType) => {
  const ext = path.extname(originalName ?? '').toLowerCase();
  if (SAFE_EXTENSIONS.has(ext)) return ext;
  // Fall back to the detected type rather than trusting an odd extension.
  const fromMime = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'image/avif': '.avif',
    'application/pdf': '.pdf',
  }[mimeType];
  return fromMime ?? '.bin';
};

const buildStoredPath = (kind, originalName, mimeType) => {
  const now = new Date();
  // Year/month folders keep any single directory from growing unbounded, which
  // matters on shared hosting where directory listings get slow.
  const folder = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
  const name = `${crypto.randomBytes(16).toString('hex')}${safeExtension(originalName, mimeType)}`;
  return `${isPublicKind(kind) ? 'public' : 'private'}/${folder}/${name}`;
};

const absolutePath = (storedPath) => {
  const resolved = path.resolve(ROOT, storedPath);
  // Defence against a traversal sequence reaching the row somehow.
  if (!resolved.startsWith(ROOT)) {
    throw new Error(`Refusing to touch a path outside the storage root: ${storedPath}`);
  }
  return resolved;
};

const save = async (buffer, { kind, originalName, mimeType }) => {
  const storedPath = buildStoredPath(kind, originalName, mimeType);
  const target = absolutePath(storedPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, buffer);
  return {
    storedPath,
    sizeBytes: buffer.length,
    checksum: crypto.createHash('sha256').update(buffer).digest('hex'),
  };
};

const read = (storedPath) => fs.readFile(absolutePath(storedPath));

// Deleting a file that is already gone is success, not failure — the intent was
// for it not to exist.
const remove = async (storedPath) => {
  try {
    await fs.unlink(absolutePath(storedPath));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
};

const exists = async (storedPath) => {
  try {
    await fs.access(absolutePath(storedPath));
    return true;
  } catch {
    return false;
  }
};

/*
 * The URL the website and admin should use.
 *
 * Public files get a stable static path. Private files deliberately return null:
 * their delivery goes through a signed route that checks authorisation, and
 * handing out a guessable URL here would quietly bypass it.
 */
const publicUrl = (upload) => {
  if (!upload?.storedPath) return null;
  if (!upload.storedPath.startsWith('public/')) return null;
  return `${env.API_URL}/uploads/${upload.storedPath.slice('public/'.length)}`;
};

module.exports = {
  ROOT,
  PUBLIC_DIR,
  PRIVATE_DIR,
  ensureDirs,
  isPublicKind,
  save,
  read,
  remove,
  exists,
  absolutePath,
  publicUrl,
};
