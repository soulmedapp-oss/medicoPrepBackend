const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { playbackSession, validateLiveConfig } = require('../src/services/ivsService');

test('private broadcast tokens are channel-bound, short-lived and signed with ES384', (t) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  const previous = process.env.IVS_PLAYBACK_PRIVATE_KEY;
  process.env.IVS_PLAYBACK_PRIVATE_KEY = privateKey.export({ format: 'pem', type: 'pkcs8' });
  t.after(() => { if (previous === undefined) delete process.env.IVS_PLAYBACK_PRIVATE_KEY; else process.env.IVS_PLAYBACK_PRIVATE_KEY = previous; });
  const now = Date.now();
  const session = playbackSession({ scheduled_date: new Date(now), duration_minutes: 60,
    ivs_channel_arn: 'arn:aws:ivs:ap-south-1:123456789012:channel/example',
    ivs_playback_url: 'https://example.ap-south-1.playback.live-video.net/stream.m3u8' }, 'student', now);
  const claims = jwt.verify(new URL(session.url).searchParams.get('token'), publicKey, { algorithms: ['ES384'] });
  assert.equal(claims['aws:viewer-id'], 'student');
  assert.ok(claims['aws:channel-arn'].endsWith('/example'));
  assert.ok(claims.exp * 1000 <= now + 15 * 60_000);
});

test('live configuration rejects arbitrary URLs and excessive publisher grants', () => {
  assert.throws(() => validateLiveConfig({ live_provider: 'ivs-broadcast', ivs_channel_arn: 'arn:aws:ivs:ap-south-1:123456789012:channel/example', ivs_playback_url: 'https://attacker.example/live' }));
  assert.throws(() => validateLiveConfig({ live_provider: 'ivs-interactive', ivs_stage_arn: 'arn:aws:ivs:ap-south-1:123456789012:stage/example', ivs_publisher_ids: Array(11).fill('a'.repeat(24)) }));
  assert.deepEqual(validateLiveConfig({ live_provider: 'zoom' }), { live_provider: 'zoom', ivs_publisher_ids: [] });
});
