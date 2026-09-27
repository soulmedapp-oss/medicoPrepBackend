const express = require('express');
const authController = require('../controllers/authController');
const { authMiddleware } = require('../middlewares/auth');
const { createRateLimiter, userOrIpKey } = require('../middlewares/rateLimit');
const { selfService, publicRoute } = require('../rbac/authorize');

const router = express.Router();

const loginLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 7,
  message: 'Too many login attempts. Please wait a minute.',
});
const registerLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 3,
  message: 'Too many registration attempts. Please wait a minute.',
});
const resetLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 4,
  message: 'Rate limit reached. Please wait before retrying.',
});
const resendLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 3,
  message: 'Verification email rate limit exceeded.',
});

router.post('/register', publicRoute, registerLimiter, authController.register);
router.post('/login', publicRoute, loginLimiter, authController.login);
router.get('/verify-email', publicRoute, authController.verifyEmail);
router.post('/resend-verification', publicRoute, resendLimiter, authController.resendVerification);
const forgotPasswordLimiter = createRateLimiter({
  name: 'auth-forgot-password',
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many password reset requests. Please try again later.',
});
const validateResetLimiter = createRateLimiter({
  name: 'auth-validate-reset',
  windowMs: 60 * 1000,
  max: 10,
  message: 'Rate limit reached. Please wait before retrying.',
});
// Fix round 2, Important 5: the nickname checker is an unauthenticated-cost
// lookup on an indexed field, but it is also a cheap oracle for enumerating
// which nicknames exist — metered per user (falling back to IP) like the rest.
const nicknameLimiter = createRateLimiter({
  name: 'auth-nickname-available',
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: userOrIpKey,
  message: 'Too many nickname checks. Please wait a minute.',
});
const googleLimiter = createRateLimiter({
  name: 'auth-google',
  windowMs: 60 * 1000,
  max: 10,
  message: 'Too many login attempts. Please wait a minute.',
});

router.post('/forgot-password', publicRoute, forgotPasswordLimiter, authController.forgotPassword);
router.post('/reset-password', publicRoute, resetLimiter, authController.resetPassword);
router.post('/validate-reset-token', publicRoute, validateResetLimiter, authController.validateResetToken);
router.get('/me', authMiddleware, selfService, authController.getMe);
router.patch('/me', authMiddleware, selfService, authController.updateMe);
router.get('/nickname-available', authMiddleware, selfService, nicknameLimiter, authController.nicknameAvailable);
router.post('/google', publicRoute, googleLimiter, authController.googleAuth);
// Cookie sessions: the refresh cookie is the credential here (Path-scoped to
// this route), so no bearer/authMiddleware — publicRoute is the marker.
router.post('/refresh', publicRoute, authController.refreshSession);
router.post('/logout', publicRoute, authController.logout);

module.exports = router;
