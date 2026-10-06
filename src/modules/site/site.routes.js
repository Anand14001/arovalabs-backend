/*
 * Public site data: settings the website is allowed to read, the collection
 * centres, and the booking rules checkout needs.
 *
 * Kept separate from the admin settings module so there is one obvious place
 * where "what the public can see" is decided, rather than a filter buried in a
 * handler that someone later relaxes.
 */

const { Router } = require('express');
const asyncHandler = require('../../lib/asyncHandler');
const prisma = require('../../lib/prisma');
const settings = require('../../lib/settings');

const router = Router();

router.get(
  '/settings/public',
  asyncHandler(async (_req, res) => {
    // Only rows explicitly flagged isPublic and not isSecret. API keys and SMTP
    // credentials cannot reach this response even by mistake.
    res.json({ settings: await settings.publicSettings() });
  }),
);

router.get(
  '/centers',
  asyncHandler(async (_req, res) => {
    const rows = await prisma.center.findMany({
      where: { isActive: true },
      orderBy: [{ menuOrder: 'asc' }, { name: 'asc' }],
    });

    res.json({
      items: rows.map((c) => ({
        id: c.id,
        slug: c.slug,
        name: c.name,
        address: c.address,
        city: c.city,
        state: c.state,
        pincode: c.pincode,
        phone: c.phone,
        mapUrl: c.mapUrl,
        openingHours: c.openingHours,
        isHomeCollectionHub: c.isHomeCollectionHub,
      })),
    });
  }),
);

/*
 * What checkout may offer.
 *
 * Note what this is *not*: an availability check. Capacity-based slots are
 * deferred, so these are the windows a customer can request and the range of
 * dates that makes sense — the lab confirms the actual time.
 */
router.get(
  '/collection-options',
  asyncHandler(async (_req, res) => {
    const { windows, minNoticeHours, maxDaysAhead } = await settings.collection();

    const now = new Date();
    const earliest = new Date(now.getTime() + minNoticeHours * 60 * 60 * 1000);
    const latest = new Date(now.getTime() + maxDaysAhead * 24 * 60 * 60 * 1000);

    const asDate = (d) => d.toISOString().slice(0, 10);

    res.json({
      windows,
      minNoticeHours,
      maxDaysAhead,
      // Computed server-side so the date picker agrees with what the order
      // endpoint will accept — two implementations of the same rule drift.
      minDate: asDate(earliest),
      maxDate: asDate(latest),
      isRequestOnly: true,
    });
  }),
);

module.exports = router;
