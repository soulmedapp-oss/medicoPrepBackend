// Task 3 (spec §1/§2/§6): student playlist endpoints return LOCKED
// playlists instead of hiding them, plus a lecture-title teaser for a locked
// playlist detail, plus a uniform 403 body for playback. Stubbed-model
// handler tests in the style of test/rbacMediaControllers.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Playlist = require('../src/models/Playlist');
const Video = require('../src/models/Video');
const SubscriptionPlan = require('../src/models/SubscriptionPlan');

const { createPlaylistsController } = require('../src/controllers/playlistsController');
const { resolvePlaybackAccess } = require('../src/controllers/videosController');
const { buildViewer, upgradeRefusal, invalidateEntitlementPlans } = require('../src/utils/entitlement');

const PLANS = [
  { plan_name: 'free', display_name: 'Free', tier: 0, is_active: true },
  { plan_name: 'elite', display_name: 'Elite', tier: 2, is_active: true },
];

const oid = () => new mongoose.Types.ObjectId();

// Chainable, awaitable query stub (style: test/rbacMediaControllers.test.js).
function q(value) {
  const chain = {
    sort: () => chain,
    select: () => chain,
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
  invalidateEntitlementPlans();
});
test.beforeEach(() => {
  stub(SubscriptionPlan, 'find', () => q(PLANS));
});

function controller() {
  return createPlaylistsController();
}

test('browsePlaylists: a locked playlist is returned with lock, same projection as an open one', async () => {
  const open = { _id: oid(), name: 'Free ENT', is_published: true, is_active: true, is_free: true, items: [], subject_ids: [] };
  const locked = { _id: oid(), name: 'Elite ENT', is_published: true, is_active: true, allowed_plans: ['elite'], items: [{ lecture_id: oid() }], subject_ids: [] };
  stub(Playlist, 'find', () => q([open, locked]));
  stub(Video, 'find', () => q([]));
  const res = mockRes();
  await controller().browsePlaylists({ query: {}, user: { _id: oid(), subscription_plan: 'free', effective_permissions: [] } }, res);
  assert.equal(res.body.playlists.length, 2);
  const row = res.body.playlists.find((p) => p.name === 'Elite ENT');
  assert.deepEqual(row.lock, { required_plan: 'elite', required_label: 'Elite', required_tier: 2 });
  assert.equal(res.body.playlists.find((p) => p.name === 'Free ENT').lock, null);
  assert.deepEqual(Object.keys(row).sort(), ['_id', 'allowed_plans', 'description', 'is_free', 'lecture_count', 'lock', 'name', 'subject_ids', 'thumbnail_url']);
});

