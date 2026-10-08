/*
 * Content revisions.
 *
 * Every save of a post, page or section is snapshotted first. This is the
 * safety net that makes handing the CMS to a non-technical editor reasonable:
 * the worst outcome of a mistake is "restore the version from before lunch",
 * not a phone call to a developer.
 *
 * Snapshots are stored whole rather than as diffs. They are small, a diff needs
 * the whole history to reconstruct anything, and restoring has to be reliable
 * at exactly the moment someone is panicking.
 */

const prisma = require('./prisma');
const logger = require('./logger');

// Enough to undo a bad day without the table growing forever.
const KEEP_PER_ENTITY = 30;

/**
 * Snapshot the current state before a change.
 *
 * Never throws: failing to record history must not block the edit someone is
 * trying to make.
 */
const snapshot = async ({ entityType, entityId, data, note, actorId }) => {
  try {
    await prisma.contentRevision.create({
      data: {
        entityType,
        entityId,
        snapshot: data,
        note: note ?? null,
        actorId: actorId ?? null,
      },
    });

    /*
     * Trim old revisions. Done after the write rather than on a schedule so the
     * table stays bounded without needing a job — and a failure here is
     * logged, not surfaced.
     */
    const old = await prisma.contentRevision.findMany({
      where: { entityType, entityId },
      orderBy: { createdAt: 'desc' },
      skip: KEEP_PER_ENTITY,
      select: { id: true },
    });

    if (old.length) {
      await prisma.contentRevision.deleteMany({
        where: { id: { in: old.map((r) => r.id) } },
      });
    }
  } catch (err) {
    logger.error({ err, entityType, entityId }, 'could not record a revision');
  }
};

const list = async (entityType, entityId) => {
  const rows = await prisma.contentRevision.findMany({
    where: { entityType, entityId },
    orderBy: { createdAt: 'desc' },
    include: { actor: { select: { name: true } } },
    take: KEEP_PER_ENTITY,
  });

  return rows.map((r) => ({
    id: r.id,
    note: r.note,
    actor: r.actor?.name ?? 'System',
    createdAt: r.createdAt,
    // A short description of what the version held, so the list is scannable
    // without opening each one.
    summary: summarise(r.snapshot),
  }));
};

const summarise = (snap) => {
  if (!snap || typeof snap !== 'object') return null;
  if (snap.title) return snap.title;
  if (snap.label) return snap.label;
  if (snap.type) return snap.type;
  return null;
};

const get = async (id) => {
  const row = await prisma.contentRevision.findUnique({ where: { id } });
  return row?.snapshot ?? null;
};

module.exports = { snapshot, list, get, KEEP_PER_ENTITY };
