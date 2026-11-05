const test=require('node:test');const assert=require('node:assert/strict');const jwt=require('jsonwebtoken');
const {createSessionControl,policy,current,live,SessionControlError,TAKEOVER_COOKIE}=require('../src/auth/sessionControl');
const s=require('../src/auth/session');
const secret='test-session-control-secret';process.env.JWT_SECRET=secret;
process.env.SESSION_IDLE_TIMEOUT_ENABLED='true';process.env.SESSION_SINGLE_DEVICE_ENABLED='true';
const clone=value=>JSON.parse(JSON.stringify(value));
function fixture(){
 let db={_id:'user-1',id:'user-1',token_version:0,is_active:true,refresh_tokens:[],active_session:null};const calls=[];
 const evaluate=value=>{if(typeof value==='string'&&value.startsWith('$'))return db[value.slice(1)];if(value&&typeof value==='object'){if(value.$ifNull){const v=evaluate(value.$ifNull[0]);return v==null?value.$ifNull[1]:v;}if(value.$eq)return evaluate(value.$eq[0])===evaluate(value.$eq[1]);if(value.$and)return value.$and.every(evaluate);}return value;};
 const User={findById(){return {lean:async()=>clone(db)};},findOne(q){return {lean:async()=>{
   if(q.$or && !q.$or.some(item=>item['refresh_tokens.hash'] ? db.refresh_tokens.some(t=>t.hash===item['refresh_tokens.hash']): db.active_session?.previous_refresh_hash===item['active_session.previous_refresh_hash'])) return null;
   return clone(db);
 }};},async findOneAndUpdate(q,u){
 calls.push({q,u});if(q._id!==db._id||q.token_version!==undefined&&q.token_version!==db.token_version)return null;
 if(q['active_session.id']!==undefined&&q['active_session.id']!==(db.active_session?.id||null))return null;
 if(q.$expr && !evaluate(q.$expr))return null;
 if(q['refresh_tokens.hash']&&!db.refresh_tokens.some(t=>t.hash===q['refresh_tokens.hash']))return null;
 if(q['active_session.expires_at']&&Date.parse(db.active_session.expires_at)<=q['active_session.expires_at'].$gt.getTime())return null;
 for(const [key,value]of Object.entries(u.$set||{})){if(key.startsWith('active_session.'))db.active_session[key.split('.')[1]]=value;else db[key]=value;}
 return clone(db);
 }};
 const service=createSessionControl({User,secret});
 return {service,calls,get db(){return db;},replace(value){db=value;}};
}
function response(){return {cookies:{},cookie(k,v,opts){this.cookies[k]={v,opts};},clearCookie(){}};}
const request=(cookies={})=>({cookies,headers:{'user-agent':'Test browser'},secure:false});
async function start(f){const res=response();const token=await f.service.issue(request(),res,clone(f.db),'password');return {res,token};}

