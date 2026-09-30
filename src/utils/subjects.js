const Subject = require('../models/Subject');

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// Shared lookup used by both validateSubjectIfConfigured and
// resolveSubjectForWrite: resolves a subject name to its active Subject
// document via slug. Returns null when subject validation isn't configured
// yet (no Subject rows exist at all) or the name is blank — callers decide
// what "no subject" means for them. Throws SUBJECT_INACTIVE when subjects
// ARE configured but this name doesn't match an active one.
async function findActiveSubjectByName(subjectName) {
  const name = String(subjectName || '').trim();
  if (!name) return null;
  const hasSubjects = await Subject.exists({});
  if (!hasSubjects) return null;
  const subject = await Subject.findOne({
    slug: slugify(name),
    is_active: { $ne: false },
  }).lean();
  if (!subject) {
    const error = new Error('subject is not active');
    error.code = 'SUBJECT_INACTIVE';
    throw error;
  }
  return subject;
}

async function validateSubjectIfConfigured(subjectName) {
  const name = String(subjectName || '').trim();
  const subject = await findActiveSubjectByName(name);
  return subject ? subject.name : name;
}

// Returns { _id, name } for an active subject so callers can store a real
// reference. Throws the same SUBJECT_INACTIVE error as
// validateSubjectIfConfigured when subjects are configured but the name
// doesn't resolve; returns null when subject validation isn't configured yet
// (no Subject rows exist) or the name is blank, mirroring
// validateSubjectIfConfigured's bypass for that case.
async function resolveSubjectForWrite(subjectName) {
  const subject = await findActiveSubjectByName(subjectName);
  return subject ? { _id: subject._id, name: subject.name } : null;
}

module.exports = {
  slugify,
  validateSubjectIfConfigured,
  resolveSubjectForWrite,
};
