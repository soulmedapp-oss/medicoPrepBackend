const LiveClass = require('../models/LiveClass');
const Video = require('../models/Video');
const LiveClassNote = require('../models/LiveClassNote');
const User = require('../models/User');
const { attachActorNames } = require('../utils/actorNames');
const { isValidTextLength } = require('../utils/validation');
const { validateSubjectIfConfigured } = require('../utils/subjects');
const { pickRecording, createZoomMeeting, zoomTokenConfigured } = require('../services/zoomService');
const { getOpenAiKey } = require('../services/settingsService');
const { requestClassSummary, requestClassChat } = require('../services/tutorService');
const { sendEmail } = require('../services/emailService');
const { can } = require('../rbac/can');
const { lockState, upgradeRefusal, viewerFor, featureLock } = require('../utils/entitlement');
// Final fix wave C2: the student class projection now lives in utils so the
// student dashboard's upcoming_classes goes through exactly the same one.
const { studentClassRow } = require('../utils/classProjection');
const { missingUpdatePermissions } = require('../rbac/updatePermissions');
const { MAX_CHAT_MESSAGE_LENGTH } = require('../utils/security');
const { recordActiveStateChange, recordDeactivated } = require('../utils/audit');
const { reportError } = require('../lib/errorReporter.js');

// Fields staff may change via PATCH /classes/:id. Zoom URLs, recording files and
// passcodes are server-managed (Zoom API / webhook) and never client-writable.
const UPDATABLE_CLASS_FIELDS = [
  'title',
  'description',
  'topic_covered',
  'subject',
  'teacher_name',
  'teacher_email',
  'scheduled_date',
  'duration_minutes',
  'meeting_link',
  'youtube_url',
  'recording_url',
  'transcript_url',
  'transcript_text',
  'thumbnail_url',
  'zoom_meeting_id',
  'zoom_meeting_uuid',
  'is_published',
  'is_active',
  'status',
  'allowed_plans',
];

function pickFields(source, fields) {
  const out = {};
  fields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(source || {}, field)) {
      out[field] = source[field];
    }
  });
  return out;
}

// Whether `user` is the Zoom host of `liveClass` (by email, trimmed +
// lower-cased; false if either side is empty). Used only to decide whether
// the Zoom host link (zoom_start_url) is included in the all=true class
// list — NOT an authorization gate. create/update/delete rely solely on
// route-level authorize(); no ownership check is reintroduced there.
function isClassTeacher(user, liveClass) {
  const teacherEmail = String(liveClass?.teacher_email || '').trim().toLowerCase();
  const userEmail = String(user?.email || '').trim().toLowerCase();
  return Boolean(teacherEmail) && Boolean(userEmail) && teacherEmail === userEmail;
}

