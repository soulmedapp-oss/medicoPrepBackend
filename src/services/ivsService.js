const jwt = require('jsonwebtoken');

function playbackSession(liveClass, userId, now = Date.now()) {
  const key = process.env.IVS_PLAYBACK_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!key || !liveClass.ivs_channel_arn || !liveClass.ivs_playback_url) throw new Error('IVS playback is not configured');
  const end = new Date(liveClass.scheduled_date).getTime() + (liveClass.duration_minutes || 60) * 60_000;
  const expiresAt = Math.floor(Math.min(now + 15 * 60_000, end) / 1000);
  const claims = { 'aws:channel-arn': liveClass.ivs_channel_arn, 'aws:viewer-id': String(userId), exp: expiresAt };
  if (process.env.IVS_PLAYBACK_ORIGINS) claims['aws:access-control-allow-origin'] = process.env.IVS_PLAYBACK_ORIGINS;
  const token = jwt.sign(claims, key, { algorithm: 'ES384' });
  const url = new URL(liveClass.ivs_playback_url);
  url.searchParams.set('token', token);
  return { provider: 'ivs-broadcast', url: url.toString(), expires_at: expiresAt * 1000 };
}

async function interactiveSession(liveClass, user, canPublish) {
  if (!liveClass.ivs_stage_arn) throw new Error('IVS stage is not configured');
  const { IVSRealTimeClient, CreateParticipantTokenCommand } = require('@aws-sdk/client-ivs-realtime');
  const client = new IVSRealTimeClient({ region: liveClass.ivs_stage_arn.split(':')[3], maxAttempts: 3 });
  try {
    const response = await client.send(new CreateParticipantTokenCommand({
      stageArn: liveClass.ivs_stage_arn, userId: String(user._id || user.id), duration: 30,
      capabilities: canPublish ? ['PUBLISH', 'SUBSCRIBE'] : ['SUBSCRIBE'],
    }));
    return { provider: 'ivs-interactive', token: response.participantToken.token,
      can_publish: canPublish, expires_at: new Date(response.participantToken.expirationTime).getTime() };
  } finally { client.destroy(); }
}

function validateLiveConfig(body) {
  if (!['zoom', 'ivs-broadcast', 'ivs-interactive'].includes(body.live_provider)) throw new Error('Invalid live provider');
  const config = { live_provider: body.live_provider, ivs_publisher_ids: [] };
  if (body.live_provider === 'ivs-broadcast') {
    if (!/^arn:aws:ivs:[a-z0-9-]+:\d{12}:channel\/[a-zA-Z0-9-]+$/.test(body.ivs_channel_arn || '')) throw new Error('Invalid IVS channel ARN');
    const url = new URL(body.ivs_playback_url);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.playback.live-video.net') || url.search || url.hash) throw new Error('Invalid IVS playback URL');
    config.ivs_channel_arn = body.ivs_channel_arn;
    config.ivs_playback_url = url.toString();
  }
  if (body.live_provider === 'ivs-interactive') {
    if (!/^arn:aws:ivs:[a-z0-9-]+:\d{12}:stage\/[a-zA-Z0-9-]+$/.test(body.ivs_stage_arn || '')) throw new Error('Invalid IVS stage ARN');
    const ids = body.ivs_publisher_ids || [];
    if (!Array.isArray(ids) || ids.length > 10 || ids.some((id) => !/^[a-f0-9]{24}$/i.test(id))) throw new Error('Choose at most 10 student publishers');
    config.ivs_stage_arn = body.ivs_stage_arn;
    config.ivs_publisher_ids = [...new Set(ids)];
  }
  return config;
}

module.exports = { playbackSession, interactiveSession, validateLiveConfig };
