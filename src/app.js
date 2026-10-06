// The Express app, with no server attached.
//
// Kept separate from server.js so tests can import the app without binding a
// port, and so Passenger on cPanel can require either one.

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const pinoHttp = require('pino-http');

const env = require('./config/env');
const logger = require('./lib/logger');
const ApiError = require('./lib/ApiError');
const routes = require('./routes');
const storage = require('./lib/storage');
const { globalLimiter } = require('./middleware/rateLimit');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

const app = express();

// Behind LiteSpeed (cPanel), Render's proxy or Cloudflare, the client IP and
// protocol only come through if Express is told to trust the proxy. Rate
// limiting and audit logs are wrong without this.
if (env.TRUST_PROXY) app.set('trust proxy', 1);

app.disable('x-powered-by');

app.use(
  helmet({
    // The API serves JSON and file downloads, never HTML pages, so CSP here
    // would only constrain responses nothing renders.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
);

app.use(
  cors({
    origin(origin, callback) {
      // No Origin header: server-to-server, curl, health checks, Razorpay webhooks.
      if (!origin) return callback(null, true);
      if (env.corsOrigins.includes(origin)) return callback(null, true);
      return callback(ApiError.forbidden(`Origin ${origin} is not allowed.`));
    },
    credentials: true, // the refresh token is an httpOnly cookie
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    exposedHeaders: ['Content-Disposition'],
    maxAge: 86_400,
  }),
);

app.use(
  pinoHttp({
    logger,
    // Health checks every few seconds would otherwise bury the real traffic.
    autoLogging: { ignore: (req) => req.url.endsWith('/health') },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    // pino-http's defaults dump every request and response header, which buries
    // the line you were actually reading. Keep what identifies the request.
    serializers: {
      req: (req) => ({ method: req.method, url: req.url, ip: req.remoteAddress }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
    customSuccessMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
    customErrorMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
  }),
);

app.use(compression());

/*
 * Razorpay signs the raw request body. Any JSON parser that runs first will have
 * re-serialised it by the time the signature is checked, and verification will
 * fail for reasons that look like a key problem. So the webhook route is mounted
 * ahead of the JSON parser with a raw body parser of its own.
 *
 * The route itself arrives in step 4; the mount point is reserved here so it
 * cannot accidentally be added below the parser later.
 */
app.post(
  `${env.API_PREFIX}/payments/webhook`,
  express.raw({ type: 'application/json', limit: '1mb' }),
  (req, res, nextFn) => {
    const payments = require('./modules/payments/payments.service');
    payments
      .handleWebhook({ rawBody: req.body, signature: req.get('x-razorpay-signature') }, req)
      .then((result) => res.json(result))
      .catch(nextFn);
  },
);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());

/*
 * Uploaded public images.
 *
 * Only STORAGE public/ is exposed — private/ holds prescriptions and reports and
 * is never served statically, only through a signed route that checks
 * authorisation. The directory split is what makes that guarantee structural
 * rather than a matter of remembering.
 *
 * Filenames are random and content-addressed, so they can be cached hard.
 */
app.use(
  '/uploads',
  express.static(storage.PUBLIC_DIR, {
    maxAge: '1y',
    immutable: true,
    index: false,
    dotfiles: 'deny',
    setHeaders(res, filePath) {
      // An uploaded SVG is the one image type that can carry script. Served
      // under a CSP that allows none, and told not to sniff.
      if (filePath.endsWith('.svg')) {
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      }
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  }),
);

app.use(env.API_PREFIX, globalLimiter, routes);

// Anything outside the API prefix.
app.get('/', (_req, res) => {
  res.json({ name: 'Arova Labs API', docs: `${env.API_PREFIX}` });
});

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