test('idle policy is configurable and rejects invalid values',()=>{
 assert.deepEqual(policy({}),{idle_minutes:20,warning_seconds:120,timeout_seconds:1320,idle_timeout_enabled:true,single_device_enabled:true});
 assert.equal(policy({SESSION_IDLE_MINUTES:'1',SESSION_WARNING_SECONDS:'30'}).timeout_seconds,90);
 assert.equal(policy({SESSION_IDLE_MINUTES:'-1'}).idle_minutes,20);
});
test('new session has one refresh token and signed session ID; a different browser gets a confirmation only after proof',async()=>{
 const f=fixture(),first=await start(f);const claims=jwt.verify(first.token,secret);
 assert.equal(f.db.refresh_tokens.length,1);assert.equal(claims.sid,f.db.active_session.id);assert.equal(claims.tv,1);
 const res=response();let conflict;
 try{await f.service.issue(request(),res,clone(f.db),'google');}catch(e){conflict=e;}
 assert.ok(conflict instanceof SessionControlError);assert.equal(conflict.code,'ACTIVE_SESSION');assert.ok(conflict.detail.ticket);
 assert.equal(f.db.token_version,1);assert.equal(res.cookies[TAKEOVER_COOKIE].opts.httpOnly,true);
});
test('confirmation is browser-bound and revokes old session and refresh credentials',async()=>{
 const f=fixture(),first=await start(f),res=response();let ticket;
 try{await f.service.issue(request(),res,clone(f.db),'google');}catch(e){ticket=e.detail.ticket;}
 await assert.rejects(()=>f.service.confirm({...request(),body:{ticket}},response()),/Confirmation expired/);
 const req={...request({[TAKEOVER_COOKIE]:res.cookies[TAKEOVER_COOKIE].v}),body:{ticket}};
 const confirmed=await f.service.confirm(req,response());assert.equal(confirmed.method,'google');assert.equal(f.db.token_version,2);
 assert.notEqual(f.db.active_session.id,jwt.decode(first.token).sid);assert.equal(current(f.db,jwt.decode(first.token).sid),false);
 assert.notEqual(f.db.refresh_tokens[0].hash,s.hashToken(first.res.cookies[s.COOKIE.refresh].v));
 await assert.rejects(()=>f.service.confirm(req,response()),/session ended/i);
});
test('same browser reauthentication does not show an other-device warning',async()=>{
 const f=fixture(),first=await start(f);const req=request({[s.COOKIE.access]:first.token});
 await f.service.issue(req,response(),clone(f.db),'password');assert.equal(f.db.token_version,2);
});
test('idle expiry is enforced independently of browser timers and refresh does not extend activity',async()=>{
 const f=fixture(),first=await start(f);const oldDate=f.db.active_session.last_active_at;
 const req=request({[s.COOKIE.refresh]:first.res.cookies[s.COOKIE.refresh].v});await f.service.refresh(req,response());
 assert.equal(new Date(f.db.active_session.last_active_at).getTime(),new Date(oldDate).getTime());f.db.active_session.expires_at=new Date(Date.now()-1).toISOString();
 assert.equal(live(f.db.active_session),false);await assert.rejects(()=>f.service.refresh(req,response()),/session ended/i);
});
test('parallel refresh of a recently rotated cookie never clears or replaces the winning refresh cookie',async()=>{
 const f=fixture(),first=await start(f),req=request({[s.COOKIE.refresh]:first.res.cookies[s.COOKIE.refresh].v});
 const winner=response();await f.service.refresh(req,winner);const stored=f.db.refresh_tokens[0].hash;
 const loser=response();await f.service.refresh(req,loser);assert.equal(loser.cookies[s.COOKIE.refresh],undefined);assert.equal(f.db.refresh_tokens[0].hash,stored);
});
test('concurrent credential-verified logins cannot silently replace each other',async()=>{
 const f=fixture(),user=clone(f.db);
 const results=await Promise.allSettled([f.service.issue(request(),response(),clone(user),'password'),f.service.issue(request(),response(),clone(user),'password')]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.db.token_version,1);
});
test('activity extends only the matching non-expired session and respects absolute expiry',async()=>{
 const f=fixture();await start(f);const user=clone(f.db);f.db.active_session.absolute_expires_at=new Date(Date.now()+10000).toISOString();user.active_session=f.db.active_session;
 const result=await f.service.activity({userId:user._id,user});assert.ok(Date.parse(result.expires_at)<=Date.now()+10100);
 await assert.rejects(()=>f.service.activity({userId:user._id,user:{...user,active_session:{...user.active_session,id:'old'}}}),/session ended/i);
});

