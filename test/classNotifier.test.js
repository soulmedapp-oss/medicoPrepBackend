const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { planRecipients, buildStudentClassEmail, notifyClass } = require('../src/services/classNotifier');
const { findDueReminders } = require('../src/services/classReminderScheduler');

const oid = () => new mongoose.Types.ObjectId();
const PLANS = [
  { plan_name: 'free', display_name: 'Free', tier: 0, is_active: true },
  { plan_name: 'premium', display_name: 'Premium', tier: 2, is_active: true },
];
const cls = (over = {}) => ({
  _id: oid(), title: 'Renal physiology', subject: 'Physiology', teacher_name: 'Dr Rao',
  scheduled_date: new Date('2026-10-01T04:30:00Z'), duration_minutes: 60,
  is_published: true, is_active: true, is_free: true, ...over,
});

test('planRecipients: active students the class is for; opt-outs and missing emails counted as skipped; staff excluded', () => {
  const users = [
    { email: 'a@x.com', full_name: 'A', role: 'student', subscription_plan: 'free', is_active: true },
    { email: 'b@x.com', role: 'student', subscription_plan: 'free', notify_live_classes: false },
    { email: '', role: 'student', subscription_plan: 'free' },
    { email: 't@x.com', role: 'teacher', subscription_plan: 'free' },
    { email: 'off@x.com', role: 'student', subscription_plan: 'free', is_active: false },
    { email: 'p@x.com', role: 'student', subscription_plan: 'premium' },
  ];
  const open = planRecipients(users, cls(), PLANS);
  assert.deepEqual(open.email.map((r) => r.email), ['a@x.com', 'p@x.com']);
  assert.equal(open.skipped, 2);
  const paid = planRecipients(users, cls({ is_free: false, allowed_plans: ['premium'] }), PLANS);
  assert.deepEqual(paid.email.map((r) => r.email), ['p@x.com'], 'a free student is not told about a premium-only class');
});

test('buildStudentClassEmail: subject per kind, IST time, app link, opt-out line', () => {
  const e = buildStudentClassEmail(cls(), 'published', { appBaseUrl: 'https://app.soulmed.in/' });
  assert.equal(e.subject, 'New live class scheduled: Renal physiology');
  assert.match(e.text, /Renal physiology is scheduled for .*10:00 am IST/i);
  assert.match(e.text, /https:\/\/app\.soulmed\.in\/LiveClasses/);
  assert.match(e.text, /Profile/);
  const c = buildStudentClassEmail(cls(), 'cancelled', {});
  assert.equal(c.subject, 'Live class cancelled: Renal physiology');
  assert.doesNotMatch(c.text, /Join from/);
  assert.equal(buildStudentClassEmail(cls(), 'reminder_1h', {}).inAppTitle, 'Live class in 1 hour');
});

function deps(over = {}) {
  const calls = { bells: [], mails: [], runs: [], updates: [] };
  const users = [
    { email: 'a@x.com', role: 'student', subscription_plan: 'free' },
    { email: 'bad@x.com', role: 'student', subscription_plan: 'free' },
    { email: 'quiet@x.com', role: 'student', subscription_plan: 'free', notify_live_classes: false },
  ];
  return {
    calls,
    User: { find: () => ({ select: () => ({ lean: async () => users }) }) },
    ClassNotificationRun: {
      create: async (doc) => { calls.runs.push(doc); return { _id: 'run1', ...doc }; },
      updateOne: async (f, u) => { calls.updates.push(u.$set); },
    },
    getActivePlans: async () => PLANS,
    createNotification: async (n) => { calls.bells.push(n); },
    sendEmail: async ({ to }) => { calls.mails.push(to); if (to === 'bad@x.com') throw new Error('550 mailbox unavailable'); },
    emailConfigured: () => true,
    buildIcs: () => 'BEGIN:VCALENDAR',
    appBaseUrl: 'https://app',
    reportError: () => {},
    ...over,
  };
}

test('notifyClass: bell broadcast + one email per recipient; failures recorded on the run with the reason', async () => {
  const d = deps();
  const result = await notifyClass({ liveClass: cls(), kind: 'published', triggeredBy: 'admin@x.com' }, d);
  assert.equal(d.calls.bells.length, 1);
  assert.equal(d.calls.bells[0].userEmail, 'students');
  assert.deepEqual([...d.calls.mails].sort(), ['a@x.com', 'bad@x.com']);
  assert.deepEqual([result.total, result.sent, result.failed, result.skipped], [2, 1, 1, 1]);
  assert.deepEqual(result.failures, [{ email: 'bad@x.com', error: '550 mailbox unavailable' }]);
  assert.equal(d.calls.runs[0].kind, 'published');
  assert.equal(d.calls.runs[0].triggered_by, 'admin@x.com');
  assert.equal(d.calls.updates[0].failed, 1);
});

test('notifyClass: retry sends only the named failures and no second bell; "starting" is bell-only', async () => {
  const d = deps();
  const retry = await notifyClass({ liveClass: cls(), kind: 'retry', onlyEmails: ['bad@x.com'], skipInApp: true }, d);
  assert.deepEqual(d.calls.mails, ['bad@x.com']);
  assert.equal(d.calls.bells.length, 0);
  assert.equal(retry.total, 1);
  const d2 = deps();
  const starting = await notifyClass({ liveClass: cls(), kind: 'starting' }, d2);
  assert.equal(d2.calls.bells.length, 1);
  assert.equal(d2.calls.mails.length, 0);
  assert.equal(starting.total, 0);
});

test('notifyClass: without SMTP the run records email_configured:false and sends nothing, but the bell still goes out', async () => {
  const d = deps({ emailConfigured: () => false });
  const result = await notifyClass({ liveClass: cls(), kind: 'published' }, d);
  assert.equal(d.calls.runs[0].email_configured, false);
  assert.equal(d.calls.mails.length, 0);
  assert.equal(result.sent, 0);
  assert.equal(d.calls.bells.length, 1);
});

test('findDueReminders: 1h reminder once inside the hour, starting once in the first 5 minutes; unpublished / notify_students=false skipped', () => {
  const now = new Date('2026-10-01T04:00:00Z');
  const inHour = cls({ scheduled_date: new Date('2026-10-01T04:45:00Z') });
  const later = cls({ scheduled_date: new Date('2026-10-01T06:00:00Z') });
  const startedNow = cls({ scheduled_date: new Date('2026-10-01T03:58:00Z') });
  const longAgo = cls({ scheduled_date: new Date('2026-10-01T03:00:00Z') });
  const silent = cls({ scheduled_date: new Date('2026-10-01T04:30:00Z'), notify_students: false });
  const draft = cls({ scheduled_date: new Date('2026-10-01T04:30:00Z'), is_published: false });
  const due = findDueReminders([inHour, later, startedNow, longAgo, silent, draft], [], now);
  assert.deepEqual(due.map((d) => [String(d.liveClass._id), d.kind]), [[String(inHour._id), 'reminder_1h'], [String(startedNow._id), 'starting']]);
  const again = findDueReminders([inHour, startedNow], [
    { live_class_id: inHour._id, kind: 'reminder_1h' },
    { live_class_id: startedNow._id, kind: 'starting' },
  ], now);
  assert.deepEqual(again, [], 'never twice');
});
