const Subject = require('../models/Subject');

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

async function validateSubjectIfConfigured(subjectName) {
  const name = String(subjectName || '').trim();
  if (!name) return name;
  const hasSubjects = await Subject.exists({});
  if (!hasSubjects) return name;
  const subject = await Subject.findOne({
    slug: slugify(name),
    is_active: { $ne: false },
  }).lean();
  if (!subject) {
    const error = new Error('subject is not active');
    error.code = 'SUBJECT_INACTIVE';
    throw error;
  }
  return subject.name;
}

module.exports = {
  slugify,
  validateSubjectIfConfigured,
};
