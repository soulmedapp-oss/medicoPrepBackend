const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { OAuth2Client } = require('google-auth-library');
const User = require('../models/User');
const { expireSubscriptionIfNeeded } = require('../utils/subscriptionExpiry');
const { sanitizeUser } = require('../utils/userUtils');
const { isValidEmail, isValidPhone, isValidTextLength } = require('../utils/validation');
const { enqueueJob } = require('../utils/inMemoryQueue');
const { normalizeTokenVersion } = require('../utils/security');
const { validateNickname, isValidAvatarId, isDuplicateNicknameError } = require('../utils/identity');
const { loadPermissions } = require('../rbac/loadPermissions');
const { can } = require('../rbac/can');
const { viewerFor, featureLocksFor } = require('../utils/entitlement');
const { reportError } = require('../lib/errorReporter.js');
const session = require('../auth/session');

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

function ensureEmailConfigured() {
  if (!emailTransport) {
    throw new Error('Email service is not configured');
  }
  const from = SMTP_FROM || SMTP_USER;
  if (!from) {
    throw new Error('Email sender is not configured');
  }
  return from;
}

function signToken(user) {
  return session.signAccessToken(user, normalizeTokenVersion);
}

// Starts a browser session: short-lived access JWT + rotating refresh token
// + CSRF token, all as cookies (src/auth/session.js). The access token is
// ALSO returned in the body for non-browser clients; the web app ignores it
// and never stores it.
async function issueSession(req, res, user) {
  const accessToken = signToken(user);
  const refreshToken = session.randomToken();
  const csrfToken = session.randomToken(16);
  const current = await User.findById(user._id || user.id).select('refresh_tokens').lean();
  const next = session.addRefreshToken(current?.refresh_tokens, session.hashToken(refreshToken));
  await User.updateOne({ _id: user._id || user.id }, { $set: { refresh_tokens: next } });
  session.setSessionCookies(req, res, { accessToken, refreshToken, csrfToken });
  return accessToken;
}

