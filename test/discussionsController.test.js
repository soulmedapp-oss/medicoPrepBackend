// Task 3 (lecture discussions API): controller-level tests for
// discussionsController, written BEFORE the controller existed — see
// task-3-report.md for the RED run. Stub style: test/rbacMediaControllers
// .test.js (Mongoose statics stubbed in-process, no database, no Express).
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const DiscussionPost = require('../src/models/DiscussionPost');
const User = require('../src/models/User');
const AuditLog = require('../src/models/AuditLog');
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
  let rows = [reply, top]; // deliberately not in display order
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
  rows = [reply, top, hidden];
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
  assert.equal(notes[0].link, '/Videos');

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
  stub(DiscussionPost, 'updateOne', async (filter, u) => { update = u; return { modifiedCount: 1 }; });

  const mine = { _id: oid(), author_id: me._id, upvotes: [] };
  stub(DiscussionPost, 'findById', () => q(mine));
  let res = mockRes();
  await controller().toggleUpvote(reqFor(me, { params: { id: String(mine._id) } }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /own post/);
  assert.equal(update, null);

  const post = { _id: oid(), author_id: other, upvotes: [] };
  stub(DiscussionPost, 'findById', () => q(post));
  res = mockRes();
  await controller().toggleUpvote(reqFor(me, { params: { id: String(post._id) } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { upvoted: true, upvote_count: 1 });
  assert.ok(update.$addToSet, 'an upvote is an $addToSet');
  assert.equal(String(update.$addToSet.upvotes), String(me._id));

  const again = { _id: post._id, author_id: other, upvotes: [me._id, other] };
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
  let pushed = null;
  stub(DiscussionPost, 'findByIdAndUpdate', (id, u) => {
    pushed = u;
    return q({ ...post, reports: [r1, r2, { user_id: me._id, reason: 'abuse', at: new Date() }], report_count: 3 });
  });

  stub(DiscussionPost, 'findById', () => q(post));
  let res = mockRes();
  await controller().reportPost(reqFor(me, { params: { id: String(post._id) }, body: { reason: 'because-i-say-so' } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(pushed, null);

  const seen = { ...post, reports: [r1, { user_id: me._id, reason: 'spam', at: new Date() }] };
  stub(DiscussionPost, 'findById', () => q(seen));
  res = mockRes();
  await controller().reportPost(reqFor(me, { params: { id: String(seen._id) }, body: { reason: 'abuse' } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, hidden: false });
  assert.equal(pushed, null, 'a second report from the same user writes nothing');

  stub(DiscussionPost, 'findById', () => q(post));
  let hide = null;
  stub(DiscussionPost, 'updateOne', async (f, u) => { hide = u; return { modifiedCount: 1 }; });
  stub(DiscussionPost, 'find', () => q([{ created_date: new Date() }]));
  let muted = null;
  stub(User, 'findByIdAndUpdate', (id, u) => { muted = u; return q({ _id: post.author_id, email: 'author@x.com' }); });
  const audits = [];
  stub(AuditLog, 'create', async (doc) => { audits.push(doc); });
  res = mockRes();
  await controller().reportPost(reqFor(me, { params: { id: String(post._id) }, body: { reason: 'abuse' } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, hidden: true });
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
  const fresh = {
    _id: oid(), anchor: { type: 'lecture', id: LECTURE._id }, parent_id: null, author_id: me._id,
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
});
