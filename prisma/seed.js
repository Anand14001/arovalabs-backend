/*
 * Database seed.
 *
 * Idempotent by design — every write is an upsert keyed on something stable, so
 * running it against an existing database tops it up instead of duplicating or
 * failing. That matters because this runs after every production deploy to pick
 * up new default settings.
 *
 * Step 1 seeds the platform floor: the settings registry and the six real
 * collection centers. Products, categories, tags, content and the admin user
 * arrive with their own build steps (SPEC.md §6) and are added here as they do.
 */

const prisma = require('../src/lib/prisma');
const logger = require('../src/lib/logger');
const env = require('../src/config/env');
const { hashPassword } = require('../src/lib/password');
const { importCatalog } = require('./import-catalog');
const { importContent } = require('./import-content');

// Grouped the same way the admin's Settings tabs are, so a new setting shows up
// in the right place without any extra wiring.
const settings = [
  // general
  { key: 'general.siteTitle', group: 'general', type: 'STRING', value: 'Arova Labs', label: 'Site title', isPublic: true },
  { key: 'general.formerly', group: 'general', type: 'STRING', value: '(Formerly Healthcare Diagnostic Services)', label: 'Former name', helpText: 'Shown next to the logo in the top bar.', isPublic: true },
  { key: 'general.tagline', group: 'general', type: 'TEXT', value: 'Precision diagnostics for a healthier community. Leading the way in pathological excellence since 2008.', label: 'Tagline', isPublic: true },
  { key: 'general.copyright', group: 'general', type: 'STRING', value: '© 2026 Arova Labs. All rights reserved.', label: 'Footer copyright', isPublic: true },

  // contact
  { key: 'contact.homeCollectionPhone', group: 'contact', type: 'STRING', value: '+91 94422 18998', label: 'Home collection number', isPublic: true },
  { key: 'contact.headerPhone', group: 'contact', type: 'STRING', value: '9445518822', label: 'Header call number', isPublic: true },
  { key: 'contact.whatsapp', group: 'contact', type: 'STRING', value: 'http://wa.me/919445518822', label: 'WhatsApp link', isPublic: true },
  { key: 'contact.email', group: 'contact', type: 'STRING', value: 'support@arovalabs.com', label: 'Support email', isPublic: true },
  { key: 'contact.address', group: 'contact', type: 'TEXT', value: '133/1/26 A, Nethaji Bypass Road, Opp Ganesha Theatre, Dharmapuri-1, TamilNadu, India.', label: 'Registered address', isPublic: true },
  // The reference site's embed points at the London Eye. Corrected here.
  { key: 'contact.mapEmbed', group: 'contact', type: 'TEXT', value: 'https://maps.google.com/maps?q=133%2F1%2F26A%20Nethaji%20Bypass%20Road%20Dharmapuri%20Tamil%20Nadu%20636701&t=m&z=15&output=embed&iwloc=near', label: 'Contact page map embed', helpText: 'The reference site embedded the London Eye by mistake; this points at the Dharmapuri lab.', isPublic: true },

  // commerce — money is integer paise everywhere, including here
  { key: 'commerce.currency', group: 'commerce', type: 'STRING', value: 'INR', label: 'Currency', isPublic: true },
  { key: 'commerce.taxPercent', group: 'commerce', type: 'NUMBER', value: '0', label: 'Tax %', helpText: 'The reference site states taxes are already included in the listed price.' },
  { key: 'commerce.collectionFeePaise', group: 'commerce', type: 'NUMBER', value: '0', label: 'Home collection fee (paise)', helpText: 'Home collection is advertised as free; set above zero only if that changes.' },
  { key: 'commerce.freeCollectionThresholdPaise', group: 'commerce', type: 'NUMBER', value: '0', label: 'Free collection above (paise)' },
  { key: 'commerce.minOrderValuePaise', group: 'commerce', type: 'NUMBER', value: '0', label: 'Minimum order value (paise)' },
  { key: 'commerce.orderNumberPrefix', group: 'commerce', type: 'STRING', value: 'ARV', label: 'Order number prefix' },

  /*
   * Collection timing.
   *
   * Capacity-based availability is deferred, so none of these enforce anything
   * against a schedule: checkout collects a *preferred* date and window, and the
   * lab confirms. See SPEC.md, "Collection".
   */
  { key: 'collection.windows', group: 'collection', type: 'JSON', value: JSON.stringify([
      { id: 'morning', label: 'Morning', start: '07:00', end: '11:00', note: 'Best for fasting tests' },
      { id: 'midday', label: 'Midday', start: '11:00', end: '14:00' },
      { id: 'afternoon', label: 'Afternoon', start: '14:00', end: '18:00' },
    ]), label: 'Collection time windows', helpText: 'What a customer can choose from at checkout. These are requests, not guarantees.', isPublic: true },
  { key: 'collection.minNoticeHours', group: 'collection', type: 'NUMBER', value: '4', label: 'Minimum notice (hours)', helpText: 'How soon a collection can be requested. Stops someone asking for a slot that has already started.', isPublic: true },
  { key: 'collection.maxDaysAhead', group: 'collection', type: 'NUMBER', value: '14', label: 'Requestable days ahead', isPublic: true },

  // content blocks repeated across product pages
  { key: 'content.slotsNotice', group: 'content', type: 'STRING', value: 'Only 2-3 Slots are remaining', label: 'Slots notice', isPublic: true },
  { key: 'content.taxNotice', group: 'content', type: 'STRING', value: 'Taxes and collection fees included', label: 'Tax notice', isPublic: true },

  // notifications
  { key: 'notifications.orderConfirmationEmail', group: 'notifications', type: 'BOOLEAN', value: 'true', label: 'Email order confirmations' },
  { key: 'notifications.reportReadyEmail', group: 'notifications', type: 'BOOLEAN', value: 'true', label: 'Email when a report is ready' },
  { key: 'notifications.reportReadyWhatsapp', group: 'notifications', type: 'BOOLEAN', value: 'false', label: 'WhatsApp when a report is ready', helpText: 'Needs a WhatsApp provider configured first.' },

  // seo
  { key: 'seo.defaultMetaTitle', group: 'seo', type: 'STRING', value: 'Arova Labs — NABL Accredited Diagnostic Laboratory', label: 'Default meta title', isPublic: true },
  { key: 'seo.defaultMetaDescription', group: 'seo', type: 'TEXT', value: 'Book lab tests and health packages with free home sample collection. NABL accredited, e-reports in 24 hours.', label: 'Default meta description', isPublic: true },
  { key: 'seo.robots', group: 'seo', type: 'STRING', value: 'index,follow', label: 'Robots directive' },
];

