/*
 * Public site data: settings the website is allowed to read, the collection
 * centres, and the booking rules checkout needs.
 *
 * Kept separate from the admin settings module so there is one obvious place
 * where "what the public can see" is decided, rather than a filter buried in a
 * handler that someone later relaxes.
 */

const { Router } = require('express');
const { z } = require('zod');
const asyncHandler = require('../../lib/asyncHandler');
const validate = require('../../middleware/validate');
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
 * What checkout may offer, for a given date.
 *
 * Note what this is *not*: an availability check. Capacity-based slots are
 * deferred, so these are the windows a customer can request — the lab confirms
 * the actual time.
 *
 * It takes a date because the notice rule depends on one. A naive `minDate` of
 * "today + 4 hours, truncated to a date" says today is bookable at 10am, and
 * then the order endpoint rejects the 07:00 morning window because it has
 * already passed. Computing per-window-per-date here means the picker and the
 * validator cannot disagree — there is one implementation of the rule, and the
 * client asks rather than reimplements.
 */
const windowStart = (dateStr, startTime) => new Date(`${dateStr}T${startTime}:00`);

const asDate = (d) => {
  // Local date parts, not toISOString(): that converts to UTC first, which in
  // IST (UTC+5:30) rolls the date backwards for most of the working day.
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

router.get(
  '/collection-options',
  validate({
    query: z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { windows, minNoticeHours, maxDaysAhead } = await settings.collection();

    const now = new Date();
    const earliest = new Date(now.getTime() + minNoticeHours * 60 * 60 * 1000);
    const latest = new Date(now.getTime() + maxDaysAhead * 24 * 60 * 60 * 1000);

    const availableOn = (dateStr) =>
      windows.map((w) => {
        const starts = windowStart(dateStr, w.start);
        const tooSoon = starts < earliest;
        return {
          ...w,
          available: !tooSoon,
          reason: tooSoon ? `Needs ${minNoticeHours} hours' notice` : null,
        };
      });

    /*
     * The first date with at least one selectable window. Usually today, but
     * late in the day it rolls to tomorrow — which is the correct answer, and
     * the one a naive date-only calculation gets wrong.
     */
    let minDate = asDate(now);
    for (let i = 0; i <= maxDaysAhead; i += 1) {
      const candidate = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
      const dateStr = asDate(candidate);
      if (availableOn(dateStr).some((w) => w.available)) {
        minDate = dateStr;
        break;
      }
    }

    const requested = req.query.date ?? minDate;

    res.json({
      windows: availableOn(requested),
      date: requested,
      minNoticeHours,
      maxDaysAhead,
      minDate,
      maxDate: asDate(latest),
      isRequestOnly: true,
    });
  }),
);

module.exports = router;
