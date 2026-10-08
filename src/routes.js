// The API router. One place that says what exists.
//
// Modules are mounted as they are built; the commented lines are the agreed
// build order from SPEC.md §6 and are uncommented in step order.

const { Router } = require('express');
const healthRoutes = require('./modules/health/health.routes');
const { requireAdmin } = require('./middleware/requireAdmin');

const categories = require('./modules/categories/categories.routes');
const tags = require('./modules/tags/tags.routes');

const router = Router();

router.use(healthRoutes);

// ---------------------------------------------------------------- public
router.use('/products', require('./modules/products/products.public.routes'));
router.use('/categories', categories.publicRouter);
router.use('/tags', tags.publicRouter);

router.use(require('./modules/site/site.routes'));
router.use('/cart', require('./modules/cart/cart.routes'));
router.use('/orders', require('./modules/orders/orders.public.routes'));
/*
 * /payments/webhook is NOT mounted here — it needs the raw request body for
 * signature verification and is mounted in app.js ahead of the JSON parser.
 */
router.use('/payments', require('./modules/payments/payments.routes'));

const prescriptions = require('./modules/prescriptions/prescriptions.routes');
const reports = require('./modules/reports/reports.routes');

router.use('/prescriptions', prescriptions.publicRouter);
/*
 * Report download is public by token only — the token is the credential, which
 * is what lets an emailed or WhatsApped link work without an account. It is
 * long, random, expiring and revocable.
 */
router.use('/reports', reports.publicRouter);

const content = require('./modules/content/content.routes');
const leads = require('./modules/leads/leads.routes');

// Blog, pages, testimonials, FAQs, navigation and redirects.
router.use(content.publicRouter);
router.use('/contact', leads.publicRouter);

// ----------------------------------------------------------------- admin
router.use('/admin/auth', require('./modules/auth/auth.routes'));

/*
 * Everything below requires a signed-in admin. Applied here rather than per
 * route so a new admin module cannot be added unprotected by accident — the
 * mount point is the gate.
 */
router.use('/admin/products', requireAdmin, require('./modules/products/products.admin.routes'));
router.use('/admin/categories', categories.adminRouter);
router.use('/admin/tags', tags.adminRouter);
router.use('/admin/media', require('./modules/media/media.routes'));

router.use('/admin/orders', requireAdmin, require('./modules/orders/orders.admin.routes'));
router.use('/admin/prescriptions', prescriptions.adminRouter);
router.use('/admin/reports', reports.adminRouter);
router.use('/admin/content', content.adminRouter);
router.use('/admin/leads', requireAdmin, leads.adminRouter);
router.use('/admin/coupons', requireAdmin, require('./modules/coupons/coupons.admin.routes').adminRouter);
router.use('/admin/centers', requireAdmin, require('./modules/centers/centers.admin.routes').adminRouter);
router.use('/admin/analytics', require('./modules/analytics/analytics.routes'));

router.get('/', (_req, res) => {
  res.json({ name: 'Arova Labs API', version: 1 });
});

module.exports = router;
