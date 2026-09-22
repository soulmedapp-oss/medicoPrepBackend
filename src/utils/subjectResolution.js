const { slugify } = require('./subjects');

// Pure: decides which videos get which subject_id, and which cannot be
// resolved at all. Kept free of I/O so the migration's judgement can be
// tested without a database — the part that would otherwise only be
// exercised by running it against production data.
function resolveSubjectIds(videos, subjects) {
  const bySlug = new Map(subjects.map((subject) => [subject.slug, subject]));
  const updates = [];
  const unresolved = [];

  videos.forEach((video) => {
    // Already migrated: never re-resolve or clobber.
    if (video.subject_id) return;
    const subject = bySlug.get(slugify(video.subject));
    if (subject) updates.push({ _id: video._id, subject_id: subject._id });
    else unresolved.push({ _id: video._id, subject: video.subject });
  });

  return { updates, unresolved };
}

// The canonical name is stored alongside the id until the string column is
// dropped, so a rollback needs no data repair.
function subjectWriteFields(subject) {
  if (!subject || !subject._id) return {};
  return { subject_id: subject._id, subject: subject.name };
}

// An unresolvable subject must match NOTHING. Returning {} would drop the
// filter and silently show a student every lecture in the library.
function buildSubjectFilter(subject) {
  return subject && subject._id ? { subject_id: subject._id } : { _id: null };
}

module.exports = { resolveSubjectIds, subjectWriteFields, buildSubjectFilter };
