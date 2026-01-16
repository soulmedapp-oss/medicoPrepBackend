const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Test = require('../models/Test');
const Question = require('../models/Question');

dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const TEST_TITLE = 'PSM Intermediate Test - Preventive & Social Medicine';
const SUBJECT = 'PSM';
const DIFFICULTY = 'medium';

const questions = [
  {
    question_text: 'A screening test with high sensitivity is most useful for:',
    options: [
      { id: '1', text: 'Confirming disease when the test is positive' },
      { id: '2', text: 'Ruling out disease when the test is negative' },
      { id: '3', text: 'Estimating incidence in the community' },
      { id: '4', text: 'Measuring disease severity' },
    ],
    correct_answers: ['2'],
    explanation:
      'High sensitivity minimizes false negatives, so a negative result helps rule out disease (SnNout).',
  },
  {
    question_text:
      'In a low-prevalence setting, which measure is most likely to be low even with high sensitivity and specificity?',
    options: [
      { id: '1', text: 'Positive predictive value (PPV)' },
      { id: '2', text: 'Negative predictive value (NPV)' },
      { id: '3', text: 'Specificity' },
      { id: '4', text: 'Sensitivity' },
    ],
    correct_answers: ['1'],
    explanation:
      'PPV falls as prevalence decreases because most positive results are false positives in low-prevalence settings.',
  },
  {
    question_text: 'The measure of association used in a case-control study is:',
    options: [
      { id: '1', text: 'Relative risk' },
      { id: '2', text: 'Odds ratio' },
      { id: '3', text: 'Attributable risk' },
      { id: '4', text: 'Risk difference' },
    ],
    correct_answers: ['2'],
    explanation:
      'Case-control studies sample by outcome, so odds ratio is the appropriate association measure.',
  },
  {
    question_text: 'In a steady state, prevalence is approximately:',
    options: [
      { id: '1', text: 'Incidence × duration' },
      { id: '2', text: 'Incidence ÷ duration' },
      { id: '3', text: 'Duration ÷ incidence' },
      { id: '4', text: 'Mortality × incidence' },
    ],
    correct_answers: ['1'],
    explanation:
      'Under steady-state assumptions, prevalence is roughly incidence multiplied by average duration.',
  },
  {
    question_text: 'Which option best represents the core principles of Primary Health Care?',
    options: [
      { id: '1', text: 'Equity, community participation, intersectoral coordination, appropriate technology' },
      { id: '2', text: 'Centralization, specialization, high technology, private funding' },
      { id: '3', text: 'Selective services, vertical programs, hospital-based care' },
      { id: '4', text: 'Curative focus, tertiary referral, insurance-driven access' },
    ],
    correct_answers: ['1'],
    explanation:
      'Primary Health Care emphasizes equity, community participation, intersectoral coordination, and appropriate technology.',
  },
  {
    question_text: 'The herd immunity threshold is approximately:',
    options: [
      { id: '1', text: '1 - (1 / R0)' },
      { id: '2', text: 'R0 - 1' },
      { id: '3', text: '1 / R0' },
      { id: '4', text: 'R0 / (R0 - 1)' },
    ],
    correct_answers: ['1'],
    explanation:
      'The threshold proportion immune is 1 − 1/R0 for diseases with homogeneous mixing.',
  },
  {
    question_text:
      'Refer to the epidemic curve image. The pattern most consistent with this curve is:',
    options: [
      { id: '1', text: 'Point-source outbreak' },
      { id: '2', text: 'Propagated outbreak' },
      { id: '3', text: 'Continuous common-source outbreak' },
      { id: '4', text: 'Seasonal/endemic pattern' },
    ],
    correct_answers: ['1'],
    explanation:
      'A sharp rise followed by a gradual decline suggests a point-source exposure. Image reference attached.',
    explanation_image_url: '/uploads/psm-epicurve.svg',
  },
  {
    question_text:
      'Recommended free residual chlorine at the consumer end after 30 minutes contact (pH < 8) is:',
    options: [
      { id: '1', text: '0.2 mg/L' },
      { id: '2', text: '0.5 mg/L' },
      { id: '3', text: '1.0 mg/L' },
      { id: '4', text: '2.0 mg/L' },
    ],
    correct_answers: ['1'],
    explanation:
      'A residual chlorine of about 0.2 mg/L after 30 minutes is considered adequate for safe drinking water.',
  },
  {
    question_text: 'Iceberg phenomenon is best exemplified by:',
    options: [
      { id: '1', text: 'Hypertension' },
      { id: '2', text: 'Rabies' },
      { id: '3', text: 'Cholera' },
      { id: '4', text: 'Measles' },
    ],
    correct_answers: ['1'],
    explanation:
      'Chronic diseases like hypertension have a large subclinical component, illustrating the iceberg phenomenon.',
    explanation_image_url: '/uploads/psm-iceberg.svg',
  },
  {
    question_text: 'The recommended cold chain storage range for most vaccines is:',
    options: [
      { id: '1', text: '-20°C to -10°C' },
      { id: '2', text: '0°C to 4°C' },
      { id: '3', text: '2°C to 8°C' },
      { id: '4', text: '8°C to 15°C' },
    ],
    correct_answers: ['3'],
    explanation:
      'Most routine vaccines are stored between 2°C and 8°C to maintain potency.',
  },
  {
    question_text: 'Attack rate in an outbreak is defined as:',
    options: [
      { id: '1', text: 'Number of new cases ÷ population at risk during the outbreak period' },
      { id: '2', text: 'Number of deaths ÷ total population' },
      { id: '3', text: 'Prevalence ÷ incidence' },
      { id: '4', text: 'Recovered cases ÷ total cases' },
    ],
    correct_answers: ['1'],
    explanation:
      'Attack rate is a cumulative incidence measure over the outbreak period among those at risk.',
  },
  {
    question_text: 'Lead-time bias in screening refers to:',
    options: [
      { id: '1', text: 'Apparent increase in survival time due to earlier diagnosis without delaying death' },
      { id: '2', text: 'Preferential detection of slow-growing disease' },
      { id: '3', text: 'Errors in assigning exposure status' },
      { id: '4', text: 'Random error due to small sample size' },
    ],
    correct_answers: ['1'],
    explanation:
      'Lead-time bias makes survival appear longer because diagnosis is earlier, even if outcome is unchanged.',
  },
];

