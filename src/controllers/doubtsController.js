const Doubt = require('../models/Doubt');
const User = require('../models/User');
const { isValidEmail, isValidTextLength } = require('../utils/validation');
const { validateSubjectIfConfigured } = require('../utils/subjects');
const { capLimit, isValidObjectId } = require('../utils/security');
const { can } = require('../rbac/can');

// Fields that only a CanAnswerDoubts holder may set on PATCH /doubts/:id —
// answering and status/assignment changes (spec 5.3).
const STAFF_ONLY_DOUBT_FIELDS = [
  'status',
  'answer',
  'answer_image_url',
  'assigned_teacher_id',
  'assigned_teacher_email',
  'assigned_teacher_name',
];

function createDoubtsController({ createNotification }) {
  async function listDoubts(req, res) {
    try {
      const { status, student_email: studentEmail, all, limit } = req.query;
      const filter = {};
      if (status) {
        filter.status = status;
      }

      if (all === 'true') {
        if (!can(req.user, 'CanViewAllDoubts')) {
          return res.status(403).json({ error: 'Permission denied', required: ['CanViewAllDoubts'] });
        }
        if (studentEmail) {
          if (!isValidEmail(String(studentEmail))) {
            return res.status(400).json({ error: 'Invalid student_email format' });
          }
          filter.student_email = studentEmail;
        }
      } else {
        filter.student_id = req.userId;
      }

      const max = capLimit(limit, 100, 200);
      const doubts = await Doubt.find(filter).sort({ created_date: -1 }).limit(max).lean();
      return res.json({ doubts });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load doubts' });
    }
  }

  async function createDoubt(req, res) {
    try {
      const data = req.body || {};
      if (!data.subject || !data.question) {
        return res.status(400).json({ error: 'subject and question are required' });
      }
      if (!isValidTextLength(String(data.subject), 2, 200)) {
        return res.status(400).json({ error: 'subject must be between 2 and 200 characters' });
      }
      if (!isValidTextLength(String(data.question), 2, 4000)) {
        return res.status(400).json({ error: 'question must be between 2 and 4000 characters' });
      }
      if (data.topic && !isValidTextLength(String(data.topic), 2, 200)) {
        return res.status(400).json({ error: 'topic must be between 2 and 200 characters' });
      }
      if (data.assigned_teacher_email && !isValidEmail(String(data.assigned_teacher_email))) {
        return res.status(400).json({ error: 'Invalid assigned_teacher_email format' });
      }

      const user = req.user;

      // Whether the caller may control the answer/assignment state of the
      // doubt they are creating (same permission that gates PATCH answering).
      const isStaff = can(req.user, 'CanAnswerDoubts');
      let assignedTeacherId = data.assigned_teacher_id || null;
      let assignedTeacherEmail = '';
      let assignedTeacherName = '';
      if (isStaff) {
        assignedTeacherEmail = data.assigned_teacher_email || '';
        assignedTeacherName = data.assigned_teacher_name || '';
      }
      if (assignedTeacherId) {
        if (!isValidObjectId(String(assignedTeacherId))) {
          return res.status(400).json({ error: 'Invalid assigned_teacher_id' });
        }
        // Identity check on the TARGET user record (is the picked person a
        // teacher?), not a permission check on the caller — effective_permissions
        // is only computed for the authenticated caller, not for an arbitrary
        // user looked up by id, so this stays on the target's own schema fields.
        const teacher = await User.findById(assignedTeacherId).lean();
        const isTeacher = teacher && teacher.is_active !== false && (
          teacher.role === 'teacher'
          || teacher.role === 'admin'
          || teacher.is_teacher
          || (Array.isArray(teacher.roles) && teacher.roles.includes('teacher'))
        );
        if (!isTeacher) {
          if (!isStaff) {
            return res.status(400).json({ error: 'Selected teacher is not available' });
          }
        } else if (!isStaff) {
          // Students may pick a teacher, but the teacher details always come from the DB.
          assignedTeacherEmail = teacher.email || '';
          assignedTeacherName = teacher.full_name || '';
        } else {
          assignedTeacherEmail = assignedTeacherEmail || teacher.email || '';
          assignedTeacherName = assignedTeacherName || teacher.full_name || '';
        }
      }
      // Students cannot set workflow status; it is derived server-side.
      const initialStatus = isStaff && data.status
        ? data.status
        : (assignedTeacherId ? 'assigned' : 'pending');

      const subjectName = await validateSubjectIfConfigured(data.subject);
      const doubt = await Doubt.create({
        student_id: user._id,
        student_email: user.email,
        student_name: user.full_name || '',
        subject: subjectName,
        topic: data.topic || '',
        question: data.question,
        priority: data.priority || 'medium',
        image_url: data.image_url || '',
        status: initialStatus,
        assigned_teacher_id: assignedTeacherId,
        assigned_teacher_email: assignedTeacherEmail,
        assigned_teacher_name: assignedTeacherName,
      });

      await createNotification({
        userEmail: user.email,
        title: 'Doubt submitted',
        message: 'Your doubt has been submitted and will be reviewed shortly.',
        type: 'info',
      });
      if (assignedTeacherEmail) {
        await createNotification({
          userEmail: assignedTeacherEmail,
          title: 'New doubt assigned',
          message: doubt.topic || 'A new doubt has been assigned to you.',
          type: 'doubt',
          link: '/AdminDoubts',
        });
      } else {
        await createNotification({
          userEmail: 'teachers',
          title: 'New doubt submitted',
          message: doubt.topic || 'A student submitted a new doubt.',
          type: 'doubt',
          link: '/AdminDoubts',
        });
      }

      return res.status(201).json({ doubt });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to create doubt' });
    }
  }

  async function updateDoubt(req, res) {
    try {
      const doubt = await Doubt.findById(req.params.id);
      if (!doubt) {
        return res.status(404).json({ error: 'Doubt not found' });
      }

      const canAnswer = can(req.user, 'CanAnswerDoubts');
      const isOwner = String(doubt.student_id) === String(req.userId);
      if (!canAnswer && !isOwner) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      const updates = req.body || {};
      const triesStaffField = STAFF_ONLY_DOUBT_FIELDS.some((field) =>
        Object.prototype.hasOwnProperty.call(updates, field)
      );
      if (!canAnswer && triesStaffField) {
        return res.status(403).json({ error: 'Permission denied', required: ['CanAnswerDoubts'] });
      }

      const previousStatus = doubt.status;
      const previousTeacherEmail = doubt.assigned_teacher_email || '';
      const previousTeacherId = doubt.assigned_teacher_id ? String(doubt.assigned_teacher_id) : '';
      if (updates.assigned_teacher_email && !isValidEmail(String(updates.assigned_teacher_email))) {
        return res.status(400).json({ error: 'Invalid assigned_teacher_email format' });
      }
      if (updates.subject && !isValidTextLength(String(updates.subject), 2, 200)) {
        return res.status(400).json({ error: 'subject must be between 2 and 200 characters' });
      }
      if (updates.question && !isValidTextLength(String(updates.question), 2, 4000)) {
        return res.status(400).json({ error: 'question must be between 2 and 4000 characters' });
      }
      if (updates.topic && !isValidTextLength(String(updates.topic), 2, 200)) {
        return res.status(400).json({ error: 'topic must be between 2 and 200 characters' });
      }

      if (updates.subject) {
        updates.subject = await validateSubjectIfConfigured(updates.subject);
      }
      if (canAnswer) {
        STAFF_ONLY_DOUBT_FIELDS.forEach((field) => {
          if (Object.prototype.hasOwnProperty.call(updates, field)) {
            doubt[field] = updates[field];
          }
        });
      } else if (isOwner && doubt.status === 'pending') {
        const allowed = ['subject', 'topic', 'question', 'priority', 'image_url'];
        allowed.forEach((field) => {
          if (Object.prototype.hasOwnProperty.call(updates, field)) {
            doubt[field] = updates[field];
          }
        });
      }

      const wasResolved = previousStatus === 'resolved';
      const wasAssigned = previousStatus === 'assigned';

      if (canAnswer && updates.assigned_teacher_id && (!updates.assigned_teacher_email || !updates.assigned_teacher_name)) {
        const teacher = await User.findById(updates.assigned_teacher_id).lean();
        if (teacher) {
          if (!updates.assigned_teacher_email) {
            doubt.assigned_teacher_email = teacher.email || '';
          }
          if (!updates.assigned_teacher_name) {
            doubt.assigned_teacher_name = teacher.full_name || '';
          }
        }
      }

      await doubt.save();

      const nextTeacherEmail = doubt.assigned_teacher_email || '';
      const nextTeacherId = doubt.assigned_teacher_id ? String(doubt.assigned_teacher_id) : '';
      const teacherChanged =
        Boolean(nextTeacherEmail) &&
        (nextTeacherEmail !== previousTeacherEmail || (nextTeacherId && nextTeacherId !== previousTeacherId));

      if (!wasAssigned && doubt.status === 'assigned') {
        await createNotification({
          userEmail: doubt.student_email,
          title: 'Doubt assigned',
          message: 'A teacher has started working on your doubt.',
          type: 'info',
        });
        if (doubt.assigned_teacher_email) {
          await createNotification({
            userEmail: doubt.assigned_teacher_email,
            title: 'New doubt assigned',
            message: doubt.topic || 'A new doubt has been assigned to you.',
            type: 'doubt',
            link: '/AdminDoubts',
          });
        }
      } else if (teacherChanged) {
        await createNotification({
          userEmail: nextTeacherEmail,
          title: 'Doubt reassigned',
          message: doubt.topic || 'A doubt has been reassigned to you.',
          type: 'doubt',
          link: '/AdminDoubts',
        });
      }

      if (!wasResolved && doubt.status === 'resolved') {
        await createNotification({
          userEmail: doubt.student_email,
          title: 'Your doubt was answered',
          message: doubt.topic || 'Check the response from your teacher.',
          type: 'doubt_answered',
        });
      }

      return res.json({ doubt: doubt.toObject() });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to update doubt' });
    }
  }

  return {
    listDoubts,
    createDoubt,
    updateDoubt,
  };
}

module.exports = { createDoubtsController };