// The six real locations from the reference site's about page.
const centers = [
  {
    slug: 'dharmapuri',
    name: 'Dharmapuri',
    address: '133/1/26A, Nethaji Bypass, opp. Ganesha Theatre, Dharmapuri, Tamil Nadu 636701',
    city: 'Dharmapuri',
    pincode: '636701',
    phone: '+91 9442218998',
    isHomeCollectionHub: true,
    menuOrder: 1,
  },
  {
    slug: 'salem',
    name: 'Salem',
    address: '24/302, JH Towers, Vasantham Hotel Road, Fairlands, Salem, Tamil Nadu',
    city: 'Salem',
    phone: '+91 9445518822',
    isHomeCollectionHub: true,
    menuOrder: 2,
  },
  {
    slug: 'dharmapuri-mmm-hospital',
    name: 'Dharmapuri MMM Hospital',
    address: 'MMM Hospital, Dharmapuri, Tamil Nadu',
    city: 'Dharmapuri',
    phone: '+91 9443446814',
    menuOrder: 3,
  },
  {
    slug: 'pennagaram',
    name: 'Pennagaram',
    address: 'Pennagaram, Dharmapuri, Tamil Nadu 636701',
    city: 'Pennagaram',
    pincode: '636701',
    phone: '+91 9443446814',
    menuOrder: 4,
  },
  {
    slug: 'ssk-hospital',
    name: 'SSK Hospital',
    address: 'Salem Main Rd, Indhira Nagar, Dharmapuri, Tamil Nadu 636701',
    city: 'Dharmapuri',
    pincode: '636701',
    phone: '+91 9443446814',
    menuOrder: 5,
  },
  {
    slug: 'ottapatti',
    name: 'Ottapatti',
    address: 'Sri Maruthi Clinic & Scans, Salem Main Road, Ottapatti, Tamil Nadu 636701',
    city: 'Ottapatti',
    pincode: '636701',
    phone: '+91 9443446814',
    menuOrder: 6,
  },
];