async function seed() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('MONGODB_URI is not set');
  }

  await mongoose.connect(mongoUri, { autoIndex: true });

  let test = await Test.findOne({ title: TEST_TITLE, subject: SUBJECT });
  if (!test) {
    test = await Test.create({
      title: TEST_TITLE,
      description:
        'Intermediate-level practice test covering core concepts in Preventive & Social Medicine.',
      subject: SUBJECT,
      difficulty: DIFFICULTY,
      duration_minutes: 45,
      total_marks: questions.length,
      passing_marks: Math.ceil(questions.length * 0.4),
      is_free: true,
      is_published: true,
    });
  } else {
    await Test.findByIdAndUpdate(test._id, {
      $set: {
        description:
          'Intermediate-level practice test covering core concepts in Preventive & Social Medicine.',
        difficulty: DIFFICULTY,
        duration_minutes: 45,
        total_marks: questions.length,
        passing_marks: Math.ceil(questions.length * 0.4),
        is_free: true,
        is_published: true,
      },
    });
  }

  const existing = await Question.find({ test_id: test._id })
    .select('question_text')
    .lean();
  const existingSet = new Set(existing.map((q) => q.question_text));

  const toInsert = questions
    .filter((q) => !existingSet.has(q.question_text))
    .map((q) => ({
      ...q,
      test_id: test._id,
      subject: SUBJECT,
      question_type: 'single_choice',
      difficulty: DIFFICULTY,
      marks: 1,
      negative_marks: 0,
      required_plan: 'free',
      is_active: true,
    }));

  if (toInsert.length > 0) {
    await Question.insertMany(toInsert);
  }

  const count = await Question.countDocuments({ test_id: test._id, is_active: true });
  await Test.findByIdAndUpdate(test._id, { $set: { question_count: count } });

  // eslint-disable-next-line no-console
  console.log(
    `Seed complete. Test: ${test.title} | Added questions: ${toInsert.length} | Total questions: ${count}`
  );

  await mongoose.disconnect();
}

seed().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
