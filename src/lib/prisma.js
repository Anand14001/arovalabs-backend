// A single Prisma client for the process.
//
// Cached on globalThis so nodemon's reloads don't open a new connection pool
// each time. The database is remote and pooled, so leaked pools burn connections
// against a shared limit and each new pool pays TLS setup again.

const { PrismaClient } = require('@prisma/client');
const env = require('../config/env');
const logger = require('./logger');

const createClient = () => {
  const client = new PrismaClient({
    log: env.isDevelopment
      ? [
          { emit: 'event', level: 'query' },
          { emit: 'event', level: 'warn' },
          { emit: 'event', level: 'error' },
        ]
      : [
          { emit: 'event', level: 'warn' },
          { emit: 'event', level: 'error' },
        ],
  });

  if (env.isDevelopment) {
    client.$on('query', (e) => {
      // Only the slow ones — logging every query drowns out everything else.
      if (e.duration >= 200) {
        logger.warn({ durationMs: e.duration, query: e.query }, 'slow query');
      }
    });
  }

  client.$on('warn', (e) => logger.warn({ prisma: e }, 'prisma warning'));
  client.$on('error', (e) => logger.error({ prisma: e }, 'prisma error'));

  return client;
};

const globalForPrisma = globalThis;
const prisma = globalForPrisma.__arovaPrisma ?? createClient();

if (!env.isProduction) globalForPrisma.__arovaPrisma = prisma;

module.exports = prisma;
