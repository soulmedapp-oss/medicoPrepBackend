const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const COOKIE = 'mp_google_challenge';
const TTL_SECONDS = 600;
const PURPOSE = 'soulmed-google-login';
const normalizeEmail = value => String(value || '').trim().toLowerCase();
const authoritativeEmail = payload => payload.email_verified === true &&
  (normalizeEmail(payload.email).endsWith('@gmail.com') || (typeof payload.hd === 'string' && payload.hd.length > 0));
const cookieOptions = req => ({ httpOnly: true, secure: process.env.NODE_ENV === 'production' || Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME) || Boolean(req.secure), sameSite: 'strict', path: '/' });
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length &&
  crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function createGoogleAuth({ clientId, client, secret, User, bcrypt, issueSession, userPayload, onLogin, onError = () => {} }) {
  const enabled = Boolean(clientId && client && secret);
  function config(req, res) {
    res.set('Cache-Control', 'no-store, private');
    res.set('Pragma', 'no-cache');
    if (!enabled) return res.json({ enabled: false });
    const nonce = crypto.randomBytes(32).toString('hex');
    const challenge = jwt.sign({ nonce }, secret, { algorithm: 'HS256', audience: clientId, issuer: PURPOSE, expiresIn: TTL_SECONDS });
    res.cookie(COOKIE, challenge, { ...cookieOptions(req), maxAge: TTL_SECONDS * 1000 });
    return res.json({ enabled: true, clientId, nonce });
  }
  async function login(req, res) {
    res.set('Cache-Control', 'no-store, private');
    if (!enabled) return res.status(503).json({ error: 'Google sign-in is not configured' });
    const { idToken, password } = req.body || {};
    if (typeof idToken !== 'string' || !idToken || idToken.length > 16384 || (password != null && (typeof password !== 'string' || password.length > 1024))) {
      return res.status(400).json({ error: 'Invalid Google sign-in request' });
    }
    let challenge;
    let payload;
    try {
      challenge = jwt.verify(req.cookies?.[COOKIE] || '', secret, { algorithms: ['HS256'], audience: clientId, issuer: PURPOSE });
      const ticket = await client.verifyIdToken({ idToken, audience: clientId });
      payload = ticket.getPayload();
      if (!equal(payload?.nonce, challenge.nonce) || typeof payload?.sub !== 'string' || !payload.sub ||
          typeof payload?.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email) || payload.email_verified !== true) throw new Error('Invalid identity');
    } catch {
      res.clearCookie(COOKIE, cookieOptions(req));
      return res.status(401).json({ error: 'Google sign-in expired or could not be verified. Please try again.', code: 'GOOGLE_RETRY' });
    }
    try {
      const email = normalizeEmail(payload.email);
      const googleId = payload.sub;
      const linked = await User.find({ googleId }).limit(2);
      if (linked.length > 1) return res.status(409).json({ error: 'Please contact support to resolve this Google account link.' });
      let user = linked[0];
      if (!user) {
        const matches = await User.find({ email: new RegExp('^' + escapeRegex(email) + '$', 'i') }).limit(2);
        if (matches.length > 1) return res.status(409).json({ error: 'Please contact support to link this account.' });
        user = matches[0];
        if (user?.googleId && user.googleId !== googleId) return res.status(409).json({ error: 'This account is already linked to another Google identity.' });
        if (user?.is_active === false) return res.status(403).json({ error: 'Account is inactive' });
        // For third-party email providers Google may no longer own email verification.
        if (!authoritativeEmail(payload)) {
          if (!user) return res.status(403).json({ error: 'Register and verify this email in SoulMed first, then use your SoulMed password to link Google.' });
          if (!password || !user.passwordHash || !await bcrypt.compare(password, user.passwordHash)) {
            return res.status(401).json({ error: 'Enter your existing SoulMed password to link this Google account.', code: 'GOOGLE_LINK_REQUIRED' });
          }
        }
        if (user) {
          const changes = { googleId };
          if (authoritativeEmail(payload)) {
            changes.email_verified = true;
            changes.email_verified_at = user.email_verified_at || new Date();
          }
          // Do not overwrite a link changed concurrently or reactivate a disabled user.
          user = await User.findOneAndUpdate({ _id: user._id, is_active: { $ne: false }, $or: [{ googleId: null }, { googleId }] }, { $set: changes }, { new: true });
          if (!user) return res.status(409).json({ error: 'Account changed during sign-in. Please try again.' });
        } else {
          user = await User.create({ googleId, email, full_name: payload.name || email, profile_image: payload.picture,
            email_verified: true, email_verified_at: new Date(), role: 'student', roles: [], permissions: [] });
        }
      }
      if (user.is_active === false) return res.status(403).json({ error: 'Account is inactive' });
      // Linked third-party identities still need SoulMed's email verification.
      if (user.email_verified === false) return res.status(403).json({ error: 'Verify your email in SoulMed before signing in.', requires_verification: true });
      const responseUser = await userPayload(user, req);
      const token = await issueSession(req, res, user);
      res.clearCookie(COOKIE, cookieOptions(req));
      onLogin(user, req);
      return res.json({ user: responseUser, token });
    } catch (error) {
      if (error?.code === 11000) return res.status(409).json({ error: 'Account changed during sign-in. Please try again.' });
      onError(req, new Error('Google sign-in internal failure'));
      return res.status(500).json({ error: 'Google sign-in failed. Please try again later.' });
    }
  }
  return { config, login };
}
module.exports = { createGoogleAuth, authoritativeEmail, COOKIE };
