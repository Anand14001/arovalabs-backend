/*
 * Settings access.
 *
 * Settings are read on nearly every commerce request — tax rate, collection fee,
 * order prefix — so they are cached in memory for a short window rather than
 * costing a round trip to a remote database each time. The TTL is short enough
 * that an admin's change appears within a minute without anyone restarting
 * anything, and `invalidate()` makes it immediate when the change came through
 * our own API.
 */

const prisma = require('./prisma');
const logger = require('./logger');

const TTL_MS = 60_000;

let cache = null;
let cachedAt = 0;

const coerce = (row) => {
  if (row.value === null || row.value === undefined) return null;
  switch (row.type) {
    case 'NUMBER': {
      const n = Number(row.value);
      return Number.isFinite(n) ? n : null;
    }
    case 'BOOLEAN':
      return row.value === 'true' || row.value === '1';
    case 'JSON':
      try {
        return JSON.parse(row.value);
      } catch {
        // A malformed JSON setting should not take down whatever is reading it.
        logger.error({ key: row.key }, 'setting is not valid JSON');
        return null;
      }
    default:
      return row.value;
  }
};

const load = async () => {
  const rows = await prisma.setting.findMany();
  const map = {};
  for (const row of rows) map[row.key] = coerce(row);
  cache = map;
  cachedAt = Date.now();
  return map;
};

const all = async () => {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;
  return load();
};

const get = async (key, fallback = null) => {
  const map = await all();
  return map[key] ?? fallback;
};

/** Only the keys explicitly marked public ever reach the website. */
const publicSettings = async () => {
  const rows = await prisma.setting.findMany({
    where: { isPublic: true, isSecret: false },
  });
  const map = {};
  for (const row of rows) map[row.key] = coerce(row);
  return map;
};

const invalidate = () => {
  cache = null;
  cachedAt = 0;
};

/*
 * The commerce numbers, resolved together.
 *
 * Grouped because every total calculation needs all of them, and reading them
 * one at a time would be four cache lookups and a lot of repeated defaults.
 */
const commerce = async () => {
  const map = await all();
  return {
    currency: map['commerce.currency'] ?? 'INR',
    taxPercent: map['commerce.taxPercent'] ?? 0,
    collectionFeePaise: map['commerce.collectionFeePaise'] ?? 0,
    freeCollectionThresholdPaise: map['commerce.freeCollectionThresholdPaise'] ?? 0,
    minOrderValuePaise: map['commerce.minOrderValuePaise'] ?? 0,
    orderNumberPrefix: map['commerce.orderNumberPrefix'] ?? 'ARV',
  };
};

/*
 * Collection timing.
 *
 * These describe what a customer may *request*. Capacity-based availability is
 * deferred (see SPEC.md), so nothing here is checked against a schedule.
 */
const collection = async () => {
  const map = await all();
  return {
    windows: map['collection.windows'] ?? [],
    minNoticeHours: map['collection.minNoticeHours'] ?? 4,
    maxDaysAhead: map['collection.maxDaysAhead'] ?? 14,
  };
};

module.exports = { all, get, publicSettings, invalidate, commerce, collection };
