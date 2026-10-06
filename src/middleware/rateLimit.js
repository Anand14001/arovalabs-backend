// Rate limiters.
//
// Kept in one place so the limits are visible together rather than scattered
// across route files. Counting is per-IP, which depends on `trust proxy` being
// set correctly behind LiteSpeed/Cloudflare — otherwise every request looks like
// it comes from the proxy and one visitor can lock out everyone.

const rateLimit = require('express-rate-limit');
const ApiError = require('../lib/ApiError');
const env = require('../config/env');

const handler = (_req, _res, next) => next(ApiError.tooMany());

const base = {
  standardHeaders: true,
  legacyHeaders: false,
  handler,
  // Local development would otherwise trip limits while clicking around.
  skip: () => env.isDevelopment,
};

// Everything under the API, as a blunt backstop.
const globalLimiter = rateLimit({ ...base, windowMs: 60_000, limit: 300 });

// Credential endpoints: slow enough to make guessing pointless.
const authLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60_000,
  limit: 10,
  skipSuccessfulRequests: true,
});

// Public forms — contact, newsletter, callback, prescription upload.
const formLimiter = rateLimit({ ...base, windowMs: 60 * 60_000, limit: 15 });

// Order placement and payment verification.
const checkoutLimiter = rateLimit({ ...base, windowMs: 10 * 60_000, limit: 30 });

module.exports = { globalLimiter, authLimiter, formLimiter, checkoutLimiter };
