const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { createGoogleAuth, authoritativeEmail, COOKIE } = require('../src/auth/google');

function response() {
  return { statusCode: 200, headers: {}, cookies: {}, cleared: [], set(k,v) { this.headers[k]=v; return this; },
    cookie(k,v,opts) { this.cookies[k]={value:v,opts}; return this; }, clearCookie(k) { this.cleared.push(k); return this; },
    status(n) { this.statusCode=n; return this; }, json(v) { this.body=v; return this; } };
}
function setup(users = [], options = {}) {
  const writes=[]; const sessions=[]; const checks=[]; const comparisons=[];
  const clientId='123-test.apps.googleusercontent.com'; const secret='test-secret-for-google-challenge';
  const payload={sub:'google-identity',email:'person@gmail.com',email_verified:true,name:'Person',nonce:'',...options.payload};
  const User={ async findOne(query) { return users.find(u=>u.googleId===query.googleId); },
    find(query) { return { async limit(n) { return users.filter(u=>query.googleId ? u.googleId===query.googleId : query.email.test(u.email)).slice(0,n); } }; },
    async findOneAndUpdate(query,update) { writes.push(update); if(options.raced) return null;
      const u=users.find(u=>u._id===query._id); Object.assign(u,update.$set); return u; },
    async create(data) { writes.push(data); const u={_id:'created',...data}; users.push(u); return u; } };
  const handlers=createGoogleAuth({clientId:options.disabled ? '' : clientId,secret,User,
    client:{async verifyIdToken(args) { checks.push(args); if(options.badToken) throw Error('token invalid');return {getPayload:()=>payload}; }},
    bcrypt:{async compare(pass,hash) { comparisons.push([pass,hash]); return pass==='existing-password'; }},
    async issueSession(req,res,user) { sessions.push(user); return 'normal-session'; },
    async userPayload(user) { return {...user}; }, onLogin:()=>{} });
  const config=response();handlers.config({secure:true},config);
  if(config.body.enabled) payload.nonce=config.body.nonce;
  const req={body:{idToken:'google-token'},cookies:{[COOKIE]:config.cookies[COOKIE]?.value},secure:true};
  return {handlers,payload,req,config,writes,sessions,checks,comparisons,clientId,secret,users};
}
async function login(s) { const res=response();await s.handlers.login(s.req,res);return res; }

