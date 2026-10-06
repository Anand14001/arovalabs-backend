// Process entry point.
//
// On cPanel, Passenger requires this file and assigns the port via env, so the
// port is never hardcoded and there is no cluster/fork logic — Passenger manages
// processes itself.

const app = require('./app');
const env = require('./config/env');
const logger = require('./lib/logger');
const prisma = require('./lib/prisma');
const storage = require('./lib/storage');

// The storage directories must exist before the first upload, and on a fresh
// cPanel deploy nothing will have created them.
storage.ensureDirs().catch((err) => {
  logger.error({ err, root: storage.ROOT }, 'could not create storage directories');
});

const server = app.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, env: env.NODE_ENV, prefix: env.API_PREFIX, cors: env.corsOrigins },
    'Arova Labs API listening',
  );
});

// Shared hosting recycles processes routinely. Draining connections and closing
// the pool on the way out stops the remote database's connection count from
// creeping up with every restart.
let shuttingDown = false;

const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  const forceExit = setTimeout(() => {
    logger.error('graceful shutdown timed out — exiting');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  server.close(async () => {
    try {
      await prisma.$disconnect();
    } catch (err) {
      logger.error({ err }, 'error disconnecting prisma');
    }
    clearTimeout(forceExit);
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A crash should be loud and fatal, not a process left in an unknown state.
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  shutdown('unhandledRejection');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  shutdown('uncaughtException');
});

module.exports = server;
