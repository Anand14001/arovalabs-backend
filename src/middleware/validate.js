// Request validation.
//
// `validate({ body, query, params })` parses each part with its Zod schema and
// replaces it with the parsed result, so handlers work with coerced, trimmed,
// known-shaped data and never re-check it.

const asyncHandler = require('../lib/asyncHandler');

const PARTS = ['body', 'query', 'params'];

const validate = (schemas) =>
  asyncHandler(async (req, _res, next) => {
    for (const part of PARTS) {
      const schema = schemas[part];
      if (!schema) continue;
      // Throws ZodError, which the error handler turns into a 422 with fields.
      const parsed = await schema.parseAsync(req[part]);
      // req.query/params are getters on some Express versions; assigning to a
      // fresh property is safer than mutating in place.
      Object.defineProperty(req, part, {
        value: parsed,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    next();
  });

module.exports = validate;
