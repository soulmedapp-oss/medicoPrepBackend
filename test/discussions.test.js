const test = require('node:test');
const assert = require('node:assert/strict');
const {
  displayIdentity, sortThread, canEditPost, shouldAutoHide, nextMuteUntil,
  EDIT_WINDOW_MS, MUTE_DAYS,
} = require('../src/utils/discussions');

const post = (over = {}) => ({ _id: 'p1', author_id: 'u1', author_snapshot: { display_name: 'Dr Neuron', avatar_id: 'avatar-03' }, is_anonymous: false, ...over });
const author = { _id: 'u1', full_name: 'Anand Pandey', email: 'a@x.com', nickname: 'Dr Neuron' };

test('displayIdentity: a student sees the snapshot and never the author id, name or email', () => {
  const out = displayIdentity(post(), { viewerIsModerator: false, author });
  assert.deepEqual(out, { display_name: 'Dr Neuron', avatar_id: 'avatar-03', is_anonymous: false });
});
test('displayIdentity: anonymous post -> student sees Anonymous + default avatar only', () => {
  const out = displayIdentity(post({ is_anonymous: true }), { viewerIsModerator: false, author });
  assert.deepEqual(out, { display_name: 'Anonymous', avatar_id: 'avatar-default', is_anonymous: true });
});
test('displayIdentity: a moderator always gets real_name and email, even on anonymous posts', () => {
  const out = displayIdentity(post({ is_anonymous: true }), { viewerIsModerator: true, author });
  assert.equal(out.display_name, 'Anonymous');
  assert.equal(out.real_name, 'Anand Pandey');
  assert.equal(out.email, 'a@x.com');
  assert.equal(out.author_id, 'u1');
  assert.equal(out.nickname, 'Dr Neuron');
});

test('sortThread: pinned first, then teacher replies, then most upvoted, then oldest', () => {
  const mk = (id, o) => ({ _id: id, created_date: new Date(2026, 0, o.day || 1), upvotes: Array(o.up || 0).fill('x'), is_pinned: !!o.pin, is_teacher_reply: !!o.t });
  const sorted = sortThread([mk('old', { day: 1 }), mk('up', { day: 2, up: 5 }), mk('teacher', { day: 3, t: true }), mk('pinned', { day: 4, pin: true }), mk('new', { day: 5 })]);
  assert.deepEqual(sorted.map((p) => p._id), ['pinned', 'teacher', 'up', 'old', 'new']);
});

test('canEditPost: own post within 15 minutes only', () => {
  const now = Date.now();
  assert.equal(canEditPost({ author_id: 'u1', created_date: new Date(now - 60_000) }, 'u1', now), true);
  assert.equal(canEditPost({ author_id: 'u1', created_date: new Date(now - EDIT_WINDOW_MS - 1) }, 'u1', now), false);
  assert.equal(canEditPost({ author_id: 'u1', created_date: new Date(now) }, 'u2', now), false);
});

test('shouldAutoHide: three DISTINCT reporters, not three reports from one person', () => {
  assert.equal(shouldAutoHide([{ user_id: 'a' }, { user_id: 'b' }]), false);
  assert.equal(shouldAutoHide([{ user_id: 'a' }, { user_id: 'a' }, { user_id: 'a' }]), false);
  assert.equal(shouldAutoHide([{ user_id: 'a' }, { user_id: 'b' }, { user_id: 'c' }]), true);
});

test('nextMuteUntil: third hidden post within 30 days mutes for 7 days; older hides do not count', () => {
  const now = Date.now(); const d = (daysAgo) => new Date(now - daysAgo * 86400000);
  assert.equal(nextMuteUntil([d(1), d(2)], now), null);
  assert.equal(nextMuteUntil([d(1), d(2), d(40)], now), null);
  const until = nextMuteUntil([d(1), d(2), d(3)], now);
  assert.equal(until.getTime(), now + MUTE_DAYS * 86400000);
});
