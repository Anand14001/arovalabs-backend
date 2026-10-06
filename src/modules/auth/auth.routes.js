// Admin authentication routes.

const { Router } = require('express');
const asyncHandler = require('../../lib/asyncHandler');
const validate = require('../../middleware/validate');
const { authLimiter } = require('../../middleware/rateLimit');
const { requireAdmin } = require('../../middleware/requireAdmin');
const { REFRESH_COOKIE, setRefreshCookie, clearRefreshCookie } = require('../../lib/tokens');
const service = require('./auth.service');
const schemas = require('./auth.schema');

const router = Router();

router.post(
  '/login',
  authLimiter,
  validate(schemas.loginSchema),
  asyncHandler(async (req, res) => {
    const { user, accessToken, refreshToken } = await service.login(req.body, req);
    setRefreshCookie(res, refreshToken);
    // The access token goes in the body so the client can hold it in memory;
    // only the refresh token is a cookie.
    res.json({ user, accessToken });
  }),
);

router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const { user, accessToken, refreshToken } = await service.refresh(
      req.cookies?.[REFRESH_COOKIE],
      req,
    );
    setRefreshCookie(res, refreshToken);
    res.json({ user, accessToken });
  }),
);

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    // Deliberately not behind requireAdmin: logging out with an already-expired
    // access token must still clear the session rather than 401.
    await service.logout(req.cookies?.[REFRESH_COOKIE], req);
    clearRefreshCookie(res);
    res.json({ ok: true });
  }),
);

router.get(
  '/me',
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json({ user: service.publicUser(req.user) });
  }),
);

router.post(
  '/change-password',
  requireAdmin,
  authLimiter,
  validate(schemas.changePasswordSchema),
  asyncHandler(async (req, res) => {
    const { accessToken, refreshToken } = await service.changePassword(
      req.user.id,
      req.body,
      req,
    );
    setRefreshCookie(res, refreshToken);
    res.json({ ok: true, accessToken });
  }),
);

router.post(
  '/forgot-password',
  authLimiter,
  validate(schemas.forgotPasswordSchema),
  asyncHandler(async (req, res) => {
    await service.forgotPassword(req.body, req);
    // Same response regardless of whether the account exists.
    res.json({
      ok: true,
      message: 'If that account exists, a reset link is on its way.',
    });
  }),
);

router.post(
  '/reset-password',
  authLimiter,
  validate(schemas.resetPasswordSchema),
  asyncHandler(async (req, res) => {
    await service.resetPassword(req.body, req);
    res.json({ ok: true, message: 'Password updated. You can sign in now.' });
  }),
);

module.exports = router;
