const test=require('node:test');
const assert=require('node:assert/strict');
const {createLoginHistory,RETENTION_DAYS,HISTORY_LIMIT}=require('../src/auth/loginHistory');
const now=new Date('2026-11-01T10:00:00Z');
test('server-provided method is stored with bounded metadata and 30-day expiry; credentials are never copied',async()=>{
 for(const method of ['google','password']) {
  let update,event;
  const history=createLoginHistory({User:{async updateOne(q,u){update={q,u};}},LoginEvent:{async create(e){event=e;}}});
  await history.record('user-id',{ip:'127.0.0.1',headers:{'user-agent':'x'.repeat(900)},body:{method:'attacker',password:'secret',idToken:'token'}},method,now);
  assert.equal(update.u.$set.last_login_method,method);assert.equal(update.q._id,'user-id');assert.equal(event.method,method);
  assert.equal(event.user_agent.length,512);assert.equal(event.expires_at-now,RETENTION_DAYS*86400000);
  assert.equal(event.password,undefined);assert.equal(event.idToken,undefined);assert.equal(event.user_id,'user-id');
 }
});
test('invalid method fails before persistence and synchronous/asynchronous audit failures are nonfatal',async()=>{
 let count=0,warnings=0;
 const history=createLoginHistory({User:{updateOne(){count++;throw Error('offline');}},LoginEvent:{async create(){count++;throw Error('offline');}},onError:()=>warnings++});
 await assert.rejects(()=>history.record('id',{},'invalid',now));assert.equal(count,0);
 await history.record('id',{},'google',now);assert.equal(count,2);assert.equal(warnings,1);
});
test('history filters expired records even before TTL cleanup and caps output to latest 20',async()=>{
 let query,sort,limit,fields;
 const history=createLoginHistory({User:{},LoginEvent:{find(q){query=q;return {sort(s){sort=s;return this;},limit(n){limit=n;return this;},select(s){fields=s;return this;},async lean(){return [];}};}}});
 assert.deepEqual(await history.list('user-id',now),[]);assert.equal(query.user_id,'user-id');assert.equal(query.expires_at.$gt,now);
 assert.equal(now-query.occurred_at.$gte,30*86400000);assert.equal(limit,HISTORY_LIMIT);assert.equal(limit,20);assert.equal(sort.occurred_at,-1);
 assert.equal(fields,'method occurred_at ip user_agent -_id');
});
test('event schema declares automatic TTL cleanup and restricts stored methods',()=>{
 const Model=require('../src/models/LoginEvent');
 assert.ok(Model.schema.indexes().some(([key,opts])=>key.expires_at===1 && opts.expireAfterSeconds===0));
 assert.deepEqual(Model.schema.path('method').enumValues,['google','password']);
 assert.equal(Model.schema.options.bufferCommands,false);
});

test('login history route requires audit permission even for users with directory access',()=>{
 const router=require('../src/routes/usersRoutes')({authMiddleware:(req,res,next)=>next()});
 const route=router.stack.find(layer=>layer.route?.path==='/users/:id/login-history').route;
 const gate=route.stack.map(layer=>layer.handle).find(handler=>handler.rbacRule);
 assert.deepEqual(gate.rbacRule.codes,['CanViewAuditLog']);
 for(const permissions of [[],['CanViewUsers']]) {
  let status;let passed=false;gate({user:{effective_permissions:permissions}},{status(code){status=code;return this;},json(){}},()=>passed=true);
  assert.equal(status,403);assert.equal(passed,false);
 }
 let passed=false;gate({user:{effective_permissions:['CanViewAuditLog']}},{},()=>passed=true);assert.equal(passed,true);
});
