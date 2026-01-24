const LiveClass = require('../models/LiveClass');
const LiveClassNote = require('../models/LiveClassNote');
const User = require('../models/User');
const { isValidTextLength } = require('../utils/validation');
const { getZoomAccessToken, pickRecording, createZoomMeeting, zoomTokenConfigured } = require('../services/zoomService');
const { getOpenAiKey } = require('../services/settingsService');
const { requestClassSummary, requestClassChat } = require('../services/tutorService');
const { sendEmail } = require('../services/emailService');

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

function createClassesController({ createNotification }) {
  function canAccessClass(liveClass, planName) {
    if (liveClass.is_free) return true;
    const allowed = Array.isArray(liveClass.allowed_plans) ? liveClass.allowed_plans : [];
    if (allowed.length === 0) return true;
    return allowed.includes(planName);
  }

  async function listClasses(req, res) {
    try {
      const { all } = req.query;
      const filter = {};
      let userPlan = 'free';
      if (all === 'true') {
        const user = await User.findById(req.userId).lean();
        if (!user || (user.role !== 'admin' && user.role !== 'teacher' && !user.is_teacher)) {
          return res.status(403).json({ error: 'Staff access required' });
        }
      } else {
        const user = await User.findById(req.userId).lean();
        if (user?.subscription_plan) {
          userPlan = user.subscription_plan;
        }
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
      let visibleClasses = all === 'true'
        ? classes
        : classes.filter((liveClass) => canAccessClass(liveClass, userPlan));

      if (all !== 'true') {
        visibleClasses = visibleClasses.map((liveClass) => {
          const sanitized = { ...liveClass };
          delete sanitized.zoom_join_url;
          delete sanitized.zoom_start_url;
          return sanitized;
        });
      }
      return res.json({ classes: visibleClasses });
    } catch (err) {
      console.error(err);
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
        subject: data.subject,
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
          console.error('Failed to send class invite:', err);
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
      console.error(err);
      return res.status(500).json({ error: 'Failed to create class' });
    }
  }

  async function updateClass(req, res) {
    try {
      const updates = req.body || {};
      if (updates.title && !isValidTextLength(String(updates.title), 2, 200)) {
        return res.status(400).json({ error: 'title must be between 2 and 200 characters' });
      }
      if (updates.subject && !isValidTextLength(String(updates.subject), 2, 120)) {
        return res.status(400).json({ error: 'subject must be between 2 and 120 characters' });
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
      const liveClass = await LiveClass.findByIdAndUpdate(
        req.params.id,
        { $set: updates },
        { new: true }
      ).lean();

      if (!liveClass) {
        return res.status(404).json({ error: 'Class not found' });
      }

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
      console.error(err);
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
      await liveClass.save();
      return res.json({ ok: true, liveClass: liveClass.toObject() });
    } catch (err) {
      console.error(err);
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
      console.error(err);
      return res.status(500).json({ error: 'Failed to load notes' });
    }
  }

  async function getClassRecording(req, res) {
    try {
      const liveClass = await LiveClass.findById(req.params.id).lean();
      if (!liveClass) {
        return res.status(404).json({ error: 'Class not found' });
      }

      const isStaff = req.user?.role === 'admin' || req.user?.role === 'teacher' || req.user?.is_teacher;
      if (!isStaff) {
        if (!liveClass.is_published || liveClass.is_active === false) {
          return res.status(404).json({ error: 'Class not found' });
        }
        const user = await User.findById(req.userId).lean();
        const planName = user?.subscription_plan || 'free';
        if (!canAccessClass(liveClass, planName)) {
          return res.status(403).json({ error: 'Upgrade required' });
        }
      }

      const recording = pickRecording(liveClass.zoom_recording_files);
      let url = recording?.play_url || liveClass.recording_url || liveClass.youtube_url || '';
      if (recording?.download_url) {
        const token = await getZoomAccessToken().catch(() => null);
        if (token) {
          url = `${recording.download_url}?access_token=${encodeURIComponent(token)}`;
        } else if (!url) {
          url = recording.download_url;
        }
      }

      if (!url) {
        return res.status(404).json({ error: 'Recording not available' });
      }

      return res.json({ url, recording });
    } catch (err) {
      console.error(err);
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

      const user = await User.findById(req.userId).lean();
      const planName = user?.subscription_plan || 'free';
      if (!canAccessClass(liveClass, planName)) {
        return res.status(403).json({ error: 'Upgrade required' });
      }

      const url = liveClass.zoom_join_url || liveClass.meeting_link || '';
      if (!url) {
        return res.status(404).json({ error: 'Join link not available' });
      }
      return res.json({ url });
    } catch (err) {
      console.error(err);
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

      const isStaff = req.user?.role === 'admin' || req.user?.role === 'teacher' || req.user?.is_teacher;
      if (!isStaff) {
        if (!liveClass.is_published || liveClass.is_active === false) {
          return res.status(404).json({ error: 'Class not found' });
        }
        const user = await User.findById(req.userId).lean();
        const planName = user?.subscription_plan || 'free';
        if (!canAccessClass(liveClass, planName)) {
          return res.status(403).json({ error: 'Upgrade required' });
        }
      }

      const summary = await requestClassSummary(liveClass);
      return res.json({ summary });
    } catch (err) {
      console.error(err);
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
      if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: 'message is required' });
      }
      const liveClass = await LiveClass.findById(req.params.id).lean();
      if (!liveClass) {
        return res.status(404).json({ error: 'Class not found' });
      }

      const isStaff = req.user?.role === 'admin' || req.user?.role === 'teacher' || req.user?.is_teacher;
      if (!isStaff) {
        if (!liveClass.is_published || liveClass.is_active === false) {
          return res.status(404).json({ error: 'Class not found' });
        }
        const user = await User.findById(req.userId).lean();
        const planName = user?.subscription_plan || 'free';
        if (!canAccessClass(liveClass, planName)) {
          return res.status(403).json({ error: 'Upgrade required' });
        }
      }

      const answer = await requestClassChat(message.trim(), liveClass);
      return res.json({ answer });
    } catch (err) {
      console.error(err);
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
      console.error(err);
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
      console.error(err);
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
