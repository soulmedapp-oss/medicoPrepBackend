const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { OAuth2Client } = require('google-auth-library');
const User = require('../models/User');
const { sanitizeUser } = require('../utils/userUtils');
const { isValidEmail, isValidPhone, isValidTextLength } = require('../utils/validation');

const {
  GOOGLE_CLIENT_ID,
  JWT_SECRET,
  JWT_EXPIRES_IN,
  APP_BASE_URL,
  API_BASE_URL,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM,
  SMTP_SECURE,
  VERIFICATION_RESEND_COOLDOWN_SECONDS,
} = process.env;

const oauthClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
const tokenExpiry = JWT_EXPIRES_IN || '7d';
const appBaseUrl = APP_BASE_URL || process.env.CORS_ORIGIN || 'http://localhost:5173';
const apiBaseUrl = API_BASE_URL || APP_BASE_URL || 'http://localhost:4000';
const resendCooldownMs = Math.max(
  0,
  Number(VERIFICATION_RESEND_COOLDOWN_SECONDS || 120) * 1000
);

const emailTransport = SMTP_HOST
  ? nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: SMTP_SECURE === 'true',
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS || '' } : undefined,
  })
  : null;

function signToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: tokenExpiry });
}

function createEmailVerificationToken() {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  return { token, tokenHash };
}

function createPasswordResetToken() {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  return { token, tokenHash };
}

async function sendVerificationEmail({ email, token, name }) {
  if (!emailTransport) {
    throw new Error('Email service is not configured');
  }
  const from = SMTP_FROM || SMTP_USER;
  if (!from) {
    throw new Error('Email sender is not configured');
  }
  const base = apiBaseUrl.replace(/\/$/, '');
  const verifyUrl = `${base}/auth/verify-email?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;
  const appBase = appBaseUrl ? appBaseUrl.replace(/\/$/, '') : '';
  const loginUrl = appBase ? `${appBase}/Login` : '';
  const firstName = name ? name.split(' ')[0] : '';

  const subject = 'Verify your email';
  const text = [
    `Hi ${firstName || 'there'},`,
    '',
    'Please verify your email address by clicking the link below:',
    verifyUrl,
    '',
    loginUrl ? `After verification you can log in here: ${loginUrl}` : '',
    '',
    'If you did not sign up, you can safely ignore this email.',
  ].filter(Boolean).join('\n');

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5;">
      <p>Hi ${firstName || 'there'},</p>
      <p>Please verify your email address by clicking the button below:</p>
      <p>
        <a href="${verifyUrl}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;">
          Verify Email
        </a>
      </p>
      <p>Or paste this link into your browser:</p>
      <p><a href="${verifyUrl}">${verifyUrl}</a></p>
      ${loginUrl ? `<p>After verification you can log in here: <a href="${loginUrl}">${loginUrl}</a></p>` : ''}
      <p>If you did not sign up, you can safely ignore this email.</p>
    </div>
  `;

  await emailTransport.sendMail({
    from,
    to: email,
    subject,
    text,
    html,
  });
}

async function sendPasswordResetEmail({ email, token, name }) {
  if (!emailTransport) {
    throw new Error('Email service is not configured');
  }
  const from = SMTP_FROM || SMTP_USER;
  if (!from) {
    throw new Error('Email sender is not configured');
  }
  const base = appBaseUrl ? appBaseUrl.replace(/\/$/, '') : '';
  const resetUrl = `${base}/ResetPassword?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;
  const firstName = name ? name.split(' ')[0] : '';

  const subject = 'Reset your password';
  const text = [
    `Hi ${firstName || 'there'},`,
    '',
    'We received a request to reset your password.',
    'Use the link below to set a new password:',
    resetUrl,
    '',
    'If you did not request this, you can safely ignore this email.',
  ].join('\n');

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5;">
      <p>Hi ${firstName || 'there'},</p>
      <p>We received a request to reset your password.</p>
      <p>
        <a href="${resetUrl}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;">
          Reset Password
        </a>
      </p>
      <p>Or paste this link into your browser:</p>
      <p><a href="${resetUrl}">${resetUrl}</a></p>
      <p>If you did not request this, you can safely ignore this email.</p>
    </div>
  `;

  await emailTransport.sendMail({
    from,
    to: email,
    subject,
    text,
    html,
  });
}

