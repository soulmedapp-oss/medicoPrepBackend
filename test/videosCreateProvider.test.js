const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveVideoCreateProvider } = require('../src/controllers/videosController');

// C1: createVideo used to reject any body without video_url and never read
// or wrote `provider`, so the frontend's bunny create (which correctly sends
// no video_url) always 400'd, and even a successful create would have landed
// as `provider: 'youtube'`. createVideo itself needs a live Video.create()
// call (subject validation, created_by, etc.) that this suite has no
// mongodb-memory-server style harness for, so the provider/validation
// decision it makes is pulled out into this pure function and pinned here
// instead of exercising the full controller against a database.

test('resolveVideoCreateProvider: a bunny row does not require video_url', () => {
  const result = resolveVideoCreateProvider({ provider: 'bunny' });
  assert.equal(result.provider, 'bunny');
  assert.equal(result.videoUrlRequired, false);
});

test('resolveVideoCreateProvider: a youtube (or absent-provider) row still requires video_url', () => {
  assert.equal(resolveVideoCreateProvider({ provider: 'youtube' }).videoUrlRequired, true);
  assert.equal(resolveVideoCreateProvider({}).videoUrlRequired, true);
  assert.equal(resolveVideoCreateProvider({ provider: undefined }).videoUrlRequired, true);
});

// The raw request value is never trusted straight into the schema's enum —
// anything other than the exact literal 'bunny' must fall back to 'youtube'
// (the Video model's own default), not be passed through as-is.
test('resolveVideoCreateProvider: only the exact string "bunny" selects the bunny provider', () => {
  assert.equal(resolveVideoCreateProvider({ provider: 'Bunny' }).provider, 'youtube');
  assert.equal(resolveVideoCreateProvider({ provider: 'BUNNY' }).provider, 'youtube');
  assert.equal(resolveVideoCreateProvider({ provider: 'other' }).provider, 'youtube');
  assert.equal(resolveVideoCreateProvider({ provider: null }).provider, 'youtube');
  assert.equal(resolveVideoCreateProvider({ provider: 123 }).provider, 'youtube');
  assert.equal(resolveVideoCreateProvider(null).provider, 'youtube');
});
