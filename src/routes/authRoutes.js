const express = require('express');
const authController = require('../controllers/authController');
const { authMiddleware } = require('../middlewares/auth');
const { createRateLimiter } = require('../middlewares/rateLimit');
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
router.post('/google', publicRoute, googleLimiter, authController.googleAuth);

module.exports = router;