async function withSwitches(idle,single,run){
 const previous=[process.env.SESSION_IDLE_TIMEOUT_ENABLED,process.env.SESSION_SINGLE_DEVICE_ENABLED];
 process.env.SESSION_IDLE_TIMEOUT_ENABLED=String(idle);process.env.SESSION_SINGLE_DEVICE_ENABLED=String(single);
 try{return await run();}finally{[process.env.SESSION_IDLE_TIMEOUT_ENABLED,process.env.SESSION_SINGLE_DEVICE_ENABLED]=previous;}
}
test('switches preserve rollout defaults and can be configured independently',()=>{
 assert.equal(policy({SESSION_IDLE_TIMEOUT_ENABLED:'true'}).idle_timeout_enabled,true);
 assert.equal(policy({SESSION_IDLE_TIMEOUT_ENABLED:'true',SESSION_SINGLE_DEVICE_ENABLED:'false'}).single_device_enabled,false);
 assert.equal(policy({SESSION_SINGLE_DEVICE_ENABLED:'true'}).single_device_enabled,true);
 assert.equal(policy({SESSION_SINGLE_DEVICE_ENABLED:'false'}).single_device_enabled,false);
});
test('disabled controls keep both browsers signed in without changing global revocation',async()=>withSwitches(false,false,async()=>{
 const f=fixture(),first=await start(f),second=await start(f);
 assert.equal(f.db.token_version,0);assert.equal(f.db.browser_sessions.length,2);
 assert.equal(current(f.db,jwt.decode(first.token).sid),true);assert.equal(current(f.db,jwt.decode(second.token).sid),true);
 const ownAi=jwt.decode(s.signAiToken(require('../src/auth/sessionControl').selectedUser(f.db,jwt.decode(first.token).sid)));assert.equal(ownAi.sid,jwt.decode(first.token).sid);
 const controls=jwt.decode(first.token).session_controls;assert.equal(controls.idle_timeout_enabled,false);assert.equal(controls.single_device_enabled,false);
 f.db.browser_sessions.forEach(a=>a.expires_at=new Date(Date.now()-10000).toISOString());
 assert.equal(current(f.db,jwt.decode(first.token).sid),true);
 const refreshed=response();await f.service.refresh(request({[s.COOKIE.refresh]:first.res.cookies[s.COOKIE.refresh].v}),refreshed);
 assert.equal(jwt.decode(refreshed.cookies[s.COOKIE.access].v).sid,jwt.decode(first.token).sid);
}));
test('signing out one browser revokes only that browser including AI identity',async()=>withSwitches(false,false,async()=>{
 const f=fixture(),first=await start(f),second=await start(f);
 await f.service.logout(request({[s.COOKIE.refresh]:first.res.cookies[s.COOKIE.refresh].v}));
 assert.equal(current(f.db,jwt.decode(first.token).sid),false);assert.equal(current(f.db,jwt.decode(second.token).sid),true);assert.equal(f.db.token_version,0);
 await assert.rejects(()=>f.service.refresh(request({[s.COOKIE.refresh]:first.res.cookies[s.COOKIE.refresh].v}),response()),/session ended/i);
 const refreshed=response();await f.service.refresh(request({[s.COOKIE.refresh]:second.res.cookies[s.COOKIE.refresh].v}),refreshed);
 assert.equal(jwt.decode(refreshed.cookies[s.COOKIE.access].v).sid,jwt.decode(second.token).sid);
}));
test('parallel multi-device signins and refreshes preserve all sessions',async()=>withSwitches(false,false,async()=>{
 const f=fixture();const [first,second]=await Promise.all([start(f),start(f)]);
 assert.equal(f.db.browser_sessions.length,2);assert.equal(f.db.token_version,0);
 await Promise.all([f.service.refresh(request({[s.COOKIE.refresh]:first.res.cookies[s.COOKIE.refresh].v}),response()),f.service.refresh(request({[s.COOKIE.refresh]:second.res.cookies[s.COOKIE.refresh].v}),response())]);
 assert.equal(current(f.db,jwt.decode(first.token).sid),true);assert.equal(current(f.db,jwt.decode(second.token).sid),true);
}));
test('timeout-only policy expires one idle browser without replacing the other',async()=>withSwitches(true,false,async()=>{
 const f=fixture(),first=await start(f),second=await start(f);const firstId=jwt.decode(first.token).sid;
 f.db.browser_sessions.find(a=>a.id===firstId).expires_at=new Date(Date.now()-1000).toISOString();
 assert.equal(current(f.db,firstId),false);assert.equal(current(f.db,jwt.decode(second.token).sid),true);
}));
test('single-device-only policy ignores idle expiry but requires takeover confirmation',async()=>withSwitches(false,true,async()=>{
 const f=fixture(),first=await start(f);f.db.active_session.expires_at=new Date(Date.now()-1000).toISOString();
 assert.equal(current(f.db,jwt.decode(first.token).sid),true);
 await assert.rejects(()=>start(f),e=>e.code==='ACTIVE_SESSION');
}));
test('an existing legacy single-session record survives a second login when controls are disabled',async()=>withSwitches(false,false,async()=>{
 const f=fixture();const now=Date.now();f.replace({...f.db,active_session:{id:'legacy',expires_at:new Date(now-1000),absolute_expires_at:new Date(now+100000),last_active_at:new Date(now-2000)},refresh_tokens:[{hash:'legacy-hash',session_id:'legacy',expires_at:new Date(now+100000)}]});
 await start(f);assert.equal(current(f.db,'legacy'),true);assert.equal(f.db.browser_sessions.length,2);
}));
test('absolute expiry and token-version revocation still apply when optional controls are off',async()=>withSwitches(false,false,async()=>{
 const f=fixture(),first=await start(f),sid=jwt.decode(first.token).sid;
 f.db.active_session.absolute_expires_at=new Date(Date.now()-1000).toISOString();assert.equal(current(f.db,sid),false);
 const f2=fixture(),login=await start(f2);f2.db.token_version++;f2.db.active_session=null;
 assert.equal(current(f2.db,jwt.decode(login.token).sid),false);
}));
test('same-browser reauthentication preserves the other browser',async()=>withSwitches(false,false,async()=>{
 const f=fixture(),first=await start(f),second=await start(f);const res=response();
 await f.service.issue(request({[s.COOKIE.access]:first.token}),res,clone(f.db),'password');
 assert.equal(current(f.db,jwt.decode(first.token).sid),false);assert.equal(current(f.db,jwt.decode(second.token).sid),true);assert.equal(f.db.token_version,0);
}));
test('session reads explicitly select private session and refresh state',async()=>{
 const {privateQuery}=require('../src/auth/sessionControl');let selected;
 const query={select(value){selected=value;return this;},async lean(){return {ok:true};}};
 assert.deepEqual(await privateQuery(query),{ok:true});assert.match(selected,/\+browser_sessions/);assert.match(selected,/\+refresh_tokens/);
});