// POST /auth/refresh — trades a valid refresh cookie for a new access cookie
// and a NEW refresh cookie (rotation). An unknown or expired refresh token
// ends the session: cookies cleared, 401.
async function refreshSession(req, res) {
  try {
    const presented = req.cookies?.[session.COOKIE.refresh];
    if (!presented) {
      session.clearSessionCookies(req, res);
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    const presentedHash = session.hashToken(presented);
    const user = await User.findOne({ 'refresh_tokens.hash': presentedHash }).select('+refresh_tokens');
    if (!user || user.is_active === false) {
      session.clearSessionCookies(req, res);
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    const refreshToken = session.randomToken();
    const rotated = session.rotateRefreshToken(user.refresh_tokens, presentedHash, session.hashToken(refreshToken));
    if (!rotated.ok) {
      await User.updateOne({ _id: user._id }, { $set: { refresh_tokens: rotated.next } });
      session.clearSessionCookies(req, res);
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    await User.updateOne({ _id: user._id }, { $set: { refresh_tokens: rotated.next } });
    const accessToken = signToken(user);
    const csrfToken = session.randomToken(16);
    session.setSessionCookies(req, res, { accessToken, refreshToken, csrfToken });
    return res.json({ ok: true, expires_in: Math.floor(session.accessTtlMs() / 1000) });
  } catch (err) {
    reportError(req, err);
    return res.status(500).json({ error: 'Failed to refresh session' });
  }
}

// POST /auth/logout — forgets this browser's refresh token and clears the
// cookies. Idempotent: works with or without a live session.
async function logout(req, res) {
  try {
    const presented = req.cookies?.[session.COOKIE.refresh];
    if (presented) {
      await User.updateOne(
        { 'refresh_tokens.hash': session.hashToken(presented) },
        { $pull: { refresh_tokens: { hash: session.hashToken(presented) } } }
      );
    }
    session.clearSessionCookies(req, res);
    return res.json({ ok: true });
  } catch (err) {
    reportError(req, err);
    session.clearSessionCookies(req, res);
    return res.json({ ok: true });
  }
}

// POST /auth/ai-token — a short-lived bearer token for the AI service, which
// lives on another origin and never sees the session cookies. POST so the
// CSRF check applies: a cross-site page cannot mint one.
function aiToken(req, res) {
  return res.json({
    token: session.signAiToken(req.user),
    expires_in: session.AI_TOKEN_TTL_SECONDS,
  });
}

async function attachEffectivePermissions(payload) {
  if (!payload) return payload;
  const { roleNames, permissions } = await loadPermissions(payload);
  payload.roles = roleNames;
  payload.effective_permissions = permissions;
  return payload;
}

// Fix round 1: if viewerFor/featureLocksFor throws (e.g. SubscriptionPlan.find
// fails), login/getMe/googleAuth must not 500 over a display-only field. Every
// non-staff key degrades to this — the same "a paid plan" tier-1 fallback
// featureLock itself returns when no plan lists a feature — so the client
// shows every tab locked rather than trusting a possibly-wrong unlocked
// state; the real gate is still the server-side featureLock check on each
// endpoint, which runs its own viewerFor and fails the request (never silently
// opens) if the same lookup is failing.
const FEATURE_LOCK_FALLBACK = Object.freeze({ required_plan: '', required_label: 'a paid plan', required_tier: 1 });

// Task 2 (spec §2/§4): the same three-key { ai_tutor, ai_summary, transcript }
// lock object the video/transcript endpoints enforce, mirrored onto every
// auth payload the browser receives, so a locked watch-page tab can render
// without a second request. Staff (CanViewVideos) always get all three null
// — must run AFTER attachEffectivePermissions, since can() reads
// effective_permissions.
async function withFeatureLocks(user, req) {
  if (can(user, 'CanViewVideos')) {
    return { ai_tutor: null, ai_summary: null, transcript: null };
  }
  try {
    return featureLocksFor(await viewerFor(user));
  } catch (err) {
    reportError(req, err, 'withFeatureLocks failed; degrading fail-closed');
    return {
      ai_tutor: { ...FEATURE_LOCK_FALLBACK },
      ai_summary: { ...FEATURE_LOCK_FALLBACK },
      transcript: { ...FEATURE_LOCK_FALLBACK },
    };
  }
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const realIp = req.headers['x-real-ip'];
  const candidate = (Array.isArray(forwarded) ? forwarded[0] : String(forwarded || ''))
    .split(',')[0]
    .trim() || String(realIp || '').trim() || req.ip || '';
  return candidate.replace(/^::ffff:/, '');
}

async function updateLoginMeta(userId, req) {
  const ip = getClientIp(req);
  const userAgent = String(req.headers['user-agent'] || '');
  const updates = {
    last_login_date: new Date(),
    last_seen_date: new Date(),
    last_login_ip: ip || undefined,
    last_login_user_agent: userAgent || undefined,
  };
  await User.findByIdAndUpdate(userId, { $set: updates }).catch(() => {});
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
  const from = ensureEmailConfigured();
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
  const from = ensureEmailConfigured();
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
      role: 'student',
      roles: ['student'],
      email_verified: false,
      email_verification_token: tokenHash,
      email_verification_expires: expiresAt,
      email_verification_sent_at: new Date(),
    });

    ensureEmailConfigured();
    enqueueJob(() => sendVerificationEmail({ email, token, name: full_name }));

    return res.json({
      user: sanitizeUser(user),
      requires_verification: true,
      message: 'Verification email has been sent.',
    });
  } catch (err) {
    reportError(req, err);
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
    if (user.is_active === false) {
      return res.status(403).json({ error: 'Account is inactive' });
    }

    if (user.email_verified === false) {
      return res.status(403).json({ error: 'Email not verified', requires_verification: true });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const updatedUser = await expireSubscriptionIfNeeded(user);
    const token = await issueSession(req, res, user);
    const payload = await attachEffectivePermissions(sanitizeUser(updatedUser || user));
    payload.feature_locks = await withFeatureLocks(payload, req);
    enqueueJob(() => updateLoginMeta(user.id, req));
    return res.json({ user: payload, token });
  } catch (err) {
    reportError(req, err);
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
    if (user.is_active === false) {
      const message = 'Account is inactive.';
      if (req.headers.accept?.includes('text/html')) {
        return sendHtmlResponse(res, 403, 'Verification failed', message);
      }
      return res.status(403).json({ error: message });
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
    reportError(req, err);
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
    if (user.is_active === false) {
      return res.status(403).json({ error: 'Account is inactive' });
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

    ensureEmailConfigured();
    enqueueJob(() => sendVerificationEmail({ email, token, name: user.full_name }));

    return res.json({ ok: true });
  } catch (err) {
    reportError(req, err);
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
    if (!user || user.is_active === false) {
      return res.json({ ok: true });
    }

    const { token, tokenHash } = createPasswordResetToken();
    user.password_reset_token = tokenHash;
    user.password_reset_expires = new Date(Date.now() + 60 * 60 * 1000);
    user.password_reset_requested_at = new Date();
    await user.save();

    ensureEmailConfigured();
    enqueueJob(() => sendPasswordResetEmail({ email, token, name: user.full_name }));

    return res.json({ ok: true });
  } catch (err) {
    reportError(req, err);
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

    if (!user || user.is_active === false) {
      return res.status(400).json({ error: 'Reset link has expired' });
    }

    user.passwordHash = await bcrypt.hash(password, 10);
    user.password_reset_token = undefined;
    user.password_reset_expires = undefined;
    user.password_reset_requested_at = undefined;
    // Revoke every JWT issued before this reset.
    user.token_version = normalizeTokenVersion(user.token_version) + 1;
    user.refresh_tokens = []; // and every browser's refresh cookie with them
    await user.save();

    return res.json({ ok: true });
  } catch (err) {
    reportError(req, err);
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

    if (!user || user.is_active === false) {
      return res.status(400).json({ error: 'Reset link has expired' });
    }

    return res.json({ ok: true });
  } catch (err) {
    reportError(req, err);
    return res.status(500).json({ error: 'Failed to validate reset link' });
  }
}

async function getMe(req, res) {
  try {
    const user = await User.findById(req.userId);
    if (!user || user.is_active === false) {
      return res.status(404).json({ error: 'User not found' });
    }
    const refreshed = await expireSubscriptionIfNeeded(user);
    const payload = sanitizeUser(refreshed || user);
    await attachEffectivePermissions(payload);
    payload.feature_locks = await withFeatureLocks(payload, req);
    return res.json({ user: payload });
  } catch (err) {
    reportError(req, err);
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
      'notify_live_classes',
      'last_login_date',
      'last_seen_date',
      'nickname',
      'avatar_id',
    ];
    const forbiddenFields = [
      'subscription_plan',
      'subscription_status',
      'subscription_start_date',
      'subscription_end_date',
      'role',
      'roles',
      'permissions',
      'admin_status',
      'is_teacher',
      'email_verified',
      'is_active',
      'tests_taken',
      'average_score',
    ];
    
    const attemptedForbidden = forbiddenFields.filter((field) =>
      Object.prototype.hasOwnProperty.call(req.body || {}, field)
    );
    if (attemptedForbidden.length > 0) {
      return res.status(403).json({ error: 'Not allowed to update sensitive fields' });
    }

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
    for (const field of ['college', 'target_exam', 'year_of_study']) {
      if (updates[field] && !isValidTextLength(String(updates[field]), 0, 120)) {
        return res.status(400).json({ error: `${field} must be 120 characters or less` });
      }
    }
    // Fix round 2, Minor: `null` is how the UI says "back to the default
    // avatar"; normalise it to '' BEFORE validation so the stored value is the
    // '' the schema defaults to, not a null the readers don't expect.
    if (updates.avatar_id === null) updates.avatar_id = '';
    if (Object.prototype.hasOwnProperty.call(updates, 'avatar_id') && !isValidAvatarId(String(updates.avatar_id ?? ''))) {
      return res.status(400).json({ error: 'Unknown avatar' });
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'nickname')) {
      const raw = String(updates.nickname ?? '').trim();
      if (raw === '') {
        updates.nickname = '';
        updates.nickname_lc = undefined; // $unset below keeps the sparse index clean
      } else {
        const check = validateNickname(raw);
        if (!check.ok) return res.status(400).json({ error: check.error });
        const taken = await User.exists({ nickname_lc: check.lc, _id: { $ne: req.userId } });
        if (taken) return res.status(409).json({ error: 'That nickname is already taken' });
        updates.nickname = check.value;
        updates.nickname_lc = check.lc;
      }
    }

    const updateOps = { $set: updates };
    if (Object.prototype.hasOwnProperty.call(updates, 'nickname_lc') && updates.nickname_lc === undefined) {
      delete updates.nickname_lc;
      updateOps.$unset = { nickname_lc: '' };
    }

    const user = await User.findByIdAndUpdate(
      req.userId,
      updateOps,
      { new: true }
    );

    return res.json({ user: sanitizeUser(user) });
  } catch (err) {
    reportError(req, err);
    // Fix round 1, Important 3: the pre-write uniqueness check above is a
    // read-then-write race — a concurrent request can win the unique index
    // between the check and this write. Turn that into the same 409 the
    // pre-check would have given, not a 500.
    if (isDuplicateNicknameError(err)) {
      return res.status(409).json({ error: 'That nickname is already taken' });
    }
    return res.status(500).json({ error: 'Failed to update user' });
  }
}

async function nicknameAvailable(req, res) {
  try {
    const check = validateNickname(String(req.query.nickname || ''));
    if (!check.ok) return res.json({ available: false, reason: check.error });
    const taken = await User.exists({ nickname_lc: check.lc, _id: { $ne: req.userId } });
    return res.json({ available: !taken, value: check.value });
  } catch (err) {
    reportError(req, err);
    return res.status(500).json({ error: 'Failed to check nickname' });
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

    const googlePayload = ticket.getPayload();
    if (!googlePayload) {
      return res.status(401).json({ error: 'Invalid Google token' });
    }

    const { sub: googleId, email, name, picture } = googlePayload;
    if (!email) {
      return res.status(400).json({ error: 'Google account has no email' });
    }
    // Only a Google-verified email may be linked to (or create) an account.
    if (googlePayload.email_verified !== true) {
      return res.status(403).json({ error: 'Google email is not verified' });
    }

    // Prefer the account already linked to this Google identity; otherwise link by email.
    let user = await User.findOne({ googleId });
    if (!user) {
      user = await User.findOne({ email });
      if (user && user.googleId && user.googleId !== googleId) {
        return res.status(409).json({ error: 'This email is linked to a different Google account' });
      }
    }
    if (user && user.is_active === false) {
      return res.status(403).json({ error: 'Account is inactive' });
    }
    if (user) {
      user.googleId = googleId;
      // Never overwrite an existing account's email with the Google one.
      user.full_name = name || user.full_name;
      user.profile_image = picture || user.profile_image;
      if (String(user.email).toLowerCase() === String(email).toLowerCase()) {
        user.email_verified = true;
        user.email_verified_at = user.email_verified_at || new Date();
        user.email_verification_token = undefined;
        user.email_verification_expires = undefined;
      }
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

    const token = await issueSession(req, res, user);
    const responsePayload = await attachEffectivePermissions(sanitizeUser(user));
    responsePayload.feature_locks = await withFeatureLocks(responsePayload, req);
    enqueueJob(() => updateLoginMeta(user.id, req));
    return res.json({ user: responsePayload, token });
  } catch (err) {
    // eslint-disable-next-line no-console
    reportError(req, err);
    return res.status(500).json({ error: 'Login failed' });
  }
}

module.exports = {
  refreshSession,
  logout,
  aiToken,
  register,
  login,
  verifyEmail,
  resendVerification,
  forgotPassword,
  resetPassword,
  validateResetToken,
  getMe,
  updateMe,
  nicknameAvailable,
  googleAuth,
};
