const LiveClass = require('../models/LiveClass');
const LiveClassNote = require('../models/LiveClassNote');
const User = require('../models/User');
const { isValidTextLength } = require('../utils/validation');

function createClassesController({ createNotification }) {
  async function listClasses(req, res) {
    try {
      const { all } = req.query;
      const filter = {};
      if (all === 'true') {
        const user = await User.findById(req.userId).lean();
        if (!user || (user.role !== 'admin' && user.role !== 'teacher' && !user.is_teacher)) {
          return res.status(403).json({ error: 'Staff access required' });
        }
      } else {
        filter.is_published = true;
      }

      const classes = await LiveClass.find(filter).sort({ scheduled_date: -1 }).lean();
      const now = new Date();
      const updates = [];
      classes.forEach((liveClass) => {
        const start = new Date(liveClass.scheduled_date);
        const end = new Date(start.getTime() + (liveClass.duration_minutes || 60) * 60000);
        let nextStatus = liveClass.status;
        if (now >= start && now <= end) {
          nextStatus = 'live';
        } else if (now > end) {
          nextStatus = 'completed';
        } else {
          nextStatus = 'scheduled';
        }
        if (nextStatus !== liveClass.status) {
          updates.push({ id: liveClass._id, status: nextStatus });
          liveClass.status = nextStatus;
        }
      });
      if (updates.length > 0) {
        await Promise.all(
          updates.map((u) => LiveClass.findByIdAndUpdate(u.id, { $set: { status: u.status } }))
        );
      }
      return res.json({ classes });
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
      const liveClass = await LiveClass.create({
        title: data.title,
        description: data.description || '',
        subject: data.subject,
        teacher_name: data.teacher_name,
        teacher_email: data.teacher_email || '',
        scheduled_date: data.scheduled_date,
        duration_minutes: data.duration_minutes ?? 60,
        meeting_link: data.meeting_link || '',
        youtube_url: data.youtube_url || '',
        is_free: Boolean(data.is_free),
        is_published: Boolean(data.is_published),
        status: data.status || 'scheduled',
      });

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
      const liveClass = await LiveClass.findByIdAndDelete(req.params.id).lean();
      if (!liveClass) {
        return res.status(404).json({ error: 'Class not found' });
      }
      return res.json({ ok: true });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to delete class' });
    }
  }

  async function listClassNotes(req, res) {
    try {
      const notes = await LiveClassNote.find({
        class_id: req.params.id,
        user_id: req.userId,
      }).sort({ created_date: -1 }).lean();

      return res.json({ notes });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load notes' });
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
      const note = await LiveClassNote.findOneAndDelete({
        _id: req.params.noteId,
        class_id: req.params.classId,
        user_id: req.userId,
      });
      if (!note) {
        return res.status(404).json({ error: 'Note not found' });
      }
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
  };
}

module.exports = { createClassesController };
