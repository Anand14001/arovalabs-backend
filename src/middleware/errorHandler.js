// Terminal error handling.
//
// Every failure leaves here in one shape — { error: { code, message, fields } } —
// so the website and the admin can both handle errors generically. Stack traces
// and database details never reach the client in production.

const { Prisma } = require('@prisma/client');
const { ZodError } = require('zod');
const ApiError = require('../lib/ApiError');
const env = require('../config/env');
const logger = require('../lib/logger');

// Zod's issue list flattened into { field: message } for form display.
const fieldsFromZod = (error) => {
  const fields = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    if (!fields[key]) fields[key] = issue.message;
  }
  return fields;
};

const translate = (err) => {
  if (err instanceof ApiError) return err;

  if (err instanceof ZodError) {
    return ApiError.unprocessable('Validation failed.', fieldsFromZod(err));
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case 'P2002': {
        // Unique constraint. `target` names the offending column(s).
        const target = err.meta?.target;
        const names = Array.isArray(target) ? target : target ? [String(target)] : [];
        const fields = Object.fromEntries(names.map((n) => [n, 'Already taken.']));
        return ApiError.conflict('That value is already in use.', Object.keys(fields).length ? fields : undefined);
      }
      case 'P2003':
        return ApiError.badRequest('That references something that does not exist.');
      case 'P2025':
        return ApiError.notFound('Not found.');
      default:
        return ApiError.internal('Database request failed.', err);
    }
  }

  if (err instanceof Prisma.PrismaClientValidationError) {
    return ApiError.internal('Malformed database query.', err);
  }

  if (err instanceof Prisma.PrismaClientInitializationError) {
    return ApiError.internal('Database unavailable.', err);
  }

  // body-parser's own errors
  if (err.type === 'entity.too.large') {
    return new ApiError(413, 'PAYLOAD_TOO_LARGE', 'That request body is too large.');
  }
  if (err.type === 'entity.parse.failed') {
    return ApiError.badRequest('Request body is not valid JSON.');
  }

  return ApiError.internal(undefined, err);
};

// eslint-disable-next-line no-unused-vars -- Express needs the 4-arg signature
const errorHandler = (err, req, res, next) => {
  const apiError = translate(err);
  const isServerError = apiError.status >= 500;

  const log = req.log ?? logger;
  const payload = {
    status: apiError.status,
    code: apiError.code,
    method: req.method,
    url: req.originalUrl,
  };

  if (isServerError) {
    log.error({ ...payload, err: apiError.cause ?? err }, apiError.message);
  } else {
    log.warn(payload, apiError.message);
  }

  const body = {
    error: {
      code: apiError.code,
      // A real 500 message could name a table or a column, so it is replaced.
      message: isServerError && env.isProduction ? 'Something went wrong.' : apiError.message,
    },
  };

  if (apiError.fields) body.error.fields = apiError.fields;
  if (isServerError && !env.isProduction) {
    body.error.detail = (apiError.cause ?? err)?.message;
    body.error.stack = (apiError.cause ?? err)?.stack?.split('\n').slice(0, 6);
  }

  res.status(apiError.status).json(body);
};

const notFoundHandler = (req, _res, next) => {
  next(ApiError.notFound(`No route for ${req.method} ${req.originalUrl}`));
};

module.exports = { errorHandler, notFoundHandler };
