const TeacherRequest = require('../models/TeacherRequest');
const User = require('../models/User');
const { isValidEmail, isValidPhone, isValidTextLength } = require('../utils/validation');

function createTeacherRequestsController({ createNotification }) {
  async function listTeacherRequests(req, res) {
    try {
      const { all, status, category, priority, type, limit } = req.query;
      const filter = {};
      if (status) filter.status = status;
      if (category) filter.category = category;
      if (priority) filter.priority = priority;
      if (type) filter.type = type;

      if (all === 'true') {
        const user = await User.findById(req.userId).lean();
        if (!user || user.role !== 'admin') {
          return res.status(403).json({ error: 'Admin access required' });
        }
      } else {
        filter.teacher_id = req.userId;
      }

      const max = Number(limit) || 100;
      const requests = await TeacherRequest.find(filter)
        .sort({ created_date: -1 })
        .limit(max)
        .lean();

      return res.json({ requests });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load teacher requests' });
    }
  }

  async function createTeacherRequest(req, res) {
    try {
      const data = req.body || {};
      if (!data.title || !data.description) {
        return res.status(400).json({ error: 'title and description are required' });
      }
      if (!isValidTextLength(String(data.title), 2, 200)) {
        return res.status(400).json({ error: 'title must be between 2 and 200 characters' });
      }
      if (!isValidTextLength(String(data.description), 10, 4000)) {
        return res.status(400).json({ error: 'description must be between 10 and 4000 characters' });
      }
      if (data.contact_email && !isValidEmail(String(data.contact_email))) {
        return res.status(400).json({ error: 'Invalid contact_email format' });
      }
      if (data.contact_phone && !isValidPhone(String(data.contact_phone))) {
        return res.status(400).json({ error: 'Invalid contact_phone format' });
      }

      const user = await User.findById(req.userId).lean();
      const isTeacher = user?.role === 'teacher' || user?.is_teacher;
      if (!isTeacher) {
        return res.status(403).json({ error: 'Teacher access required' });
      }

      const request = await TeacherRequest.create({
        teacher_id: user._id,
        teacher_email: user.email,
        teacher_name: user.full_name || '',
        type: data.type || 'suggestion',
        category: data.category || 'general',
        priority: data.priority || 'medium',
        module: data.module || '',
        impact: data.impact || 'students',
        title: data.title,
        description: data.description,
        desired_outcome: data.desired_outcome || '',
        reference_links: Array.isArray(data.reference_links) ? data.reference_links : [],
        contact_methods: Array.isArray(data.contact_methods) ? data.contact_methods : [],
        contact_email: data.contact_email || user.email,
        contact_phone: data.contact_phone || '',
        meeting_requested: Boolean(data.meeting_requested),
        preferred_time_slots: Array.isArray(data.preferred_time_slots) ? data.preferred_time_slots : [],
        timezone: data.timezone || '',
        status: 'open',
      });

      await createNotification({
        userEmail: user.email,
        title: 'Request submitted',
        message: 'Your request has been sent to the developer team.',
        type: 'info',
      });

      return res.status(201).json({ request });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to create teacher request' });
    }
  }

  async function updateTeacherRequest(req, res) {
    try {
      const request = await TeacherRequest.findById(req.params.id);
      if (!request) {
        return res.status(404).json({ error: 'Request not found' });
      }

      const user = await User.findById(req.userId).lean();
      const isAdmin = user?.role === 'admin';
      const isOwner = String(request.teacher_id) === String(req.userId);
      if (!isAdmin && !isOwner) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      const updates = req.body || {};
      if (isAdmin) {
        const allowed = [
          'status',
          'priority',
          'developer_response',
          'response_tags',
          'meeting_link',
          'meeting_time',
          'responded_by',
        ];
        allowed.forEach((field) => {
          if (Object.prototype.hasOwnProperty.call(updates, field)) {
            request[field] = updates[field];
          }
        });
        if (updates.developer_response) {
          request.responded_at = new Date();
        }
      } else if (isOwner && request.status === 'open') {
        const allowed = [
          'title',
          'description',
          'type',
          'category',
          'priority',
          'module',
          'impact',
          'desired_outcome',
          'reference_links',
          'contact_methods',
          'contact_email',
          'contact_phone',
          'meeting_requested',
          'preferred_time_slots',
          'timezone',
        ];
        allowed.forEach((field) => {
          if (Object.prototype.hasOwnProperty.call(updates, field)) {
            request[field] = updates[field];
          }
        });
      }

      await request.save();

      if (isAdmin) {
        await createNotification({
          userEmail: request.teacher_email,
          title: 'Developer response',
          message: updates.developer_response || `Your request is now ${request.status}.`,
          type: 'info',
        });
      }

      return res.json({ request: request.toObject() });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to update teacher request' });
    }
  }

  return {
    listTeacherRequests,
    createTeacherRequest,
    updateTeacherRequest,
  };
}

module.exports = { createTeacherRequestsController };
