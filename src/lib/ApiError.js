// One error type for everything the API intentionally rejects.
//
// Anything thrown that is not an ApiError is treated as a bug by the error
// handler: logged with a stack, reported to the client as a generic 500.

class ApiError extends Error {
  constructor(status, code, message, { fields, cause } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.expected = true;
    if (cause) this.cause = cause;
    Error.captureStackTrace?.(this, ApiError);
  }

  static badRequest(message = 'Invalid request.', fields) {
    return new ApiError(400, 'BAD_REQUEST', message, { fields });
  }

  static unauthorized(message = 'Authentication required.') {
    return new ApiError(401, 'UNAUTHORIZED', message);
  }

  static forbidden(message = 'You do not have access to this resource.') {
    return new ApiError(403, 'FORBIDDEN', message);
  }

  static notFound(message = 'Not found.') {
    return new ApiError(404, 'NOT_FOUND', message);
  }

  static conflict(message = 'That conflicts with something that already exists.', fields) {
    return new ApiError(409, 'CONFLICT', message, { fields });
  }

  static unprocessable(message = 'Validation failed.', fields) {
    return new ApiError(422, 'VALIDATION_FAILED', message, { fields });
  }

  static tooMany(message = 'Too many requests. Please slow down.') {
    return new ApiError(429, 'RATE_LIMITED', message);
  }

  static internal(message = 'Something went wrong.', cause) {
    return new ApiError(500, 'INTERNAL_ERROR', message, { cause });
  }
}

module.exports = ApiError;