function sendHtmlResponse(res, status, title, message) {
  res.status(status).send(`
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 32px; background: #f8fafc; color: #0f172a; }
          .card { max-width: 520px; margin: 0 auto; background: #fff; padding: 24px; border-radius: 12px; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08); }
          a { color: #2563eb; text-decoration: none; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>${title}</h2>
          <p>${message}</p>
          ${appBaseUrl ? `<p><a href="${appBaseUrl.replace(/\/$/, '')}/Login">Log in</a></p>` : ''}
        </div>
      </body>
    </html>
  `);
}

async function register(req, res) {
  try {
    const { email, password, full_name } = req.body;
    if (!email || !password || !full_name) {
      return res.status(400).json({ error: 'email, password, and full_name are required' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    if (!isValidTextLength(full_name, 2, 120)) {
      return res.status(400).json({ error: 'full_name must be between 2 and 120 characters' });
    }
    if (typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'password must be at least 6 characters' });
    }

    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const { token, tokenHash } = createEmailVerificationToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const user = await User.create({
      email,
      passwordHash,
      full_name,
      email_verified: false,
      email_verification_token: tokenHash,
      email_verification_expires: expiresAt,
      email_verification_sent_at: new Date(),
    });

    await sendVerificationEmail({ email, token, name: full_name });

    return res.json({ user: sanitizeUser(user), requires_verification: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Registration failed' });
  }
}

async function login(req, res) {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const user = await User.findOne({ email });
    if (!user || typeof user.passwordHash !== 'string' || !user.passwordHash.length) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (user.email_verified === false) {
      return res.status(403).json({ error: 'Email not verified', requires_verification: true });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = signToken(user.id);
    return res.json({ user: sanitizeUser(user), token });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Login failed' });
  }
}

async function verifyEmail(req, res) {
  try {
    const { email, token } = req.query;
    if (!email || !token) {
      const message = 'Missing email or token.';
      if (req.headers.accept?.includes('text/html')) {
        return sendHtmlResponse(res, 400, 'Verification failed', message);
      }
      return res.status(400).json({ error: message });
    }

    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const user = await User.findOne({
      email: String(email),
      email_verification_token: tokenHash,
      email_verification_expires: { $gt: new Date() },
    });

    if (!user) {
      const message = 'Verification link is invalid or expired.';
      if (req.headers.accept?.includes('text/html')) {
        return sendHtmlResponse(res, 400, 'Verification failed', message);
      }
      return res.status(400).json({ error: message });
    }

    user.email_verified = true;
    user.email_verified_at = new Date();
    user.email_verification_token = undefined;
    user.email_verification_expires = undefined;
    await user.save();

    const message = 'Your email is verified. Click Log in to continue.';
    if (req.headers.accept?.includes('text/html')) {
      return sendHtmlResponse(res, 200, 'Email verified', message);
    }
    return res.json({ ok: true, message });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to verify email' });
  }
}

async function resendVerification(req, res) {
  try {
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.email_verified) {
      return res.json({ ok: true, message: 'Email already verified' });
    }

    if (user.email_verification_sent_at && resendCooldownMs > 0) {
      const elapsed = Date.now() - new Date(user.email_verification_sent_at).getTime();
      if (elapsed < resendCooldownMs) {
        const retryAfter = Math.ceil((resendCooldownMs - elapsed) / 1000);
        return res.status(429).json({
          error: 'Please wait before requesting another verification email.',
          retry_after_seconds: retryAfter,
        });
      }
    }

    const { token, tokenHash } = createEmailVerificationToken();
    user.email_verification_token = tokenHash;
    user.email_verification_expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    user.email_verification_sent_at = new Date();
    await user.save();

    await sendVerificationEmail({ email, token, name: user.full_name });

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to resend verification email' });
  }
}

async function forgotPassword(req, res) {
  try {
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.json({ ok: true });
    }

    const { token, tokenHash } = createPasswordResetToken();
    user.password_reset_token = tokenHash;
    user.password_reset_expires = new Date(Date.now() + 60 * 60 * 1000);
    user.password_reset_requested_at = new Date();
    await user.save();

    await sendPasswordResetEmail({ email, token, name: user.full_name });

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to send password reset email' });
  }
}

async function resetPassword(req, res) {
  try {
    const { email, token, password } = req.body || {};
    if (!email || !token || !password) {
      return res.status(400).json({ error: 'email, token, and password are required' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    if (typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'password must be at least 6 characters' });
    }

    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const user = await User.findOne({
      email: String(email),
      password_reset_token: tokenHash,
      password_reset_expires: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({ error: 'Reset link has expired' });
    }

    user.passwordHash = await bcrypt.hash(password, 10);
    user.password_reset_token = undefined;
    user.password_reset_expires = undefined;
    user.password_reset_requested_at = undefined;
    await user.save();

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to reset password' });
  }
}

async function validateResetToken(req, res) {
  try {
    const { email, token } = req.body || {};
    if (!email || !token) {
      return res.status(400).json({ error: 'email and token are required' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const user = await User.findOne({
      email: String(email),
      password_reset_token: tokenHash,
      password_reset_expires: { $gt: new Date() },
    }).lean();

    if (!user) {
      return res.status(400).json({ error: 'Reset link has expired' });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to validate reset link' });
  }
}

async function getMe(req, res) {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    return res.json({ user: sanitizeUser(user) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to load user' });
  }
}

async function updateMe(req, res) {
  try {
    const allowedFields = [
      'full_name',
      'phone',
      'college',
      'year_of_study',
      'target_exam',
      'profile_image',
      'last_login_date',
      'subscription_plan',
      'role',
      'permissions',
      'admin_status',
      'is_teacher',
      'tests_taken',
      'average_score',
    ];

    const updates = {};
    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        updates[field] = req.body[field];
      }
    }
    if (updates.full_name && !isValidTextLength(String(updates.full_name), 2, 120)) {
      return res.status(400).json({ error: 'full_name must be between 2 and 120 characters' });
    }
    if (updates.phone && !isValidPhone(String(updates.phone))) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }

    const user = await User.findByIdAndUpdate(
      req.userId,
      { $set: updates },
      { new: true }
    );

    return res.json({ user: sanitizeUser(user) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update user' });
  }
}

async function googleAuth(req, res) {
  try {
    const { idToken } = req.body;
    if (!idToken) {
      return res.status(400).json({ error: 'idToken is required' });
    }
    if (!oauthClient) {
      return res.status(503).json({ error: 'Google sign-in is not configured' });
    }

    const ticket = await oauthClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload) {
      return res.status(401).json({ error: 'Invalid Google token' });
    }

    const { sub: googleId, email, name, picture } = payload;
    if (!email) {
      return res.status(400).json({ error: 'Google account has no email' });
    }

    let user = await User.findOne({ $or: [{ googleId }, { email }] });
    if (user) {
      user.googleId = googleId;
      user.email = email;
      user.full_name = name || user.full_name;
      user.profile_image = picture || user.profile_image;
      user.email_verified = true;
      user.email_verified_at = user.email_verified_at || new Date();
      user.email_verification_token = undefined;
      user.email_verification_expires = undefined;
      await user.save();
    } else {
      user = await User.create({
        googleId,
        email,
        full_name: name || email,
        profile_image: picture,
        email_verified: true,
        email_verified_at: new Date(),
      });
    }

    const token = signToken(user.id);
    return res.json({ user: sanitizeUser(user), token });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    return res.status(500).json({ error: 'Login failed' });
  }
}

module.exports = {
  register,
  login,
  verifyEmail,
  resendVerification,
  forgotPassword,
  resetPassword,
  validateResetToken,
  getMe,
  updateMe,
  googleAuth,
};