test('configuration is disabled without a Client ID; enabled challenge is signed, private and short-lived',()=>{
  const off=setup([],{disabled:true});assert.deepEqual(off.config.body,{enabled:false});assert.deepEqual(off.config.cookies,{});
  const s=setup();const cookie=s.config.cookies[COOKIE];assert.ok(cookie.opts.httpOnly && cookie.opts.secure);assert.equal(cookie.opts.sameSite,'strict');
  assert.equal(cookie.opts.maxAge,600000);assert.match(s.config.headers['Cache-Control'],/no-store/);
  const token=jwt.verify(cookie.value,s.secret,{audience:s.clientId});assert.equal(token.nonce,s.config.body.nonce);assert.equal(token.exp-token.iat,600);
});
test('new Gmail sign-in creates only a student with no client-supplied privileges and issues the normal session',async()=>{
  const s=setup();s.req.body.role='admin';s.req.body.permissions=['all'];const res=await login(s);
  assert.equal(res.statusCode,200);assert.equal(res.body.user.role,'student');assert.deepEqual(res.body.user.permissions,[]);
  assert.equal(s.checks[0].audience,s.clientId);assert.equal(s.sessions.length,1);assert.ok(res.cleared.includes(COOKIE));
});
test('matching Gmail links the original account without replacing password, subscription, name or permissions',async()=>{
  const user={_id:'existing',email:'Person@Gmail.com',passwordHash:'old-hash',full_name:'Doctor',role:'teacher',permissions:['review'],subscription_plan:'premium',email_verified:true};
  const s=setup([user]);const res=await login(s);assert.equal(res.body.user._id,'existing');assert.equal(s.users.length,1);
  assert.equal(user.googleId,s.payload.sub);assert.equal(user.passwordHash,'old-hash');assert.equal(user.role,'teacher');
  assert.deepEqual(user.permissions,['review']);assert.equal(user.subscription_plan,'premium');assert.equal(user.full_name,'Doctor');
});
test('returning Google subject identifies original account even when Google email changes',async()=>{
  const user={_id:'old',googleId:'google-identity',email:'old@gmail.com',email_verified:true};
  const s=setup([user]);const res=await login(s);assert.equal(res.body.user._id,'old');assert.equal(res.body.user.email,'old@gmail.com');assert.equal(s.writes.length,0);
});
test('third-party email linking requires the existing SoulMed password; correct proof permits both methods',async()=>{
  const user={_id:'old',email:'person@example.org',passwordHash:'old-hash',email_verified:true};
  const s=setup([user],{payload:{email:'person@example.org'}});
  assert.equal((await login(s)).body.code,'GOOGLE_LINK_REQUIRED');assert.equal(s.writes.length,0);
  s.req.body.password='incorrect';assert.equal((await login(s)).body.code,'GOOGLE_LINK_REQUIRED');
  s.req.body.password='existing-password';assert.equal((await login(s)).statusCode,200);assert.equal(user.passwordHash,'old-hash');
});
test('Workspace ownership permits automatic linking while third-party new accounts must verify with SoulMed first',async()=>{
  assert.equal(authoritativeEmail({email:'p@company.com',email_verified:true,hd:'company.com'}),true);
  assert.equal(authoritativeEmail({email:'p@company.com',email_verified:true}),false);
  const s=setup([],{payload:{email:'person@example.org'}});assert.equal((await login(s)).statusCode,403);assert.equal(s.writes.length,0);
});
for(const kind of ['missing-cookie','wrong-nonce','unverified','invalid-token','expired-challenge','wrong-audience']) test(kind+' fails before account writes or session issuance',async()=>{
  const s=setup([],{badToken:kind==='invalid-token'});
  if(kind==='missing-cookie') s.req.cookies={};
  if(kind==='wrong-nonce') s.payload.nonce='another-browser';
  if(kind==='unverified') s.payload.email_verified=false;
  if(kind==='expired-challenge') s.req.cookies[COOKIE]=jwt.sign({nonce:s.payload.nonce},s.secret,{audience:s.clientId,issuer:'soulmed-google-login',expiresIn:-1});
  if(kind==='wrong-audience') s.req.cookies[COOKIE]=jwt.sign({nonce:s.payload.nonce},s.secret,{audience:'another-client',issuer:'soulmed-google-login',expiresIn:60});
  const res=await login(s);assert.equal(res.statusCode,401);assert.equal(s.writes.length,0);assert.equal(s.sessions.length,0);
});
test('disabled users, conflicting links, ambiguous emails and concurrent account changes fail closed',async()=>{
  for(const [users,options,expected] of [
    [[{_id:'off',email:'person@gmail.com',is_active:false}],{},403],
    [[{_id:'off',googleId:'google-identity',email:'person@gmail.com',is_active:false}],{},403],
    [[{_id:'other',email:'person@gmail.com',googleId:'other-id'}],{},409],
    [[{_id:'a',email:'person@gmail.com'},{_id:'b',email:'PERSON@gmail.com'}],{},409],
    [[{_id:'a',googleId:'google-identity',email:'a@gmail.com'},{_id:'b',googleId:'google-identity',email:'b@gmail.com'}],{},409],
    [[{_id:'race',email:'person@gmail.com'}],{raced:true},409],
  ]) { const s=setup(users,options);assert.equal((await login(s)).statusCode,expected);assert.equal(s.sessions.length,0); }
});
test('unverified third-party linked users must complete SoulMed verification',async()=>{
  const s=setup([{_id:'old',googleId:'google-identity',email:'person@example.org',email_verified:false}],{payload:{email:'person@example.org'}});
  const res=await login(s);assert.equal(res.statusCode,403);assert.equal(res.body.requires_verification,true);assert.equal(s.sessions.length,0);
});
test('non-string and oversized tokens are rejected without invoking Google',async()=>{
  for(const idToken of [null,{},'x'.repeat(17000)]) { const s=setup();s.req.body.idToken=idToken;assert.equal((await login(s)).statusCode,400);assert.equal(s.checks.length,0); }
});
