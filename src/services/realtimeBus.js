const { randomUUID } = require('node:crypto');
const RealtimeEvent = require('../models/RealtimeEvent');
const { logger } = require('../lib/logger');
const origin = randomUUID();

async function publish(kind, payload) {
  if (process.env.REALTIME_SHARED_ENABLED !== 'true') return;
  await RealtimeEvent.create({ origin, kind, payload });
}

// One bounded feed per API replica, never one database poll per socket.
// Notifications remain in their primary collection; this feed is an invalidation
// hint. Clients refetch on reconnect and retain a slow polling fallback.
function subscribe(deliver) {
  let since = new Date();
  let cutoff = new Date(Date.now() - 1000);
  let cursor = null;
  let busy = false;
  const seen = new Map();
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const filter = { created_at: { $gte: since, $lte: cutoff }, origin: { $ne: origin } };
      if (cursor) filter.$or = [{ created_at: { $gt: cursor.created_at } },
        { created_at: cursor.created_at, _id: { $gt: cursor._id } }];
      const rows = await RealtimeEvent.find(filter)
        .sort({ created_at: 1, _id: 1 }).limit(1000).lean();
      for (const row of rows) {
        const id = String(row._id);
        if (!seen.has(id)) { await deliver(row.kind, row.payload); seen.set(id, new Date(row.created_at).getTime()); }
      }
      // Overlap tolerates concurrent inserts with equal timestamps.
      if (rows.length < 1000) {
        since = new Date(cutoff.getTime() - 5000);
        cutoff = new Date(Date.now() - 1000);
        cursor = null;
        for (const [id, created] of seen) if (created < since.getTime()) seen.delete(id);
      } else cursor = rows[rows.length - 1];
    } catch (err) { logger.error({ err }, 'Realtime event feed failed'); }
    finally { busy = false; }
  };
  const timer = setInterval(tick, 2000);
  timer.unref?.();
  return () => clearInterval(timer);
}

module.exports = { publish, subscribe };