function buildClassInviteIcs(liveClass) {
  const start = new Date(liveClass.scheduled_date);
  const end = new Date(start.getTime() + (liveClass.duration_minutes || 60) * 60000);
  const formatIcsDate = (date) =>
    date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const uid = `${liveClass._id}@soulmed`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SoulMed//LiveClass//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${formatIcsDate(new Date())}`,
    `DTSTART:${formatIcsDate(start)}`,
    `DTEND:${formatIcsDate(end)}`,
    `SUMMARY:${liveClass.title}`,
    `DESCRIPTION:${(liveClass.description || '').replace(/\n/g, '\\n')}`,
    `LOCATION:${liveClass.zoom_join_url || liveClass.meeting_link || ''}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.join('\r\n');
}

// Which of these classes' Bunny recordings have finished encoding — one
// query for the whole page.
async function readyRecordingLectureIds(classes) {
  const ids = classes.map((c) => c.recording_video_id).filter(Boolean);
  if (!ids.length) return new Set();
  const ready = await Video.find({ _id: { $in: ids }, processing_status: 'ready', is_active: { $ne: false } }).select('_id').lean();
  return new Set(ready.map((v) => String(v._id)));
}

function createClassesController({ createNotification }) {
  async function listClasses(req, res) {
    try {
      const { all } = req.query;
      const filter = {};
      let viewer = null;
      if (all === 'true') {
        if (!can(req.user, 'CanViewClasses')) {
          return res.status(403).json({ error: 'Staff access required' });
        }
      } else {
        viewer = await viewerFor(req.user);
        filter.is_published = true;
        filter.is_active = { $ne: false };
      }

      const classes = await LiveClass.find(filter).sort({ scheduled_date: -1 }).lean();
      const now = new Date();
      const updatesById = new Map();
      classes.forEach((liveClass) => {
        const start = new Date(liveClass.scheduled_date);
        const end = new Date(start.getTime() + (liveClass.duration_minutes || 60) * 60000);
        let nextStatus = liveClass.status;
        if (liveClass.status === 'completed' || liveClass.status === 'cancelled') {
          return;
        }
        if (now >= start && now <= end) {
          nextStatus = 'live';
        } else if (now > end) {
          nextStatus = 'completed';
        } else {
          nextStatus = 'scheduled';
        }
        const update = {};
        if (nextStatus !== liveClass.status) {
          update.status = nextStatus;
          liveClass.status = nextStatus;
        }
        if (liveClass.is_active === undefined) {
          update.is_active = true;
          liveClass.is_active = true;
        }
        if (Object.keys(update).length > 0) {
          updatesById.set(liveClass._id.toString(), update);
        }
      });
      if (updatesById.size > 0) {
        await Promise.all(
          Array.from(updatesById.entries()).map(([id, update]) =>
            LiveClass.findByIdAndUpdate(id, { $set: update })
          )
        );
      }
      let visibleClasses;
      if (all === 'true') {
        // zoom_start_url is the Zoom HOST link — the one exception to "no
        // ownership rules" (spec section 2: handing every CanEditClasses
        // holder every class's host link would re-open the 2026-09-19 leak).
        // Kept only for the class's own teacher or a CanHostAnyClass holder.
        // `lock: null` on every row keeps the same shape as the student list.
        const canHostAny = can(req.user, 'CanHostAnyClass');
        // Scheduled-by / last-modified-by columns (spec §2/§4): one User.find
        // over the distinct created_by/updated_by ids, then the same pure
        // attachActorNames helper videosController's staff list uses.
        const userIds = new Set();
        classes.forEach((liveClass) => {
          if (liveClass.created_by) userIds.add(String(liveClass.created_by));
          if (liveClass.updated_by) userIds.add(String(liveClass.updated_by));
        });
        const users = userIds.size
          ? await User.find({ _id: { $in: Array.from(userIds) } }).select('_id full_name').lean()
          : [];
        const userMap = new Map(users.map((user) => [String(user._id), user]));
        const withNames = attachActorNames(classes, userMap);
        visibleClasses = withNames.map((liveClass) => {
          if (canHostAny || isClassTeacher(req.user, liveClass)) return { ...liveClass, lock: null };
          const sanitized = { ...liveClass, lock: null };
          delete sanitized.zoom_start_url;
          return sanitized;
        });
      } else {
        // Locked classes stay in the list (with `lock` set) instead of being
        // dropped — the student sees what exists and what it takes to open
        // it. A locked row is stripped of join/recording hints on top of the
        // usual student sanitizer, since neither is usable without the plan.
        const readyRecordings = await readyRecordingLectureIds(classes);
        visibleClasses = classes.map((liveClass) => studentClassRow(liveClass, lockState(liveClass, viewer), {
          recordingLectureReady: readyRecordings.has(String(liveClass.recording_video_id || '')),
        }));
      }
      return res.json({ classes: visibleClasses });
    } catch (err) {
      reportError(req, err);
      return res.status(500).json({ error: 'Failed to load classes' });
    }
  }

  async function createClass(req, res) {
    try {
      const data = req.body || {};
      if (data.title && !isValidTextLength(String(data.title), 2, 200)) {
        return res.status(400).json({ error: 'title must be between 2 and 200 characters' });
      }
      if (data.subject && !isValidTextLength(String(data.subject), 2, 120)) {
        return res.status(400).json({ error: 'subject must be between 2 and 120 characters' });
      }
      const subjectName = await validateSubjectIfConfigured(data.subject);
      if (!data.teacher_name || !isValidTextLength(String(data.teacher_name), 2, 120)) {
        return res.status(400).json({ error: 'teacher_name is required' });
      }
      if (!data.teacher_email || !isValidTextLength(String(data.teacher_email), 3, 200)) {
        return res.status(400).json({ error: 'teacher_email is required' });
      }
      if (data.topic_covered && !isValidTextLength(String(data.topic_covered), 2, 200)) {
        return res.status(400).json({ error: 'topic_covered must be between 2 and 200 characters' });
      }
      if (data.thumbnail_url && !isValidTextLength(String(data.thumbnail_url), 5, 500)) {
        return res.status(400).json({ error: 'thumbnail_url must be between 5 and 500 characters' });
      }
      if (data.recording_url && !isValidTextLength(String(data.recording_url), 5, 500)) {
        return res.status(400).json({ error: 'recording_url must be between 5 and 500 characters' });
      }
      if (data.transcript_url && !isValidTextLength(String(data.transcript_url), 5, 500)) {
        return res.status(400).json({ error: 'transcript_url must be between 5 and 500 characters' });
      }
      if (data.transcript_text && !isValidTextLength(String(data.transcript_text), 5, 200000)) {
        return res.status(400).json({ error: 'transcript_text is too long' });
      }
      if (data.zoom_meeting_id && !isValidTextLength(String(data.zoom_meeting_id), 3, 120)) {
        return res.status(400).json({ error: 'zoom_meeting_id must be between 3 and 120 characters' });
      }
      if (data.zoom_meeting_uuid && !isValidTextLength(String(data.zoom_meeting_uuid), 3, 200)) {
        return res.status(400).json({ error: 'zoom_meeting_uuid must be between 3 and 200 characters' });
      }
      const shouldCreateZoomMeeting =
        !data.zoom_meeting_id &&
        (data.create_zoom_meeting === undefined ? true : Boolean(data.create_zoom_meeting));
      if (shouldCreateZoomMeeting && !zoomTokenConfigured()) {
        return res.status(400).json({ error: 'Zoom credentials not configured' });
      }
      const allowedPlans = Array.isArray(data.allowed_plans)
        ? data.allowed_plans.map((p) => String(p).trim()).filter(Boolean)
        : [];
      const isFreePlan = allowedPlans.includes('free');

      let zoomMeeting = null;
      if (shouldCreateZoomMeeting) {
        zoomMeeting = await createZoomMeeting({
          topic: data.title || 'Live Class',
          type: 2,
          start_time: data.scheduled_date,
          duration: data.duration_minutes ?? 60,
          agenda: data.description || '',
          settings: {
            join_before_host: false,
            waiting_room: false,
            approval_type: 2,
            auto_recording: 'cloud',
          },
        });
      }
      const liveClass = await LiveClass.create({
        title: data.title,
        description: data.description || '',
        topic_covered: data.topic_covered || '',
        subject: subjectName,
        teacher_name: data.teacher_name,
        teacher_email: data.teacher_email || '',
        scheduled_date: data.scheduled_date,
        duration_minutes: data.duration_minutes ?? 60,
        meeting_link: data.meeting_link || '',
        youtube_url: data.youtube_url || '',
        recording_url: data.recording_url || '',
        transcript_url: data.transcript_url || '',
        transcript_text: data.transcript_text || '',
        thumbnail_url: data.thumbnail_url || '',
        zoom_meeting_id: zoomMeeting?.id ? String(zoomMeeting.id) : (data.zoom_meeting_id || ''),
        zoom_meeting_uuid: zoomMeeting?.uuid ? String(zoomMeeting.uuid) : (data.zoom_meeting_uuid || ''),
        zoom_join_url: zoomMeeting?.join_url || '',
        zoom_start_url: zoomMeeting?.start_url || '',
        is_free: isFreePlan,
        is_published: Boolean(data.is_published),
        status: data.status || 'scheduled',
        allowed_plans: allowedPlans,
        created_by: req.userId,
        updated_by: req.userId,
        updated_by_at: new Date(),
      });

      if (liveClass.teacher_email) {
        try {
          const ics = buildClassInviteIcs(liveClass);
          await sendEmail({
            to: liveClass.teacher_email,
            subject: `Class scheduled: ${liveClass.title}`,
            text: `A class has been scheduled.\n\nTitle: ${liveClass.title}\nDate: ${new Date(
              liveClass.scheduled_date
            ).toLocaleString()}\nDuration: ${liveClass.duration_minutes} mins\n`,
            attachments: [
              {
                filename: 'class-invite.ics',
                content: ics,
                contentType: 'text/calendar; charset=utf-8',
              },
            ],
          });
        } catch (err) {
          reportError(req, err, 'Failed to send class invite');
        }
      }

      if (liveClass.is_published) {
        await createNotification({
          userEmail: 'students',
          title: 'New class scheduled',
          message: liveClass.title || 'A new class is available.',
          type: 'class_reminder',
        });
      }
      return res.status(201).json({ liveClass });
    } catch (err) {
      reportError(req, err);
      return res.status(500).json({ error: 'Failed to create class' });
    }
  }

  async function updateClass(req, res) {
    try {
      const updates = pickFields(req.body, UPDATABLE_CLASS_FIELDS);
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No updatable fields provided' });
      }
      if (updates.title && !isValidTextLength(String(updates.title), 2, 200)) {
        return res.status(400).json({ error: 'title must be between 2 and 200 characters' });
      }
      if (updates.subject && !isValidTextLength(String(updates.subject), 2, 120)) {
        return res.status(400).json({ error: 'subject must be between 2 and 120 characters' });
      }
      if (updates.subject) {
        updates.subject = await validateSubjectIfConfigured(updates.subject);
      }
      if (updates.teacher_name !== undefined && !isValidTextLength(String(updates.teacher_name), 2, 120)) {
        return res.status(400).json({ error: 'teacher_name is required' });
      }
      if (updates.teacher_email !== undefined && !isValidTextLength(String(updates.teacher_email), 3, 200)) {
        return res.status(400).json({ error: 'teacher_email is required' });
      }
      if (updates.topic_covered && !isValidTextLength(String(updates.topic_covered), 2, 200)) {
        return res.status(400).json({ error: 'topic_covered must be between 2 and 200 characters' });
      }
      if (updates.thumbnail_url && !isValidTextLength(String(updates.thumbnail_url), 5, 500)) {
        return res.status(400).json({ error: 'thumbnail_url must be between 5 and 500 characters' });
      }
      if (updates.recording_url && !isValidTextLength(String(updates.recording_url), 5, 500)) {
        return res.status(400).json({ error: 'recording_url must be between 5 and 500 characters' });
      }
      if (updates.transcript_url && !isValidTextLength(String(updates.transcript_url), 5, 500)) {
        return res.status(400).json({ error: 'transcript_url must be between 5 and 500 characters' });
      }
      if (updates.transcript_text && !isValidTextLength(String(updates.transcript_text), 5, 200000)) {
        return res.status(400).json({ error: 'transcript_text is too long' });
      }
      if (updates.zoom_meeting_id && !isValidTextLength(String(updates.zoom_meeting_id), 3, 120)) {
        return res.status(400).json({ error: 'zoom_meeting_id must be between 3 and 120 characters' });
      }
      if (updates.zoom_meeting_uuid && !isValidTextLength(String(updates.zoom_meeting_uuid), 3, 200)) {
        return res.status(400).json({ error: 'zoom_meeting_uuid must be between 3 and 200 characters' });
      }
      if (updates.allowed_plans) {
        updates.allowed_plans = Array.isArray(updates.allowed_plans)
          ? updates.allowed_plans.map((p) => String(p).trim()).filter(Boolean)
          : [];
        updates.is_free = updates.allowed_plans.includes('free');
      }
      const existing = await LiveClass.findById(req.params.id).lean();
      if (!existing) {
        return res.status(404).json({ error: 'Class not found' });
      }
      const missing = missingUpdatePermissions(req.user, updates, existing, { edit: 'CanEditClasses', deactivate: 'CanDeactivateClasses' });
      if (missing) return res.status(403).json({ error: 'Permission denied', required: missing });
      // Stamped on every write regardless of which fields changed — never
      // client-writable (not in UPDATABLE_CLASS_FIELDS) and applied after the
      // permission check, so it can't affect which permission is required.
      updates.updated_by = req.userId;
      updates.updated_by_at = new Date();
      const liveClass = await LiveClass.findByIdAndUpdate(
        req.params.id,
        { $set: updates },
        { new: true }
      ).lean();

      if (!liveClass) {
        return res.status(404).json({ error: 'Class not found' });
      }

      await recordActiveStateChange(req, { resource: 'class', before: existing, after: liveClass, targetLabel: liveClass.title });

      const justPublished = !existing?.is_published && liveClass.is_published;
      const scheduleChanged = existing?.scheduled_date?.toString() !== liveClass.scheduled_date?.toString();
      if (justPublished || scheduleChanged) {
        await createNotification({
          userEmail: 'students',
          title: justPublished ? 'Class published' : 'Class updated',
          message: liveClass.title || 'A class was updated.',
          type: 'class_reminder',
        });
      }
      return res.json({ liveClass });
    } catch (err) {
      reportError(req, err);
      return res.status(500).json({ error: 'Failed to update class' });
    }
  }

  async function deleteClass(req, res) {
    try {
      const liveClass = await LiveClass.findById(req.params.id);
      if (!liveClass) {
        return res.status(404).json({ error: 'Class not found' });
      }
      liveClass.is_active = false;
      liveClass.is_published = false;
      liveClass.updated_by = req.userId;
      liveClass.updated_by_at = new Date();
      await liveClass.save();
      await recordDeactivated(req, { resource: 'class', targetId: liveClass._id, targetLabel: liveClass.title });
      return res.json({ ok: true, liveClass: liveClass.toObject() });
    } catch (err) {
      reportError(req, err);
      return res.status(500).json({ error: 'Failed to deactivate class' });
    }
  }

  async function listClassNotes(req, res) {
    try {
      const notes = await LiveClassNote.find({
        class_id: req.params.id,
        user_id: req.userId,
        is_active: true,
      }).sort({ created_date: -1 }).lean();

      return res.json({ notes });
    } catch (err) {
      reportError(req, err);
      return res.status(500).json({ error: 'Failed to load notes' });
    }
  }

  async function getClassRecording(req, res) {
    try {
      const liveClass = await LiveClass.findById(req.params.id).lean();
      if (!liveClass) {
        return res.status(404).json({ error: 'Class not found' });
      }

      if (!can(req.user, 'CanViewClasses')) {
        if (!liveClass.is_published || liveClass.is_active === false) {
          return res.status(404).json({ error: 'Class not found' });
        }
        const viewer = await viewerFor(req.user);
        const lock = lockState(liveClass, viewer);
        if (lock) return res.status(403).json(upgradeRefusal(lock));
      }

      // Never hand out the Zoom S2S access token (it grants account-wide API
      // access). Clients get the Zoom web player URL plus the recording passcode.
      const recording = pickRecording(liveClass.zoom_recording_files);
      const url = recording?.play_url || liveClass.recording_url || liveClass.youtube_url || '';

      if (!url) {
        return res.status(404).json({ error: 'Recording not available' });
      }

      const payload = {
        url,
        recording: recording
          ? {
            file_type: recording.file_type,
            recording_start: recording.recording_start,
            recording_end: recording.recording_end,
            play_url: recording.play_url,
          }
          : null,
      };
      if (recording?.play_url && url === recording.play_url && liveClass.zoom_recording_password) {
        payload.passcode = liveClass.zoom_recording_password;
      }
      return res.json(payload);
    } catch (err) {
      reportError(req, err);
      return res.status(500).json({ error: 'Failed to load recording' });
    }
  }

  async function getClassJoinLink(req, res) {
    try {
      const liveClass = await LiveClass.findById(req.params.id).lean();
      if (!liveClass) {
        return res.status(404).json({ error: 'Class not found' });
      }
      if (!liveClass.is_published || liveClass.is_active === false) {
        return res.status(404).json({ error: 'Class not found' });
      }

      const start = new Date(liveClass.scheduled_date);
      const end = new Date(start.getTime() + (liveClass.duration_minutes || 60) * 60000);
      const now = new Date();
      const earlyWindow = new Date(start.getTime() - 10 * 60000);
      if (now < earlyWindow || now > end) {
        return res.status(400).json({ error: 'Class is not live yet' });
      }

      const viewer = await viewerFor(req.user);
      const lock = lockState(liveClass, viewer);
      if (lock) return res.status(403).json(upgradeRefusal(lock));

      const url = liveClass.zoom_join_url || liveClass.meeting_link || '';
      if (!url) {
        return res.status(404).json({ error: 'Join link not available' });
      }
      return res.json({ url });
    } catch (err) {
      reportError(req, err);
      return res.status(500).json({ error: 'Failed to load join link' });
    }
  }

  async function getClassSummary(req, res) {
    try {
      const { value } = await getOpenAiKey();
      if (!value) {
        return res.status(400).json({ error: 'Tutor service is not configured' });
      }
      const liveClass = await LiveClass.findById(req.params.id).lean();
      if (!liveClass) {
        return res.status(404).json({ error: 'Class not found' });
      }

      if (!can(req.user, 'CanViewClasses')) {
        if (!liveClass.is_published || liveClass.is_active === false) {
          return res.status(404).json({ error: 'Class not found' });
        }
        const viewer = await viewerFor(req.user);
        const lock = lockState(liveClass, viewer);
        if (lock) return res.status(403).json(upgradeRefusal(lock));
        // Final fix wave (Rec 3): the same plan feature the watch page gates
        // a lecture's AI Summary tab on. Without this a free student could
        // read an AI summary of a free class while the identical tab on a
        // lecture was locked. Runs before the AI call, so a locked feature
        // never spends a token.
        const featureRefusal = featureLock('ai_summary', viewer);
        if (featureRefusal) return res.status(403).json(upgradeRefusal(featureRefusal));
      }

      const summary = await requestClassSummary(liveClass);
      return res.json({ summary });
    } catch (err) {
      reportError(req, err);
      return res.status(500).json({ error: 'Failed to generate summary' });
    }
  }

  async function chatAboutClass(req, res) {
    try {
      const { value } = await getOpenAiKey();
      if (!value) {
        return res.status(400).json({ error: 'Tutor service is not configured' });
      }
      const { message } = req.body || {};
      if (!message || typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'message is required' });
      }
      if (message.length > MAX_CHAT_MESSAGE_LENGTH) {
        return res.status(400).json({ error: `message must be ${MAX_CHAT_MESSAGE_LENGTH} characters or less` });
      }
      const liveClass = await LiveClass.findById(req.params.id).lean();
      if (!liveClass) {
        return res.status(404).json({ error: 'Class not found' });
      }

      if (!can(req.user, 'CanViewClasses')) {
        if (!liveClass.is_published || liveClass.is_active === false) {
          return res.status(404).json({ error: 'Class not found' });
        }
        const viewer = await viewerFor(req.user);
        const lock = lockState(liveClass, viewer);
        if (lock) return res.status(403).json(upgradeRefusal(lock));
        // Final fix wave (Rec 3): the AI Tutor feature, gated exactly as it is
        // on a lecture, before the AI call.
        const featureRefusal = featureLock('ai_tutor', viewer);
        if (featureRefusal) return res.status(403).json(upgradeRefusal(featureRefusal));
      }

      const answer = await requestClassChat(message.trim(), liveClass);
      return res.json({ answer });
    } catch (err) {
      reportError(req, err);
      return res.status(500).json({ error: 'Failed to generate response' });
    }
  }

  async function createClassNote(req, res) {
    try {
      const { text, timestamp } = req.body || {};
      if (!text) {
        return res.status(400).json({ error: 'text is required' });
      }
      if (!isValidTextLength(String(text), 1, 2000)) {
        return res.status(400).json({ error: 'text must be between 1 and 2000 characters' });
      }

      const note = await LiveClassNote.create({
        class_id: req.params.id,
        user_id: req.userId,
        text,
        timestamp: timestamp || '',
      });

      return res.status(201).json({ note });
    } catch (err) {
      reportError(req, err);
      return res.status(500).json({ error: 'Failed to create note' });
    }
  }

  async function deleteClassNote(req, res) {
    try {
      const note = await LiveClassNote.findOne({
        _id: req.params.noteId,
        class_id: req.params.classId,
        user_id: req.userId,
      });
      if (!note) {
        return res.status(404).json({ error: 'Note not found' });
      }
      note.is_active = false;
      await note.save();
      return res.json({ ok: true });
    } catch (err) {
      reportError(req, err);
      return res.status(500).json({ error: 'Failed to delete note' });
    }
  }

  return {
    listClasses,
    createClass,
    updateClass,
    deleteClass,
    listClassNotes,
    createClassNote,
    deleteClassNote,
    getClassRecording,
    getClassJoinLink,
    getClassSummary,
    chatAboutClass,
  };
}

module.exports = { createClassesController };
