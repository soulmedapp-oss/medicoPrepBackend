const express = require('express');
const authController = require('../controllers/authController');
const { authMiddleware } = require('../middlewares/auth');
const { createRateLimiter } = require('../middlewares/rateLimit');

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

router.post('/register', registerLimiter, authController.register);
router.post('/login', loginLimiter, authController.login);
router.get('/verify-email', authController.verifyEmail);
router.post('/resend-verification', resendLimiter, authController.resendVerification);
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', resetLimiter, authController.resetPassword);
router.post('/validate-reset-token', authController.validateResetToken);
router.get('/me', authMiddleware, authController.getMe);
router.patch('/me', authMiddleware, authController.updateMe);
router.post('/google', authController.googleAuth);

module.exports = router;
