// Task 3 (lecture discussions API): controller-level tests for
// discussionsController, written BEFORE the controller existed — see
// task-3-report.md for the RED run. Stub style: test/rbacMediaControllers
// .test.js (Mongoose statics stubbed in-process, no database, no Express).
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const DiscussionPost = require('../src/models/DiscussionPost');
const User = require('../src/models/User');
const Video = require('../src/models/Video');
const AuditLog = require('../src/models/AuditLog');
const Role = require('../src/models/Role');
const { DEFAULT_AVATAR_ID } = require('../src/utils/identity');
const { createDiscussionsController } = require('../src/controllers/discussionsController');

const oid = () => new mongoose.Types.ObjectId();

// Chainable, awaitable query stub. `args` records what the controller asked
// for, so sort/limit can be asserted without a database.
function q(value) {
  const chain = {
    args: {},
    sort(arg) { chain.args.sort = arg; return chain; },
    select(arg) { chain.args.select = arg; return chain; },
    limit(arg) { chain.args.limit = arg; return chain; },
    lean: async () => value,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return chain;
}

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

const originals = [];
function stub(obj, key, fn) {
  originals.push([obj, key, obj[key]]);
  obj[key] = fn;
}
test.afterEach(() => {
  while (originals.length) {
    const [obj, key, fn] = originals.pop();
    obj[key] = fn;
  }
});
test.beforeEach(() => {
  stub(AuditLog, 'create', async () => {});
  // Fix round 1: a moderator bypasses playability, so the gate resolves the
  // lecture straight off the Video model. Defaulted here (and User.findById to
  // "no such user", i.e. no notification) so no test can reach a real model.
  stub(Video, 'findById', () => q(LECTURE));
  stub(Video, 'find', () => q([LECTURE]));
  stub(User, 'findById', () => q(null));
});

function makeUser(effective_permissions, extra) {
  return {
    _id: oid(),
    email: 'me@x.com',
    full_name: 'Me Myself',
    role: 'student',
    is_teacher: false,
    subscription_plan: 'free',
    effective_permissions,
    ...extra,
  };
}

const LECTURE = { _id: oid(), title: 'ENT basics' };
const playable = async () => ({ video: LECTURE });

function controller({ loadVideoForPlayback = playable, createNotification = async () => {} } = {}) {
  return createDiscussionsController({ loadVideoForPlayback, createNotification });
}

const reqFor = (user, extra) => ({ user, userId: String(user._id), ...extra });

// --- 1. the gate ---

test('listThread: the gate mirrors playback — a refusal from loadVideoForPlayback is the answer, and posts are never queried', async () => {
  let queried = false;
  stub(DiscussionPost, 'find', () => { queried = true; return q([]); });
  const res = mockRes();
  await controller({ loadVideoForPlayback: async () => ({ error: 'Video not found' }) })
    .listThread(reqFor(makeUser(['CanAccessDiscussions']), { query: { anchor_type: 'lecture', anchor_id: String(LECTURE._id) } }), res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'Video not found');
  assert.equal(queried, false, 'no thread is read for a lecture the caller cannot play');

  // A plan-level refusal keeps its own status, exactly like playback.
  const res2 = mockRes();
  await controller({ loadVideoForPlayback: async () => ({ error: 'Upgrade your plan', status: 403 }) })
    .listThread(reqFor(makeUser(['CanAccessDiscussions']), { query: { anchor_type: 'lecture', anchor_id: String(LECTURE._id) } }), res2);
  assert.equal(res2.statusCode, 403);
  assert.equal(res2.body.error, 'Upgrade your plan');

  // A bogus anchor never reaches the gate.
  let gated = false;
  const res3 = mockRes();
  await controller({ loadVideoForPlayback: async () => { gated = true; return { video: LECTURE }; } })
    .listThread(reqFor(makeUser(['CanAccessDiscussions']), { query: { anchor_type: 'lecture', anchor_id: 'not-an-id' } }), res3);
  assert.equal(res3.statusCode, 400);
  assert.equal(gated, false);
  assert.equal(queried, false);
});

// --- 2. identity projection (spec 4.3) ---

test('listThread: students receive snapshot identities only; moderators receive real_name/email and the hidden posts', async () => {
  const anchorId = String(LECTURE._id);
  const author = { _id: oid(), full_name: 'Asha Rao', email: 'asha@x.com', nickname: 'Ashy' };
  const top = {
    _id: oid(),
    anchor: { type: 'lecture', id: LECTURE._id },
    parent_id: null,
    author_id: author._id,
    author_snapshot: { display_name: 'Ashy', avatar_id: 'avatar-03' },
    is_anonymous: false,
    body: 'Why is the pinna cartilage?',
    video_time: 754,
    created_date: new Date('2026-09-20T10:00:00Z'),
    upvotes: [],
    is_teacher_reply: false,
    is_pinned: false,
  };
  const reply = {
    ...top, _id: oid(), parent_id: top._id, body: 'Elastic cartilage, so it flexes.', video_time: null, is_teacher_reply: true,
  };
  const hidden = {
    ...top,
    _id: oid(),
    parent_id: null,
    body: 'nonsense',
    created_date: new Date('2026-09-21T10:00:00Z'),
    is_hidden: true,
    hidden_reason: 'moderator',
    report_count: 2,
    reports: [{ user_id: oid(), reason: 'spam', at: new Date() }],
  };

  let filter;
  // The rows come back in the query's order (created_date desc); the
  // controller relies on that sort rather than re-sorting in JS.
  let rows = [top, reply];
  stub(DiscussionPost, 'find', (f) => { filter = f; return q(rows); });
  stub(User, 'find', () => q([author]));

  const student = makeUser(['CanAccessDiscussions']);
  const res = mockRes();
  await controller().listThread(reqFor(student, { query: { anchor_type: 'lecture', anchor_id: anchorId } }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(filter['anchor.type'], 'lecture');
  assert.equal(String(filter['anchor.id']), anchorId);
  assert.deepEqual(filter.is_hidden, { $ne: true }, 'hidden posts are filtered in the query for students');
  assert.equal(res.body.muted_until, null);
  assert.equal(res.body.posts.length, 1);
  const first = res.body.posts[0];
  assert.deepEqual(first.identity, { display_name: 'Ashy', avatar_id: 'avatar-03', is_anonymous: false });
  assert.deepEqual(Object.keys(first.identity).sort(), ['avatar_id', 'display_name', 'is_anonymous']);
  assert.equal(first.video_time, 754);
  assert.equal(first.upvote_count, 0);
  assert.equal(first.upvoted_by_me, false);
  assert.equal(first.is_mine, false);
  assert.equal(first.can_edit, false);
  assert.equal(first.is_hidden, undefined, 'moderator-only field');
  assert.equal(first.report_count, undefined, 'moderator-only field');
  assert.equal(first.reply_count, 1);
  assert.equal(first.replies.length, 1);
  assert.equal(first.replies[0].is_teacher_reply, true);
  assert.equal(first.replies[0].identity.email, undefined);

  // The same thread for a moderator: hidden posts included, real identities.
  rows = [hidden, top, reply]; // hidden is the newest top-level post
  const moderator = makeUser(['CanAccessDiscussions', 'CanModerateDiscussions']);
  const res2 = mockRes();
  await controller().listThread(reqFor(moderator, { query: { anchor_type: 'lecture', anchor_id: anchorId } }), res2);
  assert.equal(res2.statusCode, 200, JSON.stringify(res2.body));
  assert.equal(filter.is_hidden, undefined, 'moderators see hidden posts too');
  assert.equal(res2.body.posts.length, 2);
  assert.deepEqual(res2.body.posts.map((p) => p.body), ['nonsense', 'Why is the pinna cartilage?'], 'top level newest first');
  assert.equal(res2.body.posts[0].is_hidden, true);
  assert.equal(res2.body.posts[0].hidden_reason, 'moderator');
  assert.equal(res2.body.posts[0].report_count, 2);
  assert.equal(res2.body.posts[1].identity.real_name, 'Asha Rao');
  assert.equal(res2.body.posts[1].identity.email, 'asha@x.com');
  assert.equal(res2.body.posts[1].identity.author_id, String(author._id));
});

// --- 3. createPost: mute, profanity, length, the happy path ---

test('createPost: 403 with the date while muted; 400 on profanity; 400 outside 2-2000; 201 snapshots the identity and flags a teacher reply', async () => {
  const anchorId = String(LECTURE._id);
  let created = null;
  stub(DiscussionPost, 'create', async (doc) => { created = doc; return { ...doc, _id: oid(), created_date: new Date(), upvotes: [] }; });

  // Muted wins over every other check — even a profane body.
  const until = new Date(Date.now() + 3 * 86400000);
  const muted = makeUser(['CanAccessDiscussions'], { discussion_muted_until: until });
  let res = mockRes();
  await controller().createPost(reqFor(muted, { body: { anchor_type: 'lecture', anchor_id: anchorId, body: 'shit' } }), res);
  assert.equal(res.statusCode, 403);
  assert.ok(res.body.error.includes(`Posting is paused until ${until.toDateString()}`), res.body.error);
  assert.equal(String(res.body.muted_until), String(until));
  assert.equal(created, null);

  // An expired mute does not block.
  const expired = makeUser(['CanAccessDiscussions'], { discussion_muted_until: new Date(Date.now() - 86400000) });
  res = mockRes();
  await controller().createPost(reqFor(expired, { body: { anchor_type: 'lecture', anchor_id: anchorId, body: 'Back with a question.' } }), res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));

  const student = makeUser(['CanAccessDiscussions'], { nickname: 'Ashy', avatar_id: 'avatar-07' });
  created = null;
  res = mockRes();
  await controller().createPost(reqFor(student, { body: { anchor_type: 'lecture', anchor_id: anchorId, body: 'this lecture is shit' } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Please rephrase your post');
  assert.equal(created, null, 'a filtered post is never stored');

  for (const text of ['a', 'x'.repeat(2001)]) {
    res = mockRes();
    await controller().createPost(reqFor(student, { body: { anchor_type: 'lecture', anchor_id: anchorId, body: text } }), res);
    assert.equal(res.statusCode, 400, `${text.length} chars`);
    assert.match(res.body.error, /2 and 2000/);
  }
  assert.equal(created, null);

  const teacher = makeUser(['CanAccessDiscussions', 'CanModerateDiscussions'], {
    full_name: 'Dr Rao', email: 'rao@x.com', nickname: 'DrRao', avatar_id: 'avatar-02',
  });
  res = mockRes();
  await controller().createPost(reqFor(teacher, {
    body: { anchor_type: 'lecture', anchor_id: anchorId, body: 'The pinna is elastic cartilage.', video_time: 91.5 },
  }), res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.deepEqual(created.author_snapshot, { display_name: 'DrRao', avatar_id: 'avatar-02' });
  assert.equal(created.is_teacher_reply, true, 'from CanModerateDiscussions at post time');
  assert.equal(created.parent_id, null);
  assert.equal(created.video_time, 91.5);
  assert.equal(created.anchor.type, 'lecture');
  assert.equal(String(created.anchor.id), anchorId);
  assert.equal(String(created.author_id), String(teacher._id));
  assert.equal(res.body.post.identity.display_name, 'DrRao');
  assert.equal(res.body.post.is_mine, true);
  assert.equal(res.body.post.can_edit, true);

  // video_time belongs to a question, not a reply, and is capped at the
  // lecture's duration when one is known.
  res = mockRes();
  await controller().createPost(reqFor(student, {
    body: { anchor_type: 'lecture', anchor_id: anchorId, parent_id: String(oid()), body: 'A reply.', video_time: 12 },
  }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /only for a new question/);

  created = null;
  res = mockRes();
  await controller({ loadVideoForPlayback: async () => ({ video: { ...LECTURE, duration_seconds: 600 } }) })
    .createPost(reqFor(student, {
      body: { anchor_type: 'lecture', anchor_id: anchorId, body: 'Right at the end.', video_time: 601 },
    }), res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(created.video_time, 600, 'capped at the lecture duration');

  // No nickname, no avatar: first name and the default avatar.
  created = null;
  res = mockRes();
  await controller().createPost(reqFor(makeUser(['CanAccessDiscussions'], { full_name: 'Asha Rao' }), {
    body: { anchor_type: 'lecture', anchor_id: anchorId, body: 'Thanks!', is_anonymous: true },
  }), res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.deepEqual(created.author_snapshot, { display_name: 'Asha', avatar_id: DEFAULT_AVATAR_ID });
  assert.equal(created.is_anonymous, true);
  assert.equal(created.is_teacher_reply, false);
  assert.equal(res.body.post.identity.display_name, 'Anonymous');
});

// --- 4. one level of depth ---

test('createPost: a reply to a reply is re-parented to the top-level post', async () => {
  const anchorId = String(LECTURE._id);
  const top = { _id: oid(), anchor: { type: 'lecture', id: LECTURE._id }, parent_id: null, author_id: oid(), body: 'Q', created_date: new Date() };
  const mid = { _id: oid(), anchor: { type: 'lecture', id: LECTURE._id }, parent_id: top._id, author_id: oid(), body: 'A', created_date: new Date() };
  stub(DiscussionPost, 'findById', (id) => q(String(id) === String(mid._id) ? mid : null));
  let created;
  stub(DiscussionPost, 'create', async (doc) => { created = doc; return { ...doc, _id: oid(), created_date: new Date(), upvotes: [] }; });
  stub(User, 'findById', () => q({ _id: mid.author_id, email: 'parent@x.com', full_name: 'Parent' }));
  const notes = [];
  const res = mockRes();
  await controller({ createNotification: async (n) => { notes.push(n); } }).createPost(reqFor(makeUser(['CanAccessDiscussions']), {
    body: { anchor_type: 'lecture', anchor_id: anchorId, parent_id: String(mid._id), body: 'Following up on that.' },
  }), res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(String(created.parent_id), String(top._id), 'depth is one level: a reply to a reply becomes a sibling');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].userEmail, 'parent@x.com', 'the person actually replied to is the one notified');

  // A parent on another lecture is not a parent at all.
  const res2 = mockRes();
  await controller().createPost(reqFor(makeUser(['CanAccessDiscussions']), {
    body: { anchor_type: 'lecture', anchor_id: String(oid()), parent_id: String(mid._id), body: 'Cross-thread reply.' },
  }), res2);
  assert.equal(res2.statusCode, 404);
});

// --- 5. reply notifications ---

test('createPost: replying notifies the parent author, never yourself, with a Teacher prefix for moderators', async () => {
  const anchorId = String(LECTURE._id);
  const parentAuthor = { _id: oid(), email: 'asha@x.com', full_name: 'Asha Rao' };
  const top = { _id: oid(), anchor: { type: 'lecture', id: LECTURE._id }, parent_id: null, author_id: parentAuthor._id, body: 'Q', created_date: new Date() };
  stub(DiscussionPost, 'findById', () => q(top));
  stub(DiscussionPost, 'create', async (doc) => ({ ...doc, _id: oid(), created_date: new Date(), upvotes: [] }));
  stub(User, 'findById', () => q(parentAuthor));
  const notes = [];
  const c = controller({ createNotification: async (n) => { notes.push(n); } });
  const payload = { anchor_type: 'lecture', anchor_id: anchorId, parent_id: String(top._id), body: 'I have the same question.' };

  await c.createPost(reqFor(makeUser(['CanAccessDiscussions'], { nickname: 'Ashy' }), { body: payload }), mockRes());
  assert.equal(notes.length, 1);
  assert.equal(notes[0].userEmail, 'asha@x.com');
  assert.match(notes[0].message, /Ashy replied to your question on ENT basics/);
  assert.ok(!notes[0].message.startsWith('Teacher'), notes[0].message);
  assert.equal(notes[0].link, `/Videos?lecture=${LECTURE._id}`, 'deep-linked to the lecture the Videos page opens as its watch view');

  notes.length = 0;
  await c.createPost(reqFor(makeUser(['CanAccessDiscussions'], { _id: parentAuthor._id }), { body: payload }), mockRes());
  assert.deepEqual(notes, [], 'replying to yourself notifies nobody');

  notes.length = 0;
  await c.createPost(reqFor(makeUser(['CanAccessDiscussions', 'CanModerateDiscussions'], { nickname: 'DrRao' }), { body: payload }), mockRes());
  assert.equal(notes.length, 1);
  assert.match(notes[0].message, /^Teacher DrRao replied to your question on ENT basics/);
});

// --- 6. upvotes ---

test('toggleUpvote: toggles on and off atomically, and refuses your own post', async () => {
  const me = makeUser(['CanAccessDiscussions']);
  const other = oid();
  let update = null;
  // The count comes back from the stored document ({ new: true }), so the stub
  // applies the operator the controller sent.
  stub(DiscussionPost, 'findByIdAndUpdate', (id, u) => {
    update = u;
    const before = u.$addToSet ? [] : [me._id, other];
    const after = u.$addToSet ? [...before, me._id] : before.filter((x) => String(x) !== String(me._id));
    return q({ _id: id, upvotes: after });
  });

  const mine = { _id: oid(), anchor: { type: 'lecture', id: LECTURE._id }, author_id: me._id, upvotes: [] };
  stub(DiscussionPost, 'findById', () => q(mine));
  let res = mockRes();
  await controller().toggleUpvote(reqFor(me, { params: { id: String(mine._id) } }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /own post/);
  assert.equal(update, null);

  const post = { _id: oid(), anchor: { type: 'lecture', id: LECTURE._id }, author_id: other, upvotes: [] };
  stub(DiscussionPost, 'findById', () => q(post));
  res = mockRes();
  await controller().toggleUpvote(reqFor(me, { params: { id: String(post._id) } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { upvoted: true, upvote_count: 1 });
  assert.ok(update.$addToSet, 'an upvote is an $addToSet');
  assert.equal(String(update.$addToSet.upvotes), String(me._id));

  const again = { _id: post._id, anchor: { type: 'lecture', id: LECTURE._id }, author_id: other, upvotes: [me._id, other] };
  stub(DiscussionPost, 'findById', () => q(again));
  res = mockRes();
  await controller().toggleUpvote(reqFor(me, { params: { id: String(post._id) } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { upvoted: false, upvote_count: 1 });
  assert.ok(update.$pull, 'removing an upvote is a $pull');
});

// --- 7. reports ---

test('reportPost: one report per user; the third distinct reporter hides the post as auto_reports and audits it', async () => {
  const me = makeUser(['CanAccessDiscussions']);
  const r1 = { user_id: oid(), reason: 'spam', at: new Date() };
  const r2 = { user_id: oid(), reason: 'abuse', at: new Date() };
  const post = {
    _id: oid(), anchor: { type: 'lecture', id: LECTURE._id }, author_id: oid(), body: 'junk',
    reports: [r1, r2], report_count: 2, is_hidden: false, upvotes: [],
  };
  let guard = null;
  let pushed = null;
  stub(DiscussionPost, 'findOneAndUpdate', (f, u) => {
    guard = f;
    pushed = u;
    return q({ ...post, reports: [r1, r2, { user_id: me._id, reason: 'abuse', at: new Date() }], report_count: 3 });
  });

  stub(DiscussionPost, 'findById', () => q(post));
  let res = mockRes();
  await controller().reportPost(reqFor(me, { params: { id: String(post._id) }, body: { reason: 'because-i-say-so' } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(pushed, null);

  // Already reported: the guard is IN the update, so Mongo matches nothing and
  // the controller sees null — no read-then-write window.
  const seen = { ...post, reports: [r1, { user_id: me._id, reason: 'spam', at: new Date() }] };
  stub(DiscussionPost, 'findById', () => q(seen));
  stub(DiscussionPost, 'findOneAndUpdate', (f, u) => { guard = f; pushed = u; return q(null); });
  res = mockRes();
  await controller().reportPost(reqFor(me, { params: { id: String(seen._id) }, body: { reason: 'abuse' } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, hidden: false });
  assert.deepEqual(guard['reports.user_id'], { $ne: me._id }, 'one report per user is a condition on the write');

  stub(DiscussionPost, 'findById', () => q(post));
  stub(DiscussionPost, 'findOneAndUpdate', (f, u) => {
    guard = f;
    pushed = u;
    return q({ ...post, reports: [r1, r2, { user_id: me._id, reason: 'abuse', at: new Date() }], report_count: 3 });
  });
  let hide = null;
  stub(DiscussionPost, 'updateOne', async (f, u) => { hide = u; return { modifiedCount: 1 }; });
  stub(DiscussionPost, 'find', () => q([{ created_date: new Date() }]));
  let muted = null;
  stub(User, 'findByIdAndUpdate', (id, u) => { muted = u; return q({ _id: post.author_id, email: 'author@x.com' }); });
  stub(User, 'findById', () => q({ _id: post.author_id, email: 'author@x.com' }));
  const audits = [];
  stub(AuditLog, 'create', async (doc) => { audits.push(doc); });
  const notes = [];
  res = mockRes();
  await controller({ createNotification: async (n) => { notes.push(n); } })
    .reportPost(reqFor(me, { params: { id: String(post._id) }, body: { reason: 'abuse' } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, hidden: true });
  assert.equal(notes.length, 1, 'the author is told their post was hidden');
  assert.equal(notes[0].userEmail, 'author@x.com');
  assert.match(notes[0].message, /hidden after reports/);
  assert.ok(pushed.$push.reports, 'the report is pushed');
  assert.equal(pushed.$inc.report_count, 1, 'report_count moves in the same atomic update');
  assert.equal(hide.$set.is_hidden, true);
  assert.equal(hide.$set.hidden_reason, 'auto_reports');
  assert.deepEqual(audits.map((a) => a.action), ['discussion.hidden']);
  assert.equal(muted, null, 'one hidden post is under the mute threshold');
});

// --- 8. edit window and moderation ---

test('updatePost: the author may edit within 15 minutes and not after; a moderator may pin and hide; a student may not pin', async () => {
  const me = makeUser(['CanAccessDiscussions']);
  // A reply (parent_id set): only a reply can be pinned as the answer.
  const fresh = {
    _id: oid(), anchor: { type: 'lecture', id: LECTURE._id }, parent_id: oid(), author_id: me._id,
    author_snapshot: { display_name: 'Me', avatar_id: 'avatar-01' }, body: 'old body',
    created_date: new Date(Date.now() - 60 * 1000), upvotes: [],
  };
  let set = null;
  stub(DiscussionPost, 'findByIdAndUpdate', (id, u) => { set = u.$set; return q({ ...fresh, ...u.$set }); });
  stub(User, 'find', () => q([]));

  stub(DiscussionPost, 'findById', () => q(fresh));
  let res = mockRes();
  await controller().updatePost(reqFor(me, { params: { id: String(fresh._id) }, body: { body: 'a tidier question' } }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(set.body, 'a tidier question');
  assert.ok(set.edited_at instanceof Date);
  assert.equal(res.body.post.body, 'a tidier question');

  const stale = { ...fresh, created_date: new Date(Date.now() - 20 * 60 * 1000) };
  stub(DiscussionPost, 'findById', () => q(stale));
  set = null;
  res = mockRes();
  await controller().updatePost(reqFor(me, { params: { id: String(stale._id) }, body: { body: 'too late' } }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(set, null);

  res = mockRes();
  await controller().updatePost(reqFor(me, { params: { id: String(stale._id) }, body: { is_pinned: true } }), res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body.required, ['CanModerateDiscussions']);
  assert.equal(set, null);

  const teacher = makeUser(['CanAccessDiscussions', 'CanModerateDiscussions']);
  let unpin = null;
  stub(DiscussionPost, 'updateMany', async (f, u) => { unpin = { f, u }; return { modifiedCount: 1 }; });
  stub(DiscussionPost, 'find', () => q([]));
  res = mockRes();
  await controller().updatePost(reqFor(teacher, { params: { id: String(stale._id) }, body: { is_pinned: true } }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(set.is_pinned, true);
  assert.equal(String(unpin.f['anchor.id']), String(LECTURE._id));
  assert.equal(String(unpin.f.parent_id), String(stale.parent_id), 'the sweep is scoped to the replies of the same question');
  assert.equal(String(unpin.f._id.$ne), String(stale._id), 'the post being pinned is not unpinned by its own sweep');
  assert.deepEqual(unpin.u, { $set: { is_pinned: false } });

  const audits = [];
  stub(AuditLog, 'create', async (d) => { audits.push(d); });
  stub(User, 'findById', () => q({ _id: me._id, email: 'me@x.com' }));
  const notes = [];
  res = mockRes();
  await controller({ createNotification: async (n) => { notes.push(n); } })
    .updatePost(reqFor(teacher, { params: { id: String(stale._id) }, body: { is_hidden: true } }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(set.is_hidden, true);
  assert.equal(set.hidden_reason, 'moderator');
  assert.equal(String(set.hidden_by), String(teacher._id));
  assert.deepEqual(audits.map((a) => a.action), ['discussion.hidden']);
  assert.equal(notes.length, 1);
  assert.match(notes[0].message, /hid your post/);
});

// --- 9. the mute rule through a moderator hide ---

test('updatePost: a moderator hide that is the author third hidden post in 30 days mutes them and says so', async () => {
  const teacher = makeUser(['CanAccessDiscussions', 'CanModerateDiscussions']);
  const authorId = oid();
  const post = {
    _id: oid(), anchor: { type: 'lecture', id: LECTURE._id }, parent_id: null, author_id: authorId,
    body: 'again', created_date: new Date(), upvotes: [],
  };
  stub(DiscussionPost, 'findById', () => q(post));
  stub(DiscussionPost, 'findByIdAndUpdate', (id, u) => q({ ...post, ...u.$set }));
  stub(DiscussionPost, 'updateMany', async () => ({ modifiedCount: 0 }));
  const recent = new Date();
  let hiddenQuery = null;
  stub(DiscussionPost, 'find', (f) => {
    hiddenQuery = f;
    return q([{ created_date: recent }, { created_date: recent }, { created_date: recent }]);
  });
  stub(User, 'find', () => q([{ _id: authorId, full_name: 'Repeat Offender', email: 'ro@x.com' }]));
  stub(User, 'findById', () => q({ _id: authorId, email: 'ro@x.com' }));
  let muteUpdate = null;
  stub(User, 'findByIdAndUpdate', (id, u) => { muteUpdate = { id, u }; return q({ _id: authorId, email: 'ro@x.com' }); });
  const audits = [];
  stub(AuditLog, 'create', async (d) => { audits.push(d); });
  const notes = [];
  const res = mockRes();
  await controller({ createNotification: async (n) => { notes.push(n); } })
    .updatePost(reqFor(teacher, { params: { id: String(post._id) }, body: { is_hidden: true } }), res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(String(hiddenQuery.author_id), String(authorId));
  assert.equal(hiddenQuery.is_hidden, true);
  assert.deepEqual(hiddenQuery.hidden_reason, { $in: ['moderator', 'auto_reports'] });
  assert.equal(String(muteUpdate.id), String(authorId));
  const until = muteUpdate.u.$set.discussion_muted_until;
  assert.ok(until instanceof Date);
  const days = (until.getTime() - Date.now()) / 86400000;
  assert.ok(days > 6.9 && days < 7.1, `muted for about 7 days, got ${days}`);
  assert.deepEqual(audits.map((a) => a.action).sort(), ['discussion.hidden', 'discussion.user_muted']);
  assert.equal(audits.find((a) => a.action === 'discussion.user_muted').after.trigger, 'moderator');
  const mute = notes.find((n) => n.title === 'Posting paused');
  assert.ok(mute, JSON.stringify(notes));
  assert.equal(mute.userEmail, 'ro@x.com');
  assert.ok(mute.message.includes(until.toDateString()), mute.message);
});

// --- 10. the report queue ---

test('listReports: only reported or hidden posts, in queue order, with moderator identities', async () => {
  const moderator = makeUser(['CanModerateDiscussions']);
  const author = { _id: oid(), full_name: 'Asha Rao', email: 'asha@x.com', nickname: 'Ashy' };
  const reports = [{ user_id: oid(), reason: 'abuse', at: new Date() }, { user_id: oid(), reason: 'spam', at: new Date() }];
  const reported = {
    _id: oid(), anchor: { type: 'lecture', id: LECTURE._id }, parent_id: null, author_id: author._id,
    author_snapshot: { display_name: 'Ashy', avatar_id: 'avatar-03' }, body: 'rude',
    created_date: new Date('2026-09-22T10:00:00Z'), upvotes: [], reports, report_count: 2, is_hidden: false,
  };
  const hidden = {
    ...reported, _id: oid(), body: 'hidden one', reports: [], report_count: 0, is_hidden: true,
    hidden_reason: 'moderator', created_date: new Date('2026-09-21T10:00:00Z'),
  };
  let filter;
  let chain;
  stub(DiscussionPost, 'find', (f) => { filter = f; chain = q([reported, hidden]); return chain; });
  stub(User, 'find', () => q([author]));
  // Fix round 2, Critical 3: the lecture titles come from ONE query over the
  // distinct anchor ids, so the queue page no longer loads /videos?all=true.
  let lectureFilter;
  let lectureChain;
  stub(Video, 'find', (f) => { lectureFilter = f; lectureChain = q([LECTURE]); return lectureChain; });

  const res = mockRes();
  await controller().listReports(reqFor(moderator, { query: {} }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(filter, { $or: [{ report_count: { $gt: 0 } }, { is_hidden: true }] });
  assert.deepEqual(chain.args.sort, { report_count: -1, created_date: -1 });
  assert.equal(chain.args.limit, 200);
  assert.equal(res.body.posts.length, 2);
  assert.equal(res.body.posts[0].report_count, 2);
  assert.deepEqual(res.body.posts[0].reports.map((r) => r.reason), ['abuse', 'spam']);
  assert.equal(res.body.posts[0].identity.real_name, 'Asha Rao');
  assert.equal(res.body.posts[0].identity.email, 'asha@x.com');
  assert.equal(res.body.posts[0].identity.display_name, 'Ashy');
  assert.equal(String(res.body.posts[0].anchor.id), String(LECTURE._id));
  assert.equal(res.body.posts[1].is_hidden, true);
  assert.equal(res.body.posts[1].hidden_reason, 'moderator');
  assert.deepEqual(lectureFilter, { _id: { $in: [String(LECTURE._id)] } }, 'one query, over the DISTINCT anchor ids');
  assert.equal(lectureChain.args.select, 'title');
  assert.equal(res.body.posts[0].anchor_label, 'ENT basics');
  assert.equal(res.body.posts[1].anchor_label, 'ENT basics');
});

// --- 11. fix round 1, Critical 1: the by-id routes are gated too ---

test('the by-id routes run the same lecture gate: a caller who cannot play the lecture cannot upvote, report or edit its posts', async () => {
  const me = makeUser(['CanAccessDiscussions']);
  const post = {
    _id: oid(), anchor: { type: 'lecture', id: LECTURE._id }, parent_id: null, author_id: oid(),
    body: 'Q', created_date: new Date(), upvotes: [], reports: [],
  };
  const mine = { ...post, author_id: me._id };
  let writes = 0;
  stub(DiscussionPost, 'findByIdAndUpdate', () => { writes += 1; return q(post); });
  stub(DiscussionPost, 'findOneAndUpdate', () => { writes += 1; return q(post); });
  stub(DiscussionPost, 'updateOne', async () => { writes += 1; return { modifiedCount: 1 }; });
  stub(DiscussionPost, 'updateMany', async () => { writes += 1; return { modifiedCount: 1 }; });
  const refused = controller({ loadVideoForPlayback: async () => ({ error: 'Video not found' }) });

  stub(DiscussionPost, 'findById', () => q(post));
  let res = mockRes();
  await refused.toggleUpvote(reqFor(me, { params: { id: String(post._id) } }), res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'Video not found');

  res = mockRes();
  await refused.reportPost(reqFor(me, { params: { id: String(post._id) }, body: { reason: 'spam' } }), res);
  assert.equal(res.statusCode, 404, 'three reporters on a lecture they cannot see must not be able to auto-hide a post');

  stub(DiscussionPost, 'findById', () => q(mine));
  res = mockRes();
  await refused.updatePost(reqFor(me, { params: { id: String(mine._id) }, body: { body: 'a sneaky edit' } }), res);
  assert.equal(res.statusCode, 404);

  assert.equal(writes, 0, 'nothing is written by any of the three');

  // A plan-level refusal keeps its own status here too.
  stub(DiscussionPost, 'findById', () => q(post));
  res = mockRes();
  await controller({ loadVideoForPlayback: async () => ({ error: 'Upgrade your plan', status: 403 }) })
    .toggleUpvote(reqFor(me, { params: { id: String(post._id) } }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'Upgrade your plan');
  assert.equal(writes, 0);
});

// --- 12. fix round 1 ruling: moderators bypass playability, not existence ---

test('the gate lets a moderator through without CanViewVideos: playability is never consulted, the lecture only has to exist', async () => {
  const moderator = makeUser(['CanModerateDiscussions']); // a manage_doubts role: no CanViewVideos
  let playbackCalls = 0;
  const c = controller({ loadVideoForPlayback: async () => { playbackCalls += 1; return { error: 'Video not found' }; } });
  stub(DiscussionPost, 'find', () => q([]));
  stub(User, 'find', () => q([]));

  let res = mockRes();
  await c.listThread(reqFor(moderator, { query: { anchor_type: 'lecture', anchor_id: String(LECTURE._id) } }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(playbackCalls, 0, 'moderation is not playback');

  const post = {
    _id: oid(), anchor: { type: 'lecture', id: LECTURE._id }, parent_id: oid(), author_id: oid(),
    body: 'x', created_date: new Date(), upvotes: [],
  };
  stub(DiscussionPost, 'findById', () => q(post));
  stub(DiscussionPost, 'findByIdAndUpdate', (id, u) => q({ ...post, ...u.$set }));
  stub(DiscussionPost, 'updateMany', async () => ({ modifiedCount: 0 }));
  res = mockRes();
  await c.updatePost(reqFor(moderator, { params: { id: String(post._id) }, body: { is_pinned: true } }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(playbackCalls, 0);

  // A lecture that no longer exists still 404s, moderator or not.
  stub(Video, 'findById', () => q(null));
  res = mockRes();
  await c.listThread(reqFor(moderator, { query: { anchor_type: 'lecture', anchor_id: String(LECTURE._id) } }), res);
  assert.equal(res.statusCode, 404);
});

// --- 13. fix round 1, Important 1: the mute is announced once ---

test('maybeMute: a further hide while the author is already muted neither extends the mute nor notifies again', async () => {
  const teacher = makeUser(['CanAccessDiscussions', 'CanModerateDiscussions']);
  const authorId = oid();
  const post = {
    _id: oid(), anchor: { type: 'lecture', id: LECTURE._id }, parent_id: null, author_id: authorId,
    body: 'again', created_date: new Date(), upvotes: [],
  };
  stub(DiscussionPost, 'findById', () => q(post));
  stub(DiscussionPost, 'findByIdAndUpdate', (id, u) => q({ ...post, ...u.$set }));
  let hiddenLookups = 0;
  stub(DiscussionPost, 'find', () => {
    hiddenLookups += 1;
    return q([{ created_date: new Date() }, { created_date: new Date() }, { created_date: new Date() }]);
  });
  stub(User, 'find', () => q([]));
  stub(User, 'findById', () => q({ _id: authorId, email: 'ro@x.com', discussion_muted_until: new Date(Date.now() + 5 * 86400000) }));
  let muteWrites = 0;
  stub(User, 'findByIdAndUpdate', () => { muteWrites += 1; return q({}); });
  const audits = [];
  stub(AuditLog, 'create', async (d) => { audits.push(d); });
  const notes = [];
  const res = mockRes();
  await controller({ createNotification: async (n) => { notes.push(n); } })
    .updatePost(reqFor(teacher, { params: { id: String(post._id) }, body: { is_hidden: true } }), res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(muteWrites, 0, 'an active mute is never extended');
  assert.equal(hiddenLookups, 0, 'the hidden-post count is not even asked for');
  assert.deepEqual(audits.map((a) => a.action), ['discussion.hidden'], 'no second discussion.user_muted row');
  assert.deepEqual(notes.map((n) => n.title), ['Your post was hidden'], 'no second Posting paused notification');
});

// --- 14. fix round 1, Important 2: pinning is audited ---

test('updatePost: pinning and unpinning are audited, and a no-op pin writes no row', async () => {
  const teacher = makeUser(['CanAccessDiscussions', 'CanModerateDiscussions']);
  const post = {
    _id: oid(), anchor: { type: 'lecture', id: LECTURE._id }, parent_id: oid(), author_id: oid(),
    body: 'the answer', created_date: new Date(), upvotes: [], is_pinned: false,
  };
  stub(DiscussionPost, 'findByIdAndUpdate', (id, u) => q({ ...post, ...u.$set }));
  stub(DiscussionPost, 'updateMany', async () => ({ modifiedCount: 0 }));
  stub(User, 'find', () => q([]));
  const audits = [];
  stub(AuditLog, 'create', async (d) => { audits.push(d); });

  stub(DiscussionPost, 'findById', () => q(post));
  let res = mockRes();
  await controller().updatePost(reqFor(teacher, { params: { id: String(post._id) }, body: { is_pinned: true } }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'discussion.pinned');
  assert.equal(audits[0].target_type, 'discussion_post');
  assert.equal(audits[0].target_id, String(post._id));
  assert.equal(audits[0].target_label, 'ENT basics', 'the lecture the pinned answer belongs to');
  assert.deepEqual(audits[0].before, { is_pinned: false });
  assert.deepEqual(audits[0].after, { is_pinned: true });

  audits.length = 0;
  stub(DiscussionPost, 'findById', () => q({ ...post, is_pinned: true }));
  res = mockRes();
  await controller().updatePost(reqFor(teacher, { params: { id: String(post._id) }, body: { is_pinned: false } }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(audits.map((a) => a.action), ['discussion.unpinned']);

  audits.length = 0;
  res = mockRes();
  await controller().updatePost(reqFor(teacher, { params: { id: String(post._id) }, body: { is_pinned: true } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(audits, [], 'pinning an already pinned post changes nothing to record');
});

// --- 15. fix round 2, Critical 1: a mute must be liftable ---

test('updatePost: unhiding a post that takes its author back under the threshold clears the mute', async () => {
  const teacher = makeUser(['CanAccessDiscussions', 'CanModerateDiscussions']);
  const authorId = oid();
  const post = {
    _id: oid(), anchor: { type: 'lecture', id: LECTURE._id }, parent_id: null, author_id: authorId,
    body: 'reinstated', created_date: new Date(), upvotes: [], is_hidden: true, hidden_reason: 'moderator',
  };
  stub(DiscussionPost, 'findById', () => q(post));
  stub(DiscussionPost, 'findByIdAndUpdate', (id, u) => q({ ...post, ...u.$set }));
  // After the unhide only two hidden posts remain in the 30-day window.
  let recountFilter = null;
  stub(DiscussionPost, 'find', (f) => {
    recountFilter = f;
    return q([{ created_date: new Date() }, { created_date: new Date() }]);
  });
  stub(User, 'find', () => q([]));
  stub(User, 'findById', () => q({ _id: authorId, email: 'ro@x.com', discussion_muted_until: new Date(Date.now() + 5 * 86400000) }));
  let muteWrite = null;
  stub(User, 'findByIdAndUpdate', (id, u) => { muteWrite = { id, u }; return q({ _id: authorId }); });
  const audits = [];
  stub(AuditLog, 'create', async (d) => { audits.push(d); });
  const notes = [];
  const res = mockRes();
  await controller({ createNotification: async (n) => { notes.push(n); } })
    .updatePost(reqFor(teacher, { params: { id: String(post._id) }, body: { is_hidden: false } }), res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(String(recountFilter.author_id), String(authorId));
  assert.equal(recountFilter.is_hidden, true, 'the recount asks for the hidden posts that are left');
  assert.equal(String(muteWrite.id), String(authorId));
  assert.deepEqual(muteWrite.u, { $unset: { discussion_muted_until: '' } });
  assert.deepEqual(audits.map((a) => a.action), ['discussion.unhidden'], 'no extra audit row beyond the unhide');
  assert.deepEqual(notes, [], 'lifting the mute is not announced');
});

test('updatePost: unhiding a post whose author is STILL over the threshold leaves the mute alone', async () => {
  const teacher = makeUser(['CanAccessDiscussions', 'CanModerateDiscussions']);
  const authorId = oid();
  const post = {
    _id: oid(), anchor: { type: 'lecture', id: LECTURE._id }, parent_id: null, author_id: authorId,
    body: 'still out of line', created_date: new Date(), upvotes: [], is_hidden: true, hidden_reason: 'moderator',
  };
  stub(DiscussionPost, 'findById', () => q(post));
  stub(DiscussionPost, 'findByIdAndUpdate', (id, u) => q({ ...post, ...u.$set }));
  const recent = new Date();
  stub(DiscussionPost, 'find', () => q([{ created_date: recent }, { created_date: recent }, { created_date: recent }]));
  stub(User, 'find', () => q([]));
  stub(User, 'findById', () => q({ _id: authorId, email: 'ro@x.com', discussion_muted_until: new Date(Date.now() + 5 * 86400000) }));
  let muteWrites = 0;
  stub(User, 'findByIdAndUpdate', () => { muteWrites += 1; return q({}); });
  const res = mockRes();
  await controller().updatePost(reqFor(teacher, { params: { id: String(post._id) }, body: { is_hidden: false } }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(muteWrites, 0, 'three hidden posts are still three hidden posts');
});

// --- 16. fix round 2, Critical 2: staff are exempt from crowd moderation ---

test('reportPost: a third report on a teacher reply is recorded but never auto-hides it', async () => {
  const me = makeUser(['CanAccessDiscussions']);
  const r1 = { user_id: oid(), reason: 'wrong', at: new Date() };
  const r2 = { user_id: oid(), reason: 'wrong', at: new Date() };
  const post = {
    _id: oid(), anchor: { type: 'lecture', id: LECTURE._id }, author_id: oid(), body: 'The answer is elastic cartilage.',
    reports: [r1, r2], report_count: 2, is_hidden: false, is_teacher_reply: true, upvotes: [],
  };
  let pushed = null;
  stub(DiscussionPost, 'findById', () => q(post));
  stub(DiscussionPost, 'findOneAndUpdate', (f, u) => {
    pushed = u;
    return q({ ...post, reports: [r1, r2, { user_id: me._id, reason: 'wrong', at: new Date() }], report_count: 3 });
  });
  let hides = 0;
  stub(DiscussionPost, 'updateOne', async () => { hides += 1; return { modifiedCount: 1 }; });
  const audits = [];
  stub(AuditLog, 'create', async (d) => { audits.push(d); });
  const notes = [];
  const res = mockRes();
  await controller({ createNotification: async (n) => { notes.push(n); } })
    .reportPost(reqFor(me, { params: { id: String(post._id) }, body: { reason: 'wrong' } }), res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { ok: true, hidden: false });
  assert.ok(pushed.$push.reports, 'the report is still recorded for the queue');
  assert.equal(hides, 0, 'a teacher reply is never hidden by the crowd');
  assert.deepEqual(audits, []);
  assert.deepEqual(notes, []);
});

test('maybeMute: an author who holds CanModerateDiscussions is never muted', async () => {
  const teacher = makeUser(['CanAccessDiscussions', 'CanModerateDiscussions']);
  const authorId = oid();
  const post = {
    _id: oid(), anchor: { type: 'lecture', id: LECTURE._id }, parent_id: null, author_id: authorId,
    body: 'a blunt answer', created_date: new Date(), upvotes: [],
  };
  stub(DiscussionPost, 'findById', () => q(post));
  stub(DiscussionPost, 'findByIdAndUpdate', (id, u) => q({ ...post, ...u.$set }));
  stub(DiscussionPost, 'find', () => q([{ created_date: new Date() }, { created_date: new Date() }, { created_date: new Date() }]));
  stub(User, 'find', () => q([]));
  // The author is a teacher: the role document carries CanModerateDiscussions.
  stub(User, 'findById', () => q({ _id: authorId, email: 'rao@x.com', roles: ['teacher'] }));
  stub(Role, 'find', () => q([{ name: 'teacher', is_active: true, permissions: ['CanAccessDiscussions', 'CanModerateDiscussions'] }]));
  let muteWrites = 0;
  stub(User, 'findByIdAndUpdate', () => { muteWrites += 1; return q({}); });
  const audits = [];
  stub(AuditLog, 'create', async (d) => { audits.push(d); });
  const notes = [];
  const res = mockRes();
  await controller({ createNotification: async (n) => { notes.push(n); } })
    .updatePost(reqFor(teacher, { params: { id: String(post._id) }, body: { is_hidden: true } }), res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(muteWrites, 0, 'a moderator is never muted by the mute rule');
  assert.deepEqual(audits.map((a) => a.action), ['discussion.hidden'], 'no discussion.user_muted row');
  assert.deepEqual(notes.map((n) => n.title), ['Your post was hidden']);
});

// --- 17. fix round 2, Critical 3: Dismiss ---

test('updatePost: dismiss_reports on an auto-hidden post unhides it, moves the reports and audits the decision', async () => {
  const teacher = makeUser(['CanAccessDiscussions', 'CanModerateDiscussions']);
  const authorId = oid();
  const reports = [
    { user_id: oid(), reason: 'wrong', at: new Date('2026-09-25T10:00:00Z') },
    { user_id: oid(), reason: 'spam', at: new Date('2026-09-25T11:00:00Z') },
    { user_id: oid(), reason: 'spam', at: new Date('2026-09-25T12:00:00Z') },
  ];
  const post = {
    _id: oid(), anchor: { type: 'lecture', id: LECTURE._id }, parent_id: null, author_id: authorId,
    body: 'a fair question the crowd disliked', created_date: new Date(), upvotes: [],
    reports, report_count: 3, is_hidden: true, hidden_reason: 'auto_reports', hidden_by: null,
  };
  let ops = null;
  stub(DiscussionPost, 'findById', () => q(post));
  stub(DiscussionPost, 'findByIdAndUpdate', (id, u) => { ops = u; return q({ ...post, ...u.$set }); });
  stub(DiscussionPost, 'find', () => q([]));
  stub(User, 'find', () => q([]));
  stub(User, 'findById', () => q({ _id: authorId, email: 'ro@x.com', discussion_muted_until: new Date(Date.now() + 5 * 86400000) }));
  let muteWrite = null;
  stub(User, 'findByIdAndUpdate', (id, u) => { muteWrite = u; return q({}); });
  const audits = [];
  stub(AuditLog, 'create', async (d) => { audits.push(d); });
  const notes = [];
  const res = mockRes();
  await controller({ createNotification: async (n) => { notes.push(n); } })
    .updatePost(reqFor(teacher, { params: { id: String(post._id) }, body: { dismiss_reports: true } }), res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(ops.$set.reports, [], 'the active reports are gone');
  assert.equal(ops.$set.report_count, 0);
  assert.equal(ops.$set.is_hidden, false, 'a crowd hide is reversed by dismissing the crowd');
  assert.equal(ops.$set.hidden_reason, '');
  assert.deepEqual(ops.$unset, { hidden_by: '' });
  assert.equal(Object.prototype.hasOwnProperty.call(ops.$set, 'hidden_by'), false, '$set and $unset must not name the same path');
  const moved = ops.$push.dismissed_reports.$each;
  assert.equal(moved.length, 3);
  assert.deepEqual(moved.map((r) => r.reason), ['wrong', 'spam', 'spam']);
  assert.deepEqual(moved.map((r) => String(r.user_id)), reports.map((r) => String(r.user_id)));
  moved.forEach((r) => assert.ok(r.dismissed_at instanceof Date, 'each moved report is stamped'));
  const row = audits.find((a) => a.action === 'discussion.reports_dismissed');
  assert.ok(row, JSON.stringify(audits.map((a) => a.action)));
  assert.equal(row.target_type, 'discussion_post');
  assert.equal(String(row.target_id), String(post._id));
  assert.equal(row.before.report_count, 3);
  assert.equal(row.before.is_hidden, true);
  assert.equal(row.before.hidden_reason, 'auto_reports');
  assert.equal(row.before.reports.length, 3);
  // Critical 1 again: the post is back up, so the author may be under the
  // mute threshold — the recount runs from here too.
  assert.deepEqual(muteWrite, { $unset: { discussion_muted_until: '' } });
  assert.deepEqual(notes, []);
});

test('updatePost: dismiss_reports on a post a MODERATOR hid clears the reports but keeps it hidden', async () => {
  const teacher = makeUser(['CanAccessDiscussions', 'CanModerateDiscussions']);
  const post = {
    _id: oid(), anchor: { type: 'lecture', id: LECTURE._id }, parent_id: null, author_id: oid(),
    body: 'hidden by hand', created_date: new Date(), upvotes: [],
    reports: [{ user_id: oid(), reason: 'abuse', at: new Date() }], report_count: 1,
    is_hidden: true, hidden_reason: 'moderator',
  };
  let ops = null;
  stub(DiscussionPost, 'findById', () => q(post));
  stub(DiscussionPost, 'findByIdAndUpdate', (id, u) => { ops = u; return q({ ...post, ...u.$set }); });
  stub(DiscussionPost, 'find', () => q([]));
  stub(User, 'find', () => q([]));
  stub(User, 'findById', () => q({ _id: post.author_id, email: 'a@x.com' }));
  const res = mockRes();
  await controller().updatePost(reqFor(teacher, { params: { id: String(post._id) }, body: { dismiss_reports: true } }), res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(ops.$set.reports, []);
  assert.equal(ops.$set.report_count, 0);
  assert.equal(Object.prototype.hasOwnProperty.call(ops.$set, 'is_hidden'), false, 'a moderator hide is not reversed by a dismiss');
  assert.equal(ops.$unset, undefined);
  assert.equal(res.body.post.is_hidden, true);
});

test('reportPost: a reporter whose report was dismissed cannot report the post again', async () => {
  const me = makeUser(['CanAccessDiscussions']);
  const post = {
    _id: oid(), anchor: { type: 'lecture', id: LECTURE._id }, author_id: oid(), body: 'cleared once',
    reports: [], report_count: 0, is_hidden: false, upvotes: [],
    dismissed_reports: [{ user_id: me._id, reason: 'spam', at: new Date(), dismissed_at: new Date() }],
  };
  let guard = null;
  stub(DiscussionPost, 'findById', () => q(post));
  // The guard is part of the write, so Mongo matches nothing and the
  // controller sees null — the same idempotent answer as a repeat report.
  stub(DiscussionPost, 'findOneAndUpdate', (f) => { guard = f; return q(null); });
  let hides = 0;
  stub(DiscussionPost, 'updateOne', async () => { hides += 1; return { modifiedCount: 1 }; });
  const res = mockRes();
  await controller().reportPost(reqFor(me, { params: { id: String(post._id) }, body: { reason: 'spam' } }), res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { ok: true, hidden: false });
  assert.deepEqual(guard['dismissed_reports.user_id'], { $ne: me._id }, 'a dismissed reporter cannot re-trip the auto-hide');
  assert.deepEqual(guard['reports.user_id'], { $ne: me._id });
  assert.equal(hides, 0);
});

test('updatePost: a student sending dismiss_reports is refused 403 and nothing is written', async () => {
  const me = makeUser(['CanAccessDiscussions']);
  const post = {
    _id: oid(), anchor: { type: 'lecture', id: LECTURE._id }, parent_id: null, author_id: me._id,
    body: 'mine', created_date: new Date(), upvotes: [], reports: [{ user_id: oid(), reason: 'spam', at: new Date() }],
    report_count: 1,
  };
  stub(DiscussionPost, 'findById', () => q(post));
  let writes = 0;
  stub(DiscussionPost, 'findByIdAndUpdate', () => { writes += 1; return q(post); });
  const res = mockRes();
  await controller().updatePost(reqFor(me, { params: { id: String(post._id) }, body: { dismiss_reports: true } }), res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body.required, ['CanModerateDiscussions']);
  assert.equal(writes, 0);
});

// --- 18. fix round 2, Important 1: the pin is per question, reply-only ---

test('updatePost: pinning a reply only unpins the other replies to the SAME question; a top-level post cannot be pinned', async () => {
  const teacher = makeUser(['CanAccessDiscussions', 'CanModerateDiscussions']);
  const q2 = oid();
  const reply = {
    _id: oid(), anchor: { type: 'lecture', id: LECTURE._id }, parent_id: q2, author_id: oid(),
    body: 'the answer to Q2', created_date: new Date(), upvotes: [], is_pinned: false,
  };
  let sweep = null;
  stub(DiscussionPost, 'findById', () => q(reply));
  stub(DiscussionPost, 'findByIdAndUpdate', (id, u) => q({ ...reply, ...u.$set }));
  stub(DiscussionPost, 'updateMany', async (f, u) => { sweep = { f, u }; return { modifiedCount: 1 }; });
  stub(User, 'find', () => q([]));
  let res = mockRes();
  await controller().updatePost(reqFor(teacher, { params: { id: String(reply._id) }, body: { is_pinned: true } }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(String(sweep.f.parent_id), String(q2), "Q1's pinned answer is outside this filter");
  assert.equal(String(sweep.f['anchor.id']), String(LECTURE._id));
  assert.equal(sweep.f.is_pinned, true);
  assert.deepEqual(sweep.u, { $set: { is_pinned: false } });

  // A question is not its own answer.
  const top = { ...reply, _id: oid(), parent_id: null };
  stub(DiscussionPost, 'findById', () => q(top));
  sweep = null;
  res = mockRes();
  await controller().updatePost(reqFor(teacher, { params: { id: String(top._id) }, body: { is_pinned: true } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Only a reply can be pinned as the answer');
  assert.equal(sweep, null, 'nothing is unpinned by a refused pin');

  // A hidden reply cannot be promoted to the top of the thread either.
  const hiddenReply = { ...reply, _id: oid(), is_hidden: true, hidden_reason: 'moderator' };
  stub(DiscussionPost, 'findById', () => q(hiddenReply));
  res = mockRes();
  await controller().updatePost(reqFor(teacher, { params: { id: String(hiddenReply._id) }, body: { is_pinned: true } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'A hidden post cannot be pinned');
  assert.equal(sweep, null);
});

// --- 19. fix round 2, Minors ---

test('updatePost: the author cannot edit a post that has been hidden', async () => {
  const me = makeUser(['CanAccessDiscussions']);
  const post = {
    _id: oid(), anchor: { type: 'lecture', id: LECTURE._id }, parent_id: null, author_id: me._id,
    body: 'the original', created_date: new Date(), upvotes: [], is_hidden: true, hidden_reason: 'moderator',
  };
  stub(DiscussionPost, 'findById', () => q(post));
  let writes = 0;
  stub(DiscussionPost, 'findByIdAndUpdate', () => { writes += 1; return q(post); });
  const res = mockRes();
  await controller().updatePost(reqFor(me, { params: { id: String(post._id) }, body: { body: 'a rewritten version' } }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'This post is hidden');
  assert.equal(writes, 0);
});

test('createPost: a reply to a reply notifies BOTH the person answered and the author of the question, once each', async () => {
  const anchorId = String(LECTURE._id);
  const asker = oid();
  const answerer = oid();
  const top = { _id: oid(), anchor: { type: 'lecture', id: LECTURE._id }, parent_id: null, author_id: asker, body: 'Q', created_date: new Date() };
  const mid = { _id: oid(), anchor: { type: 'lecture', id: LECTURE._id }, parent_id: top._id, author_id: answerer, body: 'A', created_date: new Date() };
  const byId = new Map([[String(top._id), top], [String(mid._id), mid]]);
  stub(DiscussionPost, 'findById', (id) => q(byId.get(String(id)) || null));
  stub(DiscussionPost, 'create', async (doc) => ({ ...doc, _id: oid(), created_date: new Date(), upvotes: [] }));
  const emails = new Map([[String(asker), 'asker@x.com'], [String(answerer), 'answerer@x.com']]);
  stub(User, 'findById', (id) => q({ _id: id, email: emails.get(String(id)) }));
  const notes = [];
  const res = mockRes();
  await controller({ createNotification: async (n) => { notes.push(n); } }).createPost(reqFor(makeUser(['CanAccessDiscussions'], { nickname: 'Third' }), {
    body: { anchor_type: 'lecture', anchor_id: anchorId, parent_id: String(mid._id), body: 'Same doubt here.' },
  }), res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.deepEqual(notes.map((n) => n.userEmail).sort(), ['answerer@x.com', 'asker@x.com']);

  // The asker replying in their own thread is told nothing twice, and never
  // about their own reply: only the person they answered hears about it.
  notes.length = 0;
  const res2 = mockRes();
  await controller({ createNotification: async (n) => { notes.push(n); } }).createPost(reqFor(makeUser(['CanAccessDiscussions'], { _id: asker }), {
    body: { anchor_type: 'lecture', anchor_id: anchorId, parent_id: String(mid._id), body: 'Thanks, one more thing.' },
  }), res2);
  assert.equal(res2.statusCode, 201, JSON.stringify(res2.body));
  assert.deepEqual(notes.map((n) => n.userEmail), ['answerer@x.com']);

  // And the answerer replying to their own reply under someone else's
  // question notifies the asker only.
  notes.length = 0;
  const res3 = mockRes();
  await controller({ createNotification: async (n) => { notes.push(n); } }).createPost(reqFor(makeUser(['CanAccessDiscussions'], { _id: answerer }), {
    body: { anchor_type: 'lecture', anchor_id: anchorId, parent_id: String(mid._id), body: 'To add to that...' },
  }), res3);
  assert.equal(res3.statusCode, 201, JSON.stringify(res3.body));
  assert.deepEqual(notes.map((n) => n.userEmail), ['asker@x.com']);
});
