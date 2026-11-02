const RETENTION_DAYS = 30;
const HISTORY_LIMIT = 20;

function createLoginHistory({ User, LoginEvent, onError = () => {} }) {
  async function record(userId, req, method, now = new Date()) {
    if (!['google', 'password'].includes(method)) throw new Error('Unsupported login method');
    const ip = String(req.ip || req.socket?.remoteAddress || '').slice(0, 100);
    const userAgent = String(req.headers?.['user-agent'] || '').slice(0, 512);
    const results = await Promise.allSettled([
      Promise.resolve().then(() => User.updateOne({ _id: userId, $or: [{ last_login_date: { $lte: now } }, { last_login_date: null }] },
        { $set: { last_login_method: method, last_login_date: now, last_seen_date: now,
          last_login_ip: ip, last_login_user_agent: userAgent } })),
      Promise.resolve().then(() => LoginEvent.create({ user_id: userId, method, occurred_at: now,
        expires_at: new Date(now.getTime() + RETENTION_DAYS * 86400000), ip, user_agent: userAgent })),
    ]);
    // A history outage must not invalidate an otherwise successful login.
    if (results.some(result => result.status === 'rejected')) onError();
  }
  async function list(userId, now = new Date()) {
    return LoginEvent.find({ user_id: userId, expires_at: { $gt: now }, occurred_at: { $gte: new Date(now.getTime() - RETENTION_DAYS * 86400000) } })
      .sort({ occurred_at: -1, _id: -1 }).limit(HISTORY_LIMIT)
      .select('method occurred_at ip user_agent -_id').lean();
  }
  return { record, list };
}
module.exports = { createLoginHistory, RETENTION_DAYS, HISTORY_LIMIT };