/*
 * No slot templates are seeded.
 *
 * Capacity-based availability is deferred, and the numbers this used to insert
 * — four one-hour windows a day, capacity 4/4/3/3, across all six centres —
 * were invented. Fabricated capacity sitting in the database is worse than an
 * empty table: it looks like a decision someone made, and the first person to
 * build on it would be building on nothing.
 *
 * The tables are migrated and ready. See SPEC.md, "Collection".
 */

async function seedSettings() {
  for (const s of settings) {
    await prisma.setting.upsert({
      where: { key: s.key },
      // Only metadata is refreshed on re-run. Overwriting `value` would undo
      // whatever an admin had configured, every deploy.
      update: {
        group: s.group,
        type: s.type,
        label: s.label,
        helpText: s.helpText ?? null,
        isPublic: s.isPublic ?? false,
        isSecret: s.isSecret ?? false,
      },
      create: { ...s, isPublic: s.isPublic ?? false, isSecret: s.isSecret ?? false },
    });
  }
  logger.info({ count: settings.length }, 'settings seeded');
}

async function seedCenters() {
  for (const c of centers) {
    const center = await prisma.center.upsert({
      where: { slug: c.slug },
      update: { name: c.name, address: c.address, city: c.city, phone: c.phone, menuOrder: c.menuOrder },
      create: {
        ...c,
        state: 'Tamil Nadu',
        openingHours: {
          mon: [['07:00', '20:00']],
          tue: [['07:00', '20:00']],
          wed: [['07:00', '20:00']],
          thu: [['07:00', '20:00']],
          fri: [['07:00', '20:00']],
          sat: [['07:00', '20:00']],
          sun: [['08:00', '13:00']],
        },
      },
    });

    void center;
  }
  logger.info({ count: centers.length }, 'centres seeded');
}

/*
 * The first admin account.
 *
 * Created only when no admin exists. Re-running the seed never resets a
 * password — otherwise every production deploy would silently reinstate the
 * seed credentials, which is exactly the kind of thing nobody notices until it
 * is used.
 */
async function seedAdmin() {
  const existing = await prisma.user.count();
  if (existing > 0) {
    logger.info({ count: existing }, 'admin account(s) already present — not touching passwords');
    return;
  }

  const user = await prisma.user.create({
    data: {
      email: env.ADMIN_EMAIL.toLowerCase(),
      name: env.ADMIN_NAME,
      passwordHash: await hashPassword(env.ADMIN_PASSWORD),
      role: 'SUPER_ADMIN',
      isActive: true,
      // Left false deliberately: the password was chosen on purpose rather than
      // generated, so there is nothing to force a change away from on first login.
      mustChangePassword: false,
    },
  });

  logger.info({ email: user.email }, 'admin account created');

  if (env.isProduction && env.ADMIN_PASSWORD === 'Admin@123') {
    logger.warn(
      'The admin account was created with the default development password. Change it before this site is public.',
    );
  }
}

async function main() {
  logger.info('seeding');
  await seedSettings();
  await seedCenters();
  await seedAdmin();
  // Products, categories, tags and their images, read straight out of
  // website/src/data/ — see import-catalog.js.
  await importCatalog();
  // Blog, page sections, testimonials, FAQs and navigation — everything an
  // editor might reasonably want to change.
  await importContent();
  logger.info('seed complete');
}

main()
  .catch((err) => {
    logger.fatal({ err }, 'seed failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