test('getPlaylist: locked → teaser lectures without video_url/provider, locked:true; unpublished stays 404', async () => {
  const lectureId = oid();
  const playlist = { _id: oid(), name: 'Elite ENT', is_published: true, is_active: true, allowed_plans: ['elite'], items: [{ lecture_id: lectureId, order: 1 }] };
  stub(Playlist, 'findById', () => q(playlist));
  let selected;
  stub(Video, 'find', () => {
    const c = q([{ _id: lectureId, title: 'Otitis', subtopic: 'Ear', duration_seconds: 600, thumbnail_url: '', card_thumbnail_url: '', is_active: true, video_url: 'SECRET', provider: 'bunny' }]);
    const s = c.select;
    c.select = (f) => { selected = f; return s(f); };
    return c;
  });
  const res = mockRes();
  await controller().getPlaylist({ params: { id: String(playlist._id) }, user: { _id: oid(), subscription_plan: 'free', effective_permissions: [] } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.locked, true);
  assert.equal(res.body.playlist.lock.required_plan, 'elite');
  assert.equal(selected, '_id title subtopic duration_seconds thumbnail_url card_thumbnail_url is_active');
  assert.deepEqual(Object.keys(res.body.lectures[0]).sort(), ['_id', 'card_thumbnail_url', 'duration_seconds', 'subtopic', 'thumbnail_url', 'title']);

  stub(Playlist, 'findById', () => q({ ...playlist, is_published: false }));
  const res2 = mockRes();
  await controller().getPlaylist({ params: { id: String(playlist._id) }, user: { _id: oid(), subscription_plan: 'free', effective_permissions: [] } }, res2);
  assert.equal(res2.statusCode, 404);
});

// getPlaylist: the unlocked path still returns lock: null and locked: false —
// pinned separately from the two cases above since neither of them exercises
// full entitlement (free playlist with lecture_count / real playback fields).
test('getPlaylist: an entitled playlist opens unlocked, with the full lecture projection and locked:false', async () => {
  const lectureId = oid();
  const playlist = { _id: oid(), name: 'Free ENT', is_published: true, is_active: true, is_free: true, items: [{ lecture_id: lectureId, order: 0 }] };
  stub(Playlist, 'findById', () => q(playlist));
  stub(Video, 'find', () => q([{ _id: lectureId, title: 'Otitis', is_active: true, video_url: 'https://y/1', provider: 'youtube' }]));
  const res = mockRes();
  await controller().getPlaylist({ params: { id: String(playlist._id) }, user: { _id: oid(), subscription_plan: 'free', effective_permissions: [] } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.locked, false);
  assert.equal(res.body.playlist.lock, null);
  assert.equal(res.body.lectures[0].video_url, 'https://y/1');
});

test('resolvePlaybackAccess: locked lecture → 403 with the uniform UPGRADE_REQUIRED body', () => {
  const lectureId = oid();
  const lecture = { _id: lectureId, is_active: true };
  const viewer = buildViewer({ subscription_plan: 'free' }, PLANS);
  const playlists = [
    { is_published: true, is_active: true, allowed_plans: ['elite'], items: [{ lecture_id: lectureId }] },
  ];
  const result = resolvePlaybackAccess({ lecture, playlists, viewer, isStaff: false });
  assert.deepEqual(result, {
    allowed: false,
    status: 403,
    body: upgradeRefusal({ required_plan: 'elite', required_label: 'Elite', required_tier: 2 }),
  });

  // A lecture carried by NO published playlist at all is a clean 404 —
  // "upgrade to unlock" only makes sense when a playlist actually carries it.
  const notCarried = resolvePlaybackAccess({ lecture, playlists: [], viewer, isStaff: false });
  assert.deepEqual(notCarried, { allowed: false, status: 404, error: 'Video not found' });
});

// Zoom recording ingest: a lecture linked to a live class follows the class's
// own gate, playlist or not.
test('resolvePlaybackAccess: a live-class recording is playable by whoever may open the class, even with no playlist', () => {
  const lectureId = oid();
  const lecture = { _id: lectureId, is_active: true, source_live_class_id: oid() };
  const free = buildViewer({ subscription_plan: 'free' }, PLANS);
  const elite = buildViewer({ subscription_plan: 'elite' }, PLANS);
  const openClass = { is_published: true, is_active: true, is_free: true };
  const paidClass = { is_published: true, is_active: true, allowed_plans: ['elite'] };
  const draftClass = { is_published: false, is_active: true, is_free: true };

  assert.deepEqual(resolvePlaybackAccess({ lecture, playlists: [], viewer: free, isStaff: false, sourceClass: openClass }), { allowed: true });
  assert.deepEqual(resolvePlaybackAccess({ lecture, playlists: [], viewer: elite, isStaff: false, sourceClass: paidClass }), { allowed: true });
  assert.deepEqual(resolvePlaybackAccess({ lecture, playlists: [], viewer: free, isStaff: false, sourceClass: paidClass }), {
    allowed: false, status: 403, body: upgradeRefusal({ required_plan: 'elite', required_label: 'Elite', required_tier: 2 }),
  }, 'the class lock is the answer when no playlist carries the lecture');
  assert.equal(resolvePlaybackAccess({ lecture, playlists: [], viewer: free, isStaff: false, sourceClass: draftClass }).status, 404, 'an unpublished class hides its recording like before');
  // An open playlist carrying it still wins regardless of the class.
  const openPlaylist = { is_published: true, is_active: true, is_free: true, items: [{ lecture_id: lectureId }] };
  assert.deepEqual(resolvePlaybackAccess({ lecture, playlists: [openPlaylist], viewer: free, isStaff: false, sourceClass: paidClass }), { allowed: true });
});
