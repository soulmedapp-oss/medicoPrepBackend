// Reminders for live classes: a bell + email about an hour before, and a bell
// at the start. Runs every few minutes (setInterval on a long-lived server;
// POST /classes/notifications/run-due from a cron on serverless). Each kind
// is sent at most once per class — the ClassNotificationRun rows are the
// memory, so restarts and overlapping runs cannot double-send.
const REMINDER_MINUTES = 60;
const START_GRACE_MINUTES = 5; // "starting now" fires from T-0 to T+5

/**
 * Pure. Given the candidate classes and the runs that already happened,
 * which (class, kind) pairs are due at `now`?
 */
function findDueReminders(classes, runs, now = new Date()) {
  const done = new Set((runs || []).map((r) => `${String(r.live_class_id)}:${r.kind}`));
  const due = [];
  for (const liveClass of classes || []) {
    if (!liveClass.is_published || liveClass.is_active === false || liveClass.notify_students === false) continue;
    const start = new Date(liveClass.scheduled_date).getTime();
    if (Number.isNaN(start)) continue;
    const minutesToStart = (start - now.getTime()) / 60000;
    const key = (kind) => `${String(liveClass._id)}:${kind}`;
    // Anything from 60 minutes out down to the start itself; a class published
    // 20 minutes before start still gets its one reminder.
    if (minutesToStart <= REMINDER_MINUTES && minutesToStart > 0 && !done.has(key('reminder_1h'))) {
      due.push({ liveClass, kind: 'reminder_1h' });
    }
    if (minutesToStart <= 0 && minutesToStart >= -START_GRACE_MINUTES && !done.has(key('starting'))) {
      due.push({ liveClass, kind: 'starting' });
    }
  }
  return due;
}

/** deps: { LiveClass, ClassNotificationRun, notifyClass, logger, reportError, now? } */
async function runDueReminders(deps) {
  const { LiveClass, ClassNotificationRun, notifyClass, logger, reportError } = deps;
  const now = deps.now || new Date();
  const from = new Date(now.getTime() - START_GRACE_MINUTES * 60000);
  const to = new Date(now.getTime() + REMINDER_MINUTES * 60000);
  const classes = await LiveClass.find({
    is_published: true,
    is_active: { $ne: false },
    scheduled_date: { $gte: from, $lte: to },
  }).lean();
  if (!classes.length) return { checked: 0, sent: [] };
  const runs = await ClassNotificationRun.find({
    live_class_id: { $in: classes.map((c) => c._id) },
    kind: { $in: ['reminder_1h', 'starting'] },
  }).select('live_class_id kind').lean();
  const due = findDueReminders(classes, runs, now);
  const sent = [];
  for (const { liveClass, kind } of due) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await notifyClass({ liveClass, kind, triggeredBy: 'system' });
      sent.push({ liveClassId: String(liveClass._id), kind, sent: result.sent, failed: result.failed });
    } catch (err) {
      reportError(null, err, 'class reminder failed', { liveClassId: String(liveClass._id), kind });
    }
  }
  if (sent.length) logger?.info?.({ sent }, 'class reminders sent');
  return { checked: classes.length, sent };
}

module.exports = { findDueReminders, runDueReminders, REMINDER_MINUTES, START_GRACE_MINUTES };
