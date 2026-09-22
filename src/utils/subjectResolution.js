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

module.exports = { resolveSubjectIds };
