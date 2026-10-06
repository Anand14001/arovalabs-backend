// Express 4 does not forward a rejected promise to the error handler, so every
// async route is wrapped. Without this, a failed await becomes a hung request.

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = asyncHandler;
