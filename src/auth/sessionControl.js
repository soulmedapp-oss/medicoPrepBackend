const jwt = require('jsonwebtoken');
const s = require('./session');
const TAKEOVER_COOKIE = 'mp_session_confirmation';
const integer = (value, fallback, min, max) => { const n = Number(value); return Number.isInteger(n) && n >= min && n <= max ? n : fallback; };
function policy(env = process.env) {
  const idleMinutes = integer(env.SESSION_IDLE_MINUTES, 20, 1, 1440);
  const warningSeconds = integer(env.SESSION_WARNING_SECONDS, 120, 15, 600);
  return { idle_minutes: idleMinutes, warning_seconds: warningSeconds, timeout_seconds: idleMinutes * 60 + warningSeconds };
}
function live(active, now = Date.now()) {
  return Boolean(active?.id && new Date(active.expires_at).getTime() > now && new Date(active.absolute_expires_at).getTime() > now);
}
function current(user, sid, now = Date.now()) { return Boolean(sid && user?.active_session?.id === sid && live(user.active_session, now)); }
class SessionControlError extends Error {
  constructor(status, code, message, detail = {}) { super(message);this.status=status;this.code=code;this.detail=detail; }
}
function respond(error, res) {
  if (!(error instanceof SessionControlError)) return false;
  res.status(error.status).json({ error: error.message, code: error.code, ...error.detail });return true;
}
function createSessionControl({ User, secret = process.env.JWT_SECRET }) {
  const clear = res => res.clearCookie(TAKEOVER_COOKIE, { httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',path:'/' });
  const fail = () => new SessionControlError(401,'SESSION_EXPIRED','Your session ended. Please sign in again.');
  async function claim(req,res,user,method,confirmed=false) {
    const now=Date.now();
    if(!user || user.is_active===false) throw fail();
    const previous=user.active_session;
    const hash=req.cookies?.[s.COOKIE.refresh] ? s.hashToken(req.cookies[s.COOKIE.refresh]) : '';
    let sameBrowser=(user.refresh_tokens||[]).some(t=>t.hash===hash && t.session_id===previous?.id);
    try {
      const existing=jwt.verify(req.cookies?.[s.COOKIE.access]||'',secret,{algorithms:['HS256'],ignoreExpiration:true});
      sameBrowser ||= !existing.scope && existing.sub===String(user._id||user.id) && existing.sid===previous?.id && existing.tv===Number(user.token_version||0);
    } catch { /* No matching signed browser cookie. Credentials are still required above. */ }
    if(!confirmed && live(previous,now) && !sameBrowser) {
      const browser=s.randomToken();
      const ticket=jwt.sign({uid:String(user._id||user.id),tv:Number(user.token_version||0),sid:previous.id,method,bh:s.hashToken(browser)},secret,
        {algorithm:'HS256',issuer:'soulmed-session-confirmation',audience:'session-takeover',expiresIn:'3m'});
      res.cookie(TAKEOVER_COOKIE,browser,{...s.cookieBase(req),sameSite:'strict',maxAge:180000});
      throw new SessionControlError(409,'ACTIVE_SESSION','You are already signed in on another browser or device.',
        {ticket,device:{last_active_at:previous.last_active_at,browser:String(previous.user_agent||'Another browser').slice(0,180)}});
    }
    const sid=s.randomToken(24),refresh=s.randomToken(),csrf=s.randomToken(16);
    const tv=Number(user.token_version||0),deadline=new Date(now+policy().timeout_seconds*1000),absolute=new Date(now+s.refreshTtlMs());
    const active={id:sid,idle_minutes:policy().idle_minutes,warning_seconds:policy().warning_seconds,last_active_at:new Date(now),expires_at:deadline,absolute_expires_at:absolute,user_agent:String(req.headers?.['user-agent']||'').slice(0,512)};
    const changed=await User.findOneAndUpdate({_id:user._id||user.id,is_active:{$ne:false},'active_session.id':previous?.id||null,
      $expr:{$eq:[{$ifNull:['$token_version',0]},tv]}},{$set:{active_session:active,token_version:tv+1,
      refresh_tokens:[{hash:s.hashToken(refresh),session_id:sid,created_at:new Date(now),expires_at:absolute}]}},{new:true,lean:true});
    if(!changed) throw new SessionControlError(409,'SESSION_CHANGED','Your account/session changed. Please sign in again.');
    // Keep the document passed to downstream permission/display code current.
    user.token_version=changed.token_version;user.active_session=changed.active_session;
    const token=s.signAccessToken(changed,v=>Number(v||0));
    s.setSessionCookies(req,res,{accessToken:token,refreshToken:refresh,csrfToken:csrf});clear(res);
    return token;
  }
  async function issue(req,res,user,method) {
    const fresh=await User.findById(user._id||user.id).lean();
    if(!fresh || Number(fresh.token_version||0)!==Number(user.token_version||0)) throw fail();
    const token=await claim(req,res,fresh,method);
    user.token_version=fresh.token_version;user.active_session=fresh.active_session;
    return token;
  }
  async function confirm(req,res) {
    let data;
    try {
      data=jwt.verify(req.body?.ticket||'',secret,{algorithms:['HS256'],issuer:'soulmed-session-confirmation',audience:'session-takeover'});
      if(!['google','password'].includes(data.method) || !req.cookies?.[TAKEOVER_COOKIE] || data.bh!==s.hashToken(req.cookies[TAKEOVER_COOKIE])) throw Error();
    } catch { throw new SessionControlError(401,'CONFIRMATION_EXPIRED','Confirmation expired. Please sign in again.'); }
    const user=await User.findById(data.uid).lean();
    if(!user || Number(user.token_version||0)!==data.tv || user.active_session?.id!==data.sid) throw fail();
    const token=await claim(req,res,user,data.method,true);return {user,token,method:data.method};
  }
  async function refresh(req,res) {
    const hash=s.hashToken(req.cookies?.[s.COOKIE.refresh]||'');
    let user=await User.findOne({$or:[{'refresh_tokens.hash':hash},{'active_session.previous_refresh_hash':hash}]}).lean();
    const now=Date.now();
    if(!user || user.is_active===false || !live(user.active_session,now)) throw fail();
    const entry=(user.refresh_tokens||[]).find(t=>t.hash===hash && t.session_id===user.active_session.id && new Date(t.expires_at).getTime()>now);
    let refreshToken;
    if(entry) {
      refreshToken=s.randomToken();
      const updated=await User.findOneAndUpdate({_id:user._id,token_version:user.token_version,'active_session.id':user.active_session.id,'refresh_tokens.hash':hash},
        {$set:{refresh_tokens:[{hash:s.hashToken(refreshToken),session_id:entry.session_id,created_at:entry.created_at,expires_at:entry.expires_at}],
          'active_session.previous_refresh_hash':hash,'active_session.previous_refresh_until':new Date(now+30000)}},{new:true,lean:true});
      if(updated) user=updated;
      else { user=await User.findById(user._id).lean();refreshToken=undefined; }
    }
    if(!user || !live(user.active_session,Date.now()) || (!refreshToken && (user.active_session.previous_refresh_hash!==hash || new Date(user.active_session.previous_refresh_until).getTime()<=Date.now()))) throw fail();
    s.setSessionCookies(req,res,{accessToken:s.signAccessToken(user,v=>Number(v||0)),refreshToken,csrfToken:s.randomToken(16)});
  }
  function status(user) {
    const a=user.active_session;
    const p=a?.idle_minutes && a?.warning_seconds ? {idle_minutes:a.idle_minutes,warning_seconds:a.warning_seconds,timeout_seconds:a.idle_minutes*60+a.warning_seconds} : policy();
    return {...p,session_id:a?.id,last_activity_at:a?.last_active_at,warning_at:a?.last_active_at ? new Date(new Date(a.last_active_at).getTime()+p.idle_minutes*60000):null,
      expires_at:a?.expires_at,server_now:new Date()};
  }
  async function activity(req) {
    const now=new Date(),a=req.user.active_session;
    const expires=new Date(Math.min(now.getTime()+policy().timeout_seconds*1000,new Date(a.absolute_expires_at).getTime()));
    const user=await User.findOneAndUpdate({_id:req.userId,'active_session.id':a.id,'active_session.expires_at':{$gt:now},token_version:req.user.token_version},
      {$set:{'active_session.last_active_at':now,'active_session.expires_at':expires,'active_session.idle_minutes':policy().idle_minutes,'active_session.warning_seconds':policy().warning_seconds,last_seen_date:now}},{new:true,lean:true});
    if(!user) throw fail();return status(user);
  }
  return {issue,confirm,refresh,status,activity};
}
module.exports={policy,live,current,createSessionControl,SessionControlError,respond,TAKEOVER_COOKIE};
