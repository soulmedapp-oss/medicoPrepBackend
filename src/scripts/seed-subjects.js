const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Subject = require('../models/Subject');
const { slugify } = require('../utils/subjects');

dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const SUBJECTS = [
  'Anatomy',
  'Physiology',
  'Biochemistry',
  'Pathology',
  'Pharmacology',
  'Microbiology',
  'Forensic Medicine',
  'Community Medicine',
  'ENT',
  'Ophthalmology',
  'Surgery',
  'Medicine',
  'Pediatrics',
  'OBG',
  'Psychiatry',
  'Radiology',
  'Anesthesia',
  'Dermatology',
  'Orthopedics',
];

const palette = [
  '#2563EB',
  '#0EA5E9',
  '#7C3AED',
  '#DB2777',
  '#F59E0B',
  '#10B981',
  '#14B8A6',
  '#E11D48',
  '#F97316',
  '#6366F1',
];

async function seedSubjects() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('MONGODB_URI is not set');
  }

  await mongoose.connect(mongoUri, { autoIndex: true });

  const results = [];
  for (let i = 0; i < SUBJECTS.length; i += 1) {
    const name = SUBJECTS[i];
    const slug = slugify(name);
    const existing = await Subject.findOne({ $or: [{ slug }, { name }] });
    const defaultColor = palette[i % palette.length];

    if (existing) {
      const updates = {
        name: existing.name || name,
        slug: existing.slug || slug,
        is_active: true,
      };
      if (!existing.color) {
        updates.color = defaultColor;
      }
      if (existing.sort_order == null) {
        updates.sort_order = i + 1;
      }
      await Subject.updateOne({ _id: existing._id }, { $set: updates });
      results.push({ name, action: 'updated' });
      continue;
    }

    await Subject.create({
      name,
      slug,
      color: defaultColor,
      sort_order: i + 1,
      is_active: true,
      subtopics: [],
    });
    results.push({ name, action: 'created' });
  }

  // eslint-disable-next-line no-console
  console.log(`Seeded ${results.length} subjects`);
  results.forEach((entry) => {
    // eslint-disable-next-line no-console
    console.log(`${entry.action}: ${entry.name}`);
  });

  await mongoose.disconnect();
}

seedSubjects().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
