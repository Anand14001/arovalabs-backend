// Every environment variable the API reads, validated once at boot.
//
// Fail fast and loudly: a missing DATABASE_URL should stop the process here with
// a readable message, not surface as a connection error on the first request
// after deploy.

const path = require('path');
const dotenv = require('dotenv');
const { z } = require('zod');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const bool = (def) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1'));

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Passenger assigns the port on cPanel. Never hardcode one.
  PORT: z.coerce.number().int().positive().default(4100),
  API_PREFIX: z.string().default('/api/v1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  /*
   * The pooled connection is for the running app; the Prisma CLI needs a direct
   * session for migrations and studio. Optional here because the server itself
   * never reads it — but `prisma migrate` fails without it, so it is declared
   * rather than left as an undocumented surprise.
   */
  DIRECT_URL: z.string().optional(),

  PUBLIC_URL: z.string().url().default('http://localhost:5173'),
  ADMIN_URL: z.string().url().default('http://localhost:5174'),
  API_URL: z.string().url().default('http://localhost:4100'),
  CORS_ORIGINS: csv,

  // Auth — placeholders are rejected in production by the refinement below.
  JWT_ACCESS_SECRET: z.string().min(16).default('dev-access-secret-change-me'),
  JWT_REFRESH_SECRET: z.string().min(16).default('dev-refresh-secret-change-me'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_DOMAIN: z.string().optional(),

  // The first admin account, created by the seed. Changing these later does not
  // alter an existing account — the seed only creates one if none exists.
  ADMIN_EMAIL: z.string().email().default('admin@arovalabs.com'),
  // Development keeps a convenience fallback; production requires an
  // explicitly configured, unique bootstrap secret below.
  ADMIN_PASSWORD: z.string().min(8).optional(),
  ADMIN_NAME: z.string().default('Arova Admin'),

  // Razorpay
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  // Storage — local disk on cPanel, S3-compatible elsewhere.
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_ROOT: z.string().default(path.resolve(__dirname, '../../storage')),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(10),

  // Mail
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_SECURE: bool(false),
  MAIL_FROM: z.string().default('Arova Labs <no-reply@arovalabs.com>'),

  // Scheduled work. `inline` uses node-cron (dev/Render); `external` expects
  // cPanel cron to call the internal job route, because Passenger stops an idle
  // app and an in-process timer would never fire.
  JOB_RUNNER: z.enum(['inline', 'external', 'off']).default('inline'),
  INTERNAL_JOB_TOKEN: z.string().optional(),

  // Behind LiteSpeed/Cloudflare the real client IP is in X-Forwarded-For.
  TRUST_PROXY: bool(false),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${issues}\n`);
  process.exit(1);
}

const env = parsed.data;

const isProduction = env.NODE_ENV === 'production';

// Defaults that are fine locally are not fine in production.
if (isProduction) {
  const problems = [];
  const bootstrapPassword = env.ADMIN_PASSWORD;
  const knownBootstrapPasswords = new Set([
    'admin@123',
    'change-me-before-production',
  ]);
  if (!bootstrapPassword) {
    problems.push('ADMIN_PASSWORD (required; configure a unique secret of at least 16 characters)');
  } else {
    if (bootstrapPassword.length < 16) {
      problems.push('ADMIN_PASSWORD (must be at least 16 characters)');
    }
    if (knownBootstrapPasswords.has(bootstrapPassword.toLowerCase())) {
      problems.push('ADMIN_PASSWORD (known development placeholder is not allowed)');
    }
  }
  if (env.JWT_ACCESS_SECRET.includes('change-me')) problems.push('JWT_ACCESS_SECRET');
  if (env.JWT_REFRESH_SECRET.includes('change-me')) problems.push('JWT_REFRESH_SECRET');
  if (env.CORS_ORIGINS.length === 0) problems.push('CORS_ORIGINS');
  if (env.JOB_RUNNER === 'external' && !env.INTERNAL_JOB_TOKEN) {
    problems.push('INTERNAL_JOB_TOKEN (required when JOB_RUNNER=external)');
  }
  if (problems.length) {
    // eslint-disable-next-line no-console
    console.error(
      `Refusing to start in production with unsafe configuration:\n${problems
        .map((p) => `  - ${p}`)
        .join('\n')}\n`,
    );
    process.exit(1);
  }
}

// Retain the documented local convenience for fresh development/test setups.
if (!isProduction && !env.ADMIN_PASSWORD) env.ADMIN_PASSWORD = 'Admin@123';

// In development the Vite dev servers are always allowed, so a fresh clone
// works without anyone editing CORS_ORIGINS first.
const corsOrigins = env.CORS_ORIGINS.length
  ? env.CORS_ORIGINS
  : isProduction
    ? []
    : [env.PUBLIC_URL, env.ADMIN_URL, 'http://localhost:5173', 'http://localhost:5174'];

module.exports = {
  ...env,
  corsOrigins: [...new Set(corsOrigins)],
  isProduction,
  isDevelopment: env.NODE_ENV === 'development',
  isTest: env.NODE_ENV === 'test',
};
