const Subject = require('../models/Subject');
const { isValidTextLength } = require('../utils/validation');

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function normalizeSubjectPayload(data = {}) {
  const name = String(data.name || '').trim();
  const slug = data.slug ? slugify(data.slug) : slugify(name);
  return {
    name,
    slug,
    color: String(data.color || '').trim(),
    is_active: data.is_active !== false,
    sort_order: Number(data.sort_order ?? 0) || 0,
  };
}

function normalizeSubtopicPayload(data = {}) {
  const name = String(data.name || '').trim();
  const slug = data.slug ? slugify(data.slug) : slugify(name);
  return {
    name,
    slug,
    is_active: data.is_active !== false,
  };
}

function createSubjectsController() {
  async function listSubjects(req, res) {
    try {
      const { all } = req.query;
      const filter = all === 'true' ? {} : { is_active: { $ne: false } };
      const subjects = await Subject.find(filter).sort({ sort_order: 1, name: 1 }).lean();
      return res.json({ subjects });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load subjects' });
    }
  }

  async function createSubject(req, res) {
    try {
      const data = normalizeSubjectPayload(req.body || {});
      if (!isValidTextLength(data.name, 2, 120)) {
        return res.status(400).json({ error: 'name must be between 2 and 120 characters' });
      }
      if (!data.slug) {
        return res.status(400).json({ error: 'slug is required' });
      }
      const existing = await Subject.findOne({ $or: [{ name: data.name }, { slug: data.slug }] });
      if (existing) {
        return res.status(409).json({ error: 'Subject already exists' });
      }
      const subject = await Subject.create(data);
      return res.status(201).json({ subject });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to create subject' });
    }
  }

  async function updateSubject(req, res) {
    try {
      const updates = normalizeSubjectPayload(req.body || {});
      if (!isValidTextLength(updates.name, 2, 120)) {
        return res.status(400).json({ error: 'name must be between 2 and 120 characters' });
      }
      const subject = await Subject.findById(req.params.id);
      if (!subject) {
        return res.status(404).json({ error: 'Subject not found' });
      }
      if (updates.name !== subject.name) {
        const existing = await Subject.findOne({
          _id: { $ne: subject._id },
          $or: [{ name: updates.name }, { slug: updates.slug }],
        });
        if (existing) {
          return res.status(409).json({ error: 'Subject already exists' });
        }
      }
      Object.assign(subject, updates);
      await subject.save();
      return res.json({ subject: subject.toObject() });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to update subject' });
    }
  }

  async function createSubtopic(req, res) {
    try {
      const payload = normalizeSubtopicPayload(req.body || {});
      if (!isValidTextLength(payload.name, 2, 120)) {
        return res.status(400).json({ error: 'name must be between 2 and 120 characters' });
      }
      if (!payload.slug) {
        return res.status(400).json({ error: 'slug is required' });
      }
      const subject = await Subject.findById(req.params.id);
      if (!subject) {
        return res.status(404).json({ error: 'Subject not found' });
      }
      const exists = subject.subtopics.some((item) => item.slug === payload.slug);
      if (exists) {
        return res.status(409).json({ error: 'Subtopic already exists' });
      }
      subject.subtopics.push(payload);
      await subject.save();
      return res.status(201).json({ subject: subject.toObject() });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to create subtopic' });
    }
  }

  async function updateSubtopic(req, res) {
    try {
      const payload = normalizeSubtopicPayload(req.body || {});
      if (!isValidTextLength(payload.name, 2, 120)) {
        return res.status(400).json({ error: 'name must be between 2 and 120 characters' });
      }
      const subject = await Subject.findById(req.params.id);
      if (!subject) {
        return res.status(404).json({ error: 'Subject not found' });
      }
      const subtopic = subject.subtopics.id(req.params.subtopicId);
      if (!subtopic) {
        return res.status(404).json({ error: 'Subtopic not found' });
      }
      const conflict = subject.subtopics.some(
        (item) => item.id !== subtopic.id && item.slug === payload.slug
      );
      if (conflict) {
        return res.status(409).json({ error: 'Subtopic already exists' });
      }
      subtopic.name = payload.name;
      subtopic.slug = payload.slug;
      subtopic.is_active = payload.is_active;
      await subject.save();
      return res.json({ subject: subject.toObject() });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to update subtopic' });
    }
  }

  return {
    listSubjects,
    createSubject,
    updateSubject,
    createSubtopic,
    updateSubtopic,
  };
}

module.exports = { createSubjectsController };
