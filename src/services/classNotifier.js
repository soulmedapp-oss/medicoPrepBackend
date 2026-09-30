// Telling students about a live class: on publish, on reschedule, on cancel,
// one hour before, and at the start. In-app (bell) for everyone the class is
// for; email for those who have not switched it off. Every send is recorded
// on a ClassNotificationRun so an admin can see "142 sent, 3 failed" and
// retry the failures.
//
// Pure planning (who, what text) is separated from the sending so it can be
// tested without a mailer.
const { buildViewer, lockState } = require('../utils/entitlement');

const KIND_COPY = {
  published: { title: 'New live class scheduled', verb: 'is scheduled for' },
  rescheduled: { title: 'Live class rescheduled', verb: 'has moved to' },
  cancelled: { title: 'Live class cancelled', verb: 'was cancelled. It was scheduled for' },
  reminder_1h: { title: 'Live class in 1 hour', verb: 'starts in about an hour, at' },
  starting: { title: 'Live class starting now', verb: 'is starting now, at' },
  retry: { title: 'New live class scheduled', verb: 'is scheduled for' },
};
const EMAIL_KINDS = new Set(['published', 'rescheduled', 'cancelled', 'reminder_1h', 'retry']); // 'starting' is bell-only
const CONCURRENCY = 5;

const whenText = (date) => new Date(date).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
}) + ' IST';

/**
 * Pure. Which students get told about this class, and how.
 * @returns { inApp: boolean, email: [{ email, name }], skipped: number }
 */
function planRecipients(users, liveClass, plans) {
  const email = [];
  let skipped = 0;
  for (const user of users || []) {
    if (!user || user.is_active === false) continue;
    if (user.role && user.role !== 'student') continue; // staff hear through admin pages
    if (lockState(liveClass, buildViewer(user, plans))) continue; // class is not for their plan
    if (!user.email || user.notify_live_classes === false) { skipped += 1; continue; }
    email.push({ email: String(user.email).trim(), name: user.full_name || '' });
  }
  return { inApp: true, email, skipped };
}

/** Pure. Subject + text for one kind. */
function buildStudentClassEmail(liveClass, kind, { appBaseUrl = '' } = {}) {
  const copy = KIND_COPY[kind] || KIND_COPY.published;
  const link = appBaseUrl ? `${appBaseUrl.replace(/\/+$/, '')}/LiveClasses` : '';
  const lines = [
    `${liveClass.title} ${copy.verb} ${whenText(liveClass.scheduled_date)}.`,
    '',
    liveClass.subject ? `Subject: ${liveClass.subject}` : '',
    liveClass.teacher_name ? `Teacher: ${liveClass.teacher_name}` : '',
    `Duration: ${liveClass.duration_minutes || 60} minutes`,
    '',
    kind === 'cancelled' ? '' : (link ? `Join from the app: ${link}` : 'Join from the Live Classes page in the app.'),
    '',
    'You can switch these emails off under Profile → Notifications.',
  ];
  return {
    subject: `${copy.title}: ${liveClass.title}`,
    text: lines.filter((l) => l !== '' || true).join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    inAppTitle: copy.title,
    inAppMessage: `${liveClass.title} — ${whenText(liveClass.scheduled_date)}`,
  };
}

/**
 * Send one kind for one class. deps: { User, ClassNotificationRun, getActivePlans,
 * createNotification, sendEmail, emailConfigured, buildIcs, appBaseUrl, reportError,
 * onlyEmails? (retry) }. `skipInApp` resends email without a second bell.
 */
async function notifyClass({ liveClass, kind, triggeredBy = 'system', onlyEmails = null, skipInApp = false }, deps) {
  const { User, ClassNotificationRun, getActivePlans, createNotification, sendEmail, emailConfigured, buildIcs, appBaseUrl, reportError } = deps;
  const run = await ClassNotificationRun.create({ live_class_id: liveClass._id, kind, triggered_by: triggeredBy, email_configured: Boolean(emailConfigured()) });
  const copy = buildStudentClassEmail(liveClass, kind, { appBaseUrl });

  // Bell: one broadcast row for every student client (existing 'students' channel).
  let inApp = false;
  if (!onlyEmails && !skipInApp) {
    try {
      await createNotification({
        userEmail: 'students',
        title: copy.inAppTitle,
        message: copy.inAppMessage,
        type: kind === 'starting' ? 'class_live' : 'class_reminder',
        link: '/LiveClasses',
      });
      inApp = true;
    } catch (err) {
      reportError(null, err, 'class notification broadcast failed', { liveClassId: String(liveClass._id), kind });
    }
  }

  // Email
  let recipients = [];
  let skipped = 0;
  if (EMAIL_KINDS.has(kind)) {
    const users = await User.find({ is_active: { $ne: false } }).select('email full_name role subscription_plan notify_live_classes is_active').lean();
    const plan = planRecipients(users, liveClass, await getActivePlans());
    recipients = onlyEmails ? plan.email.filter((r) => onlyEmails.includes(r.email)) : plan.email;
    skipped = plan.skipped;
  }
  const failures = [];
  let sent = 0;
  if (recipients.length && emailConfigured()) {
    const attachments = kind === 'cancelled' || !buildIcs ? [] : [{ filename: 'class.ics', content: buildIcs(liveClass), contentType: 'text/calendar; charset=utf-8' }];
    const queue = [...recipients];
    const worker = async () => {
      while (queue.length) {
        const r = queue.shift();
        try {
          await sendEmail({ to: r.email, subject: copy.subject, text: copy.text, attachments });
          sent += 1;
        } catch (err) {
          failures.push({ email: r.email, error: String(err?.message || err).slice(0, 200) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  }

  const summary = {
    in_app: inApp,
    total: recipients.length,
    sent,
    failed: failures.length,
    skipped,
    failures,
    finished_at: new Date(),
  };
  await ClassNotificationRun.updateOne({ _id: run._id }, { $set: summary });
  return { runId: run._id, ...summary };
}

module.exports = { planRecipients, buildStudentClassEmail, notifyClass, KIND_COPY, EMAIL_KINDS };
