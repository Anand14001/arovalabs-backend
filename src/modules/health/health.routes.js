// Liveness and readiness.
//
// /health answers without touching the database, so a monitor can tell "process
// up" from "process up but database unreachable". With a remote database those
// are genuinely separate failures: the most likely production problem is cPanel
// firewalling outbound 5432, which leaves the app healthy but unable to serve.

const { Router } = require('express');
const asyncHandler = require('../../lib/asyncHandler');
const prisma = require('../../lib/prisma');
const env = require('../../config/env');

const router = Router();

const startedAt = Date.now();

router.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    env: env.NODE_ENV,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  });
});

router.get(
  '/ready',
  asyncHandler(async (_req, res) => {
    const startedQueryAt = Date.now();
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      return res.status(503).json({
        status: 'unavailable',
        database: 'down',
        reason: env.isProduction ? undefined : err.message,
      });
    }
    return res.json({
      status: 'ok',
      database: 'up',
      databaseLatencyMs: Date.now() - startedQueryAt,
    });
  }),
);

module.exports = router;
