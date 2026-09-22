const path = require('path');
const mongoose = require('mongoose');
const { parse } = require('csv-parse/sync');
const Test = require('../models/Test');
const Question = require('../models/Question');
const TestAttempt = require('../models/TestAttempt');
const User = require('../models/User');
const { isValidTextLength } = require('../utils/validation');
const { validateSubjectIfConfigured } = require('../utils/subjects');
const { can, canAny } = require('../rbac/can');
const { missingUpdatePermissions } = require('../rbac/updatePermissions');
const { gradeAttempt, normalizeSubmittedAnswers } = require('../services/gradingService');
const { recordAudit, recordActiveStateChange, recordDeactivated } = require('../utils/audit');
const { truncateText } = require('../utils/security');

// Fix round 1, Minor 2: question_text is validated up to 4000 chars but
// target_label has no maxlength — truncate before it ever reaches recordAudit.
const LABEL_MAX = 120;
function questionLabel(question) {
  return truncateText(question?.question_text, LABEL_MAX);
}

const PLAN_RANKS = {
  free: 0,
  basic: 1,
  medium: 2,
  advance: 3,
  premium: 4,
  ultimate: 5,
};

// Canonical plans for bulk uploads. Legacy aliases "medium"/"advance" (still in
// PLAN_RANKS so old questions keep ranking correctly) are mapped to their
// current equivalents; anything unknown falls back to free.
function normalizePlan(value) {
  const plan = String(value || 'free').toLowerCase();
  if (plan === 'medium') return 'premium';
  if (plan === 'advance') return 'ultimate';
  return Object.prototype.hasOwnProperty.call(PLAN_RANKS, plan) ? plan : 'free';
}

const MAX_LIST_LIMIT = 200;
function clampLimit(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), MAX_LIST_LIMIT);
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Fields a manager may change on a test via PATCH /tests/:id.
const EDITABLE_TEST_FIELDS = [
  'title',
  'description',
  'subject',
  'difficulty',
  'duration_minutes',
  'total_marks',
  'passing_marks',
  'is_free',
  'required_plan',
  'is_published',
  'is_active',
  'publish_at',
  'available_from',
  'available_until',
];

// Fields never sent to students before they have completed an attempt.
const ANSWER_KEY_FIELDS = ['correct_answers', 'explanation', 'explanation_image_url'];

function stripAnswerKey(question) {
  const copy = { ...question };
  ANSWER_KEY_FIELDS.forEach((field) => { delete copy[field]; });
  if (Array.isArray(copy.media)) {
    copy.media = copy.media.filter((m) => m && m.role !== 'explanation');
  }
  return copy;
}

// Mirrors the question visibility used by GET /tests/:id/questions so a user is
// graded on exactly the questions they were shown.
function buildQuestionFilter(testId, user) {
  const filter = { test_id: testId };
  if (!canAny(user, ['CanViewTests', 'CanViewQuestions'])) {
    filter.is_active = true;
    const userRank = getPlanRank(user?.subscription_plan);
    filter.required_plan = {
      $in: Object.entries(PLAN_RANKS).filter(([, rank]) => rank <= userRank).map(([plan]) => plan),
    };
  }
  return filter;
}

// Scheduled publishing (decision 10.9). A test is live for students only when it
// is published, active, past its publish_at, and inside [available_from, available_until].
function studentScheduleClause(now = new Date()) {
  return {
    $and: [
      { $or: [{ publish_at: null }, { publish_at: { $lte: now } }] },
      { $or: [{ available_from: null }, { available_from: { $lte: now } }] },
      { $or: [{ available_until: null }, { available_until: { $gte: now } }] },
    ],
  };
}

function isTestLiveForStudent(test, now = new Date()) {
  if (!test || test.is_published !== true || test.is_active === false) return false;
  if (test.publish_at && new Date(test.publish_at) > now) return false;
  if (test.available_from && new Date(test.available_from) > now) return false;
  if (test.available_until && new Date(test.available_until) < now) return false;
  return true;
}

function loadBulkRecords(file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (ext === '.xlsx' || ext === '.xls') {
    let xlsx;
    try {
      // Optional dependency: only needed for Excel uploads.
      // eslint-disable-next-line global-require
      xlsx = require('xlsx');
    } catch (err) {
      throw new Error('Excel uploads require the "xlsx" package. Please upload CSV instead.');
    }
    const workbook = xlsx.read(file.buffer, { type: 'buffer', cellDates: false });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return [];
    const sheet = workbook.Sheets[sheetName];
    return xlsx.utils.sheet_to_json(sheet, {
      defval: '',
      raw: false,
      blankrows: false,
    });
  }

  const content = file.buffer.toString('utf8');
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
}

function getActor(req) {
  const user = req.user || {};
  return {
    id: user._id || req.userId || null,
    name: user.full_name || user.name || user.email || '',
  };
}

function getPlanRank(plan) {
  if (!plan) return 0;
  return PLAN_RANKS[plan] ?? 0;
}

function computeMedian(values) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

async function updateTestQuestionCount(testId) {
  if (!testId) return;
  const count = await Question.countDocuments({ test_id: testId, is_active: true });
  await Test.findByIdAndUpdate(testId, { $set: { question_count: count } });
}

async function updateTestAttemptCount(testId) {
  const count = await TestAttempt.countDocuments({ test_id: testId, status: 'completed' });
  await Test.findByIdAndUpdate(testId, { $set: { attempt_count: count } });
}

async function updateUserAttemptStats(userId) {
  const uid = mongoose.isValidObjectId(userId) ? new mongoose.Types.ObjectId(String(userId)) : userId;
  const [agg] = await TestAttempt.aggregate([
    { $match: { user_id: uid, status: 'completed' } },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        avg: { $avg: { $ifNull: ['$percentage', 0] } },
      },
    },
  ]);
  const testsTaken = agg?.count || 0;
  const avgScore = testsTaken ? (agg.avg || 0) : 0;
  await User.findByIdAndUpdate(userId, {
    $set: { tests_taken: testsTaken, average_score: avgScore },
  });
}

function createTestsController({ createNotification, broadcastUserEvent, enqueueTutorSession }) {
  async function listTests(req, res) {
    try {
      const { all } = req.query;
      if (all === 'true') {
        if (!canAny(req.user, ['CanViewTests', 'CanViewQuestions'])) {
          return res.status(403).json({ error: 'Staff access required' });
        }
      }
      const filter = all === 'true'
        ? {}
        : { is_published: true, is_active: { $ne: false }, ...studentScheduleClause() };
      const tests = await Test.find(filter)
        .sort({ created_date: -1 })
        .limit(clampLimit(req.query.limit, MAX_LIST_LIMIT))
        .lean();
      return res.json({ tests });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load tests' });
    }
  }

  async function getTest(req, res) {
    try {
      const test = await Test.findById(req.params.id).lean();
      if (!test) {
        return res.status(404).json({ error: 'Test not found' });
      }
      if (test.is_active === false) {
        if (!canAny(req.user, ['CanViewTests', 'CanViewQuestions'])) {
          return res.status(404).json({ error: 'Test not found' });
        }
      }
      if (!test.is_published || !isTestLiveForStudent(test)) {
        if (!canAny(req.user, ['CanViewTests', 'CanViewQuestions'])) {
          return res.status(test.is_published ? 404 : 403).json({
            error: test.is_published ? 'Test not available' : 'Staff access required',
          });
        }
      }
      return res.json({ test });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load test' });
    }
  }

  async function createTest(req, res) {
    try {
      const data = req.body || {};
      if (!isValidTextLength(String(data.title || ''), 2, 200)) {
        return res.status(400).json({ error: 'title must be between 2 and 200 characters' });
      }
      if (!isValidTextLength(String(data.subject || ''), 2, 120)) {
        return res.status(400).json({ error: 'subject must be between 2 and 120 characters' });
      }

      const actor = getActor(req);
      const subjectName = await validateSubjectIfConfigured(data.subject);
      const requestedPlan = String(
        data.required_plan || (data.is_free ? 'free' : 'premium')
      ).toLowerCase();
      const test = await Test.create({
        title: data.title,
        description: data.description || '',
        subject: subjectName,
        difficulty: data.difficulty || 'medium',
        duration_minutes: data.duration_minutes ?? 60,
        total_marks: data.total_marks ?? 100,
        passing_marks: data.passing_marks ?? 40,
        is_free: requestedPlan === 'free',
        required_plan: requestedPlan,
        is_published: Boolean(data.is_published),
        created_by: actor.id,
        created_by_name: actor.name,
        updated_by: actor.id,
        updated_by_name: actor.name,
      });

      if (Array.isArray(data.question_ids) && data.question_ids.length > 0) {
        const ids = data.question_ids.filter(Boolean);
        if (ids.length > 0) {
          await Question.updateMany(
            { _id: { $in: ids }, $or: [{ test_id: null }, { test_id: test._id }] },
            { $set: { test_id: test._id } }
          );
          await updateTestQuestionCount(test._id);
        }
      }

      if (test.is_published) {
        await createNotification({
          userEmail: 'students',
          title: 'New test available',
          message: test.title || 'A new test is now available.',
          type: 'test_result',
        });
      }
      return res.status(201).json({ test });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to create test' });
    }
  }

  async function updateTest(req, res) {
    try {
      const body = req.body || {};
      const updates = {};
      EDITABLE_TEST_FIELDS.forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(body, field)) updates[field] = body[field];
      });
      const existing = await Test.findById(req.params.id).lean();
      if (!existing) {
        return res.status(404).json({ error: 'Test not found' });
      }
      const missing = missingUpdatePermissions(req.user, updates, existing, { edit: 'CanEditTests', deactivate: 'CanDeactivateTests' });
      if (missing) return res.status(403).json({ error: 'Permission denied', required: missing });
      if (updates.title && !isValidTextLength(String(updates.title), 2, 200)) {
        return res.status(400).json({ error: 'title must be between 2 and 200 characters' });
      }
      if (updates.subject && !isValidTextLength(String(updates.subject), 2, 120)) {
        return res.status(400).json({ error: 'subject must be between 2 and 120 characters' });
      }
      if (updates.subject) {
        updates.subject = await validateSubjectIfConfigured(updates.subject);
      }
      if (Object.prototype.hasOwnProperty.call(updates, 'required_plan')) {
        const plan = String(updates.required_plan || 'free').toLowerCase();
        updates.required_plan = plan;
        updates.is_free = plan === 'free';
      } else if (Object.prototype.hasOwnProperty.call(updates, 'is_free')) {
        updates.required_plan = updates.is_free ? 'free' : 'premium';
      }
      const actor = getActor(req);
      updates.updated_by = actor.id;
      updates.updated_by_name = actor.name;
      const test = await Test.findByIdAndUpdate(
        req.params.id,
        { $set: updates },
        { new: true, runValidators: true }
      ).lean();
      if (!test) {
        return res.status(404).json({ error: 'Test not found' });
      }
      await recordActiveStateChange(req, { resource: 'test', before: existing, after: test, targetLabel: test.title });
      const justPublished = !existing?.is_published && test.is_published;
      const changedTitle = existing?.title !== test.title;
      if (justPublished || changedTitle) {
        await createNotification({
          userEmail: 'students',
          title: justPublished ? 'Test published' : 'Test updated',
          message: test.title || 'A test was updated.',
          type: 'test_result',
        });
      }
      return res.json({ test });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to update test' });
    }
  }

  async function deleteTest(req, res) {
    try {
      const actor = getActor(req);
      const test = await Test.findById(req.params.id);
      if (!test) {
        return res.status(404).json({ error: 'Test not found' });
      }
      test.is_active = false;
      test.is_published = false;
      test.updated_by = actor.id;
      test.updated_by_name = actor.name;
      await test.save();
      await recordDeactivated(req, { resource: 'test', targetId: test._id, targetLabel: test.title });
      return res.json({ ok: true, test: test.toObject() });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to deactivate test' });
    }
  }

  async function listTestQuestions(req, res) {
    try {
      const test = await Test.findById(req.params.id).lean();
      if (!test) {
        return res.status(404).json({ error: 'Test not found' });
      }
      const isStaff = canAny(req.user, ['CanViewTests', 'CanViewQuestions']);
      if (test.is_active === false && !isStaff) {
        return res.status(404).json({ error: 'Test not found' });
      }

      if (!isStaff && !isTestLiveForStudent(test)) {
        return res.status(404).json({ error: 'Test not available' });
      }
      const filter = buildQuestionFilter(req.params.id, req.user);

      const questions = await Question.find(filter).sort({ created_date: 1 }).lean();
      // Students never receive the answer key here; they get it from
      // GET /attempts/:id/review (or the completion PATCH) once their attempt is completed.
      // Per spec 5.2, seeing the answer key here specifically requires CanViewQuestions
      // (narrower than the CanViewTests-or-CanViewQuestions test/question visibility gate above).
      const canSeeAnswerKey = can(req.user, 'CanViewQuestions');
      return res.json({ questions: canSeeAnswerKey ? questions : questions.map(stripAnswerKey) });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load questions' });
    }
  }

  async function createTestQuestion(req, res) {
    try {
      const test = await Test.findById(req.params.id).lean();
      if (!test) {
        return res.status(404).json({ error: 'Test not found' });
      }

      const data = req.body || {};
      if (!isValidTextLength(String(data.question_text || ''), 2, 4000)) {
        return res.status(400).json({ error: 'question_text must be between 2 and 4000 characters' });
      }
      if (!Array.isArray(data.correct_answers) || data.correct_answers.length === 0) {
        return res.status(400).json({ error: 'correct_answers is required' });
      }

      const actor = getActor(req);
      const question = await Question.create({
        test_id: req.params.id,
        subject: test.subject,
        question_text: data.question_text,
        question_type: data.question_type || 'single_choice',
        subtopic: data.subtopic || '',
        topic: data.topic || '', exam: data.exam || '', exam_year: data.exam_year || null, source_type: data.source_type || 'question_bank',
        options: data.options || [],
        correct_answers: data.correct_answers || [],
        explanation: data.explanation || '',
        explanation_image_url: data.explanation_image_url || '',
        question_image_url: data.question_image_url || '',
        difficulty: data.difficulty || 'medium',
        marks: data.marks ?? 1,
        negative_marks: data.negative_marks ?? 0,
        required_plan: data.required_plan || 'free',
        is_active: data.is_active !== false,
        is_through_upload: false,
        created_by: actor.id,
        created_by_name: actor.name,
        updated_by: actor.id,
        updated_by_name: actor.name,
      });

      await updateTestQuestionCount(req.params.id);
      return res.status(201).json({ question });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to create question' });
    }
  }

  async function bulkCsvTestQuestions(req, res) {
    try {
      const test = await Test.findById(req.params.id).lean();
      if (!test) {
        return res.status(404).json({ error: 'Test not found' });
      }
      const file = req.file;
      if (!file) {
        return res.status(400).json({ error: 'CSV or Excel file is required' });
      }

      const records = loadBulkRecords(file);

      const actor = getActor(req);
      const created = [];
      const errors = [];

      records.forEach((row, index) => {
        try {
          const questionText = row.question_text || row.question || row.Question;
          if (!questionText) {
            throw new Error('question_text is required');
          }

          const optionA = row.option_a || row.optionA || row.a || row.A || '';
          const optionB = row.option_b || row.optionB || row.b || row.B || '';
          const optionC = row.option_c || row.optionC || row.c || row.C || '';
          const optionD = row.option_d || row.optionD || row.d || row.D || '';
          const optionAImage = row.option_a_image_url || row.optionAImage || row.option_a_image || '';
          const optionBImage = row.option_b_image_url || row.optionBImage || row.option_b_image || '';
          const optionCImage = row.option_c_image_url || row.optionCImage || row.option_c_image || '';
          const optionDImage = row.option_d_image_url || row.optionDImage || row.option_d_image || '';
          const options = [
            { id: '1', text: String(optionA), image_url: String(optionAImage || '') },
            { id: '2', text: String(optionB), image_url: String(optionBImage || '') },
            { id: '3', text: String(optionC), image_url: String(optionCImage || '') },
            { id: '4', text: String(optionD), image_url: String(optionDImage || '') },
          ];

          const correctRaw = row.correct_answers || row.correct || row.answer || '';
          const correctTokens = String(correctRaw)
            .split(/[,|;]/)
            .map((token) => token.trim().toUpperCase())
            .filter(Boolean);
          const mapAnswer = { A: '1', B: '2', C: '3', D: '4' };
          const correct_answers = correctTokens.map((token) => mapAnswer[token]).filter(Boolean);
          if (correct_answers.length === 0) {
            throw new Error('correct_answers is required');
          }

          const question_type =
            String(row.question_type || row.type || 'single_choice').toLowerCase() === 'multiple_choice'
              ? 'multiple_choice'
              : 'single_choice';

          const difficulty = String(row.difficulty || 'medium').toLowerCase();
          const marks = Number(row.marks ?? 1) || 1;
          const negative_marks = Number(row.negative_marks ?? 0) || 0;
          const required_plan = normalizePlan(row.required_plan || row.plan);

          created.push({
            test_id: req.params.id,
            subject: test.subject,
            question_text: String(questionText),
            question_type,
            options,
            correct_answers,
            explanation: String(row.explanation || ''),
            explanation_image_url: String(row.explanation_image_url || ''),
            difficulty,
            marks,
            negative_marks,
            required_plan,
            is_active: true,
            is_through_upload: true,
            created_by: actor.id,
            created_by_name: actor.name,
            updated_by: actor.id,
            updated_by_name: actor.name,
          });
        } catch (err) {
          errors.push({ row: index + 1, error: err.message });
        }
      });

      if (created.length === 0) {
        return res.status(400).json({ error: 'No valid questions found', errors });
      }

      const inserted = await Question.insertMany(created);
      await updateTestQuestionCount(req.params.id);
      return res.status(201).json({
        inserted: inserted.length,
        errors,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to import questions' });
    }
  }

  async function assignQuestions(req, res) {
    try {
      const test = await Test.findById(req.params.id).lean();
      if (!test) {
        return res.status(404).json({ error: 'Test not found' });
      }
      const { question_ids: questionIds } = req.body || {};
      if (!Array.isArray(questionIds) || questionIds.length === 0) {
        return res.status(400).json({ error: 'question_ids is required' });
      }
      const ids = questionIds.filter(Boolean);
      await Question.updateMany(
        { _id: { $in: ids }, $or: [{ test_id: null }, { test_id: test._id }] },
        { $set: { test_id: test._id } }
      );
      await updateTestQuestionCount(test._id);
      return res.json({ assigned: ids.length });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to assign questions' });
    }
  }

  async function unassignQuestions(req, res) {
    try {
      const test = await Test.findById(req.params.id).lean();
      if (!test) {
        return res.status(404).json({ error: 'Test not found' });
      }
      const { question_ids: questionIds } = req.body || {};
      if (!Array.isArray(questionIds) || questionIds.length === 0) {
        return res.status(400).json({ error: 'question_ids is required' });
      }
      const ids = questionIds.filter(Boolean);
      await Question.updateMany(
        { _id: { $in: ids }, test_id: test._id },
        { $set: { test_id: null } }
      );
      await updateTestQuestionCount(test._id);
      return res.json({ unassigned: ids.length });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to unassign questions' });
    }
  }

  async function listQuestionBank(req, res) {
    try {
      const { subject, difficulty, search, limit } = req.query;
      const filter = { test_id: null };
      if (subject) filter.subject = subject;
      if (difficulty) filter.difficulty = difficulty;
      for (const key of ['source_type', 'exam', 'topic', 'subtopic', 'question_code']) {
        if (req.query[key]) filter[key] = String(req.query[key]);
      }
      if (req.query.exam_year) {
        const year = Number(req.query.exam_year);
        if (!Number.isInteger(year) || year < 1950 || year > new Date().getFullYear()) {
          return res.status(400).json({ error: 'Invalid exam year' });
        }
        filter.exam_year = year;
      }
      if (search) {
        const text = String(search).slice(0, 200).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.$or = ['question_text', 'question_code', 'exam', 'topic', 'subtopic'].map(key => ({ [key]: new RegExp(text, 'i') }));
      }
      const max = Math.min(1000, Math.max(1, Number(limit) || 200));
      const questions = await Question.find(filter).sort({ created_date: -1 }).limit(max).lean();
      return res.json({ questions });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load question bank' });
    }
  }

  async function listAllQuestions(req, res) {
    try {
      const { subject, difficulty, search, limit } = req.query;
      const filter = {};
      if (subject) filter.subject = subject;
      if (difficulty) filter.difficulty = difficulty;
      if (search) {
        filter.question_text = new RegExp(escapeRegex(String(search).slice(0, 200)), 'i');
      }
      const max = clampLimit(limit, MAX_LIST_LIMIT);
      const questions = await Question.find(filter).sort({ created_date: -1 }).limit(max).lean();
      return res.json({ questions });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load questions' });
    }
  }

  async function createQuestionBank(req, res) {
    try {
      const data = req.body || {};
      if (!isValidTextLength(String(data.subject || ''), 2, 120)) {
        return res.status(400).json({ error: 'subject must be between 2 and 120 characters' });
      }
      if (!isValidTextLength(String(data.question_text || ''), 2, 4000)) {
        return res.status(400).json({ error: 'question_text must be between 2 and 4000 characters' });
      }
      if (!Array.isArray(data.correct_answers) || data.correct_answers.length === 0) {
        return res.status(400).json({ error: 'correct_answers is required' });
      }
      const actor = getActor(req);
      const subjectName = await validateSubjectIfConfigured(data.subject);
      const question = await Question.create({
        test_id: null,
        subject: subjectName,
        question_text: data.question_text,
        question_type: data.question_type || 'single_choice',
        subtopic: data.subtopic || '',
        topic: data.topic || '', exam: data.exam || '', exam_year: data.exam_year || null, source_type: data.source_type || 'question_bank',
        options: data.options || [],
        correct_answers: data.correct_answers || [],
        explanation: data.explanation || '',
        explanation_image_url: data.explanation_image_url || '',
        question_image_url: data.question_image_url || '',
        difficulty: data.difficulty || 'medium',
        marks: data.marks ?? 1,
        negative_marks: data.negative_marks ?? 0,
        required_plan: data.required_plan || 'free',
        is_active: data.is_active !== false,
        is_through_upload: false,
        created_by: actor.id,
        created_by_name: actor.name,
        updated_by: actor.id,
        updated_by_name: actor.name,
      });
      return res.status(201).json({ question });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to create question' });
    }
  }

  async function bulkCsvQuestionBank(req, res) {
    try {
      const file = req.file;
      if (!file) {
        return res.status(400).json({ error: 'CSV or Excel file is required' });
      }

      const records = loadBulkRecords(file);

      const actor = getActor(req);
      const created = [];
      const errors = [];

      for (let index = 0; index < records.length; index += 1) {
        const row = records[index];
        try {
          const questionText = row.question_text || row.question || row.Question;
          if (!questionText) {
            throw new Error('question_text is required');
          }

          const subject = row.subject || row.Subject || req.body.subject;
          if (!subject) {
            throw new Error('subject is required');
          }
          let subjectName;
          try {
            subjectName = await validateSubjectIfConfigured(subject);
          } catch (err) {
            const message = `Subject "${subject}" does not exist. Please create it.`;
            errors.push({ row: index + 1, error: message });
            continue;
          }

          const optionA = row.option_a || row.optionA || row.a || row.A || '';
          const optionB = row.option_b || row.optionB || row.b || row.B || '';
          const optionC = row.option_c || row.optionC || row.c || row.C || '';
          const optionD = row.option_d || row.optionD || row.d || row.D || '';
          const optionAImage = row.option_a_image_url || row.optionAImage || row.option_a_image || '';
          const optionBImage = row.option_b_image_url || row.optionBImage || row.option_b_image || '';
          const optionCImage = row.option_c_image_url || row.optionCImage || row.option_c_image || '';
          const optionDImage = row.option_d_image_url || row.optionDImage || row.option_d_image || '';
          const options = [
            { id: '1', text: String(optionA), image_url: String(optionAImage || '') },
            { id: '2', text: String(optionB), image_url: String(optionBImage || '') },
            { id: '3', text: String(optionC), image_url: String(optionCImage || '') },
            { id: '4', text: String(optionD), image_url: String(optionDImage || '') },
          ];

          const correctRaw = row.correct_answers || row.correct || row.answer || '';
          const correctTokens = String(correctRaw)
            .split(/[,|;]/)
            .map((token) => token.trim().toUpperCase())
            .filter(Boolean);
          const mapAnswer = { A: '1', B: '2', C: '3', D: '4' };
          const correct_answers = correctTokens.map((token) => mapAnswer[token]).filter(Boolean);
          if (correct_answers.length === 0) {
            throw new Error('correct_answers is required');
          }

          const question_type =
            String(row.question_type || row.type || 'single_choice').toLowerCase() === 'multiple_choice'
              ? 'multiple_choice'
              : 'single_choice';

          const difficulty = String(row.difficulty || 'medium').toLowerCase();
          const marks = Number(row.marks ?? 1) || 1;
          const negative_marks = Number(row.negative_marks ?? 0) || 0;
          const required_plan = normalizePlan(row.required_plan || row.plan);

          created.push({
            test_id: null,
            subject: String(subjectName || subject),
            question_text: String(questionText),
            question_type,
            options,
            correct_answers,
            explanation: String(row.explanation || ''),
            explanation_image_url: String(row.explanation_image_url || ''),
            difficulty,
            marks,
            negative_marks,
            required_plan,
            is_active: true,
            is_through_upload: true,
            created_by: actor.id,
            created_by_name: actor.name,
            updated_by: actor.id,
            updated_by_name: actor.name,
          });
        } catch (err) {
          errors.push({ row: index + 1, error: err.message });
        }
      }

      if (created.length === 0) {
        return res.status(400).json({ error: 'No valid questions found', errors });
      }

      const inserted = await Question.insertMany(created);
      return res.status(201).json({
        inserted: inserted.length,
        errors,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to import questions' });
    }
  }

  async function updateQuestionBank(req, res) {
    try {
      const existing = await Question.findById(req.params.id);
      if (!existing || existing.test_id) {
        return res.status(404).json({ error: 'Question not found' });
      }
      const updates = req.body || {};
      const missing = missingUpdatePermissions(req.user, updates, existing, { edit: 'CanEditQuestionBank', deactivate: 'CanDeactivateQuestionBank' });
      if (missing) return res.status(403).json({ error: 'Permission denied', required: missing });
      if (updates.subject && !isValidTextLength(String(updates.subject), 2, 120)) {
        return res.status(400).json({ error: 'subject must be between 2 and 120 characters' });
      }
      if (updates.subject) {
        updates.subject = await validateSubjectIfConfigured(updates.subject);
      }
      if (updates.question_text && !isValidTextLength(String(updates.question_text), 2, 4000)) {
        return res.status(400).json({ error: 'question_text must be between 2 and 4000 characters' });
      }
      const actor = getActor(req);
      const wasActive = existing.is_active !== false;
      Object.assign(existing, updates);
      existing.updated_by = actor.id;
      existing.updated_by_name = actor.name;
      await existing.save();
      await recordActiveStateChange(req, {
        resource: 'question_bank',
        before: { is_active: wasActive },
        after: existing,
        targetLabel: questionLabel(existing),
      });
      // Final review fix round 1, Important: Task 17 widened this route to
      // any(CanEditQuestionBank, CanDeactivateQuestionBank), but the answer
      // key (spec 5.2) is reserved for CanViewQuestions specifically — a
      // Deactivate-only actor must not read it off this response.
      const canSeeAnswerKeyBank = can(req.user, 'CanViewQuestions');
      return res.json({ question: canSeeAnswerKeyBank ? existing.toObject() : stripAnswerKey(existing.toObject()) });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to update question' });
    }
  }

  async function deleteQuestionBank(req, res) {
    try {
      const existing = await Question.findById(req.params.id);
      if (!existing || existing.test_id) {
        return res.status(404).json({ error: 'Question not found' });
      }
      existing.is_active = false;
      await existing.save();
      await recordDeactivated(req, { resource: 'question_bank', targetId: existing._id, targetLabel: questionLabel(existing) });
      // Final review fix round 1, Important: same answer-key gate as above.
      const canSeeAnswerKeyBank = can(req.user, 'CanViewQuestions');
      return res.json({ ok: true, question: canSeeAnswerKeyBank ? existing.toObject() : stripAnswerKey(existing.toObject()) });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to deactivate question' });
    }
  }

  async function updateQuestion(req, res) {
    try {
      const existing = await Question.findById(req.params.id);
      if (!existing) {
        return res.status(404).json({ error: 'Question not found' });
      }
      const updates = req.body || {};
      const missing = missingUpdatePermissions(req.user, updates, existing, { edit: 'CanEditQuestions', deactivate: 'CanDeactivateQuestions' });
      if (missing) return res.status(403).json({ error: 'Permission denied', required: missing });
      if (updates.question_text && !isValidTextLength(String(updates.question_text), 2, 4000)) {
        return res.status(400).json({ error: 'question_text must be between 2 and 4000 characters' });
      }
      const actor = getActor(req);
      const previousTestId = existing.test_id;
      const wasActive = existing.is_active !== false;
      Object.assign(existing, updates);
      existing.updated_by = actor.id;
      existing.updated_by_name = actor.name;
      await existing.save();
      await recordActiveStateChange(req, {
        resource: 'question',
        before: { is_active: wasActive },
        after: existing,
        targetLabel: questionLabel(existing),
      });

      const nextTestId = existing.test_id;
      const previousId = previousTestId ? String(previousTestId) : '';
      const nextId = nextTestId ? String(nextTestId) : '';

      if (previousId && previousId !== nextId) {
        await updateTestQuestionCount(previousTestId);
      }
      if (nextId) {
        await updateTestQuestionCount(nextTestId);
      }

      // Final review fix round 1, Important: same answer-key gate as
      // listTestQuestions/updateQuestionBank — a Deactivate-only actor (no
      // CanViewQuestions) must not read the answer key off this response.
      const canSeeAnswerKeyQ = can(req.user, 'CanViewQuestions');
      return res.json({ question: canSeeAnswerKeyQ ? existing.toObject() : stripAnswerKey(existing.toObject()) });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to update question' });
    }
  }

  async function deleteQuestion(req, res) {
    try {
      const question = await Question.findById(req.params.id);
      if (!question) {
        return res.status(404).json({ error: 'Question not found' });
      }
      question.is_active = false;
      await question.save();
      // Fix round 1, Minor 1: audit immediately after the write that actually
      // deactivates, before updateTestQuestionCount (which can throw) — so
      // the entry survives even if that later step fails.
      await recordDeactivated(req, { resource: 'question', targetId: question._id, targetLabel: questionLabel(question) });
      await updateTestQuestionCount(question.test_id);
      // Final review fix round 1, Important: same answer-key gate as above.
      const canSeeAnswerKeyQ = can(req.user, 'CanViewQuestions');
      return res.json({ ok: true, question: canSeeAnswerKeyQ ? question.toObject() : stripAnswerKey(question.toObject()) });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to deactivate question' });
    }
  }

  async function bulkDeleteQuestions(req, res) {
    try {
      const { question_ids: questionIds } = req.body || {};
      if (!Array.isArray(questionIds) || questionIds.length === 0) {
        return res.status(400).json({ error: 'question_ids is required' });
      }
      const ids = questionIds.filter(Boolean);
      const existing = await Question.find({ _id: { $in: ids } })
        .select('_id test_id')
        .lean();
      if (existing.length === 0) {
        return res.status(404).json({ error: 'Questions not found' });
      }
      await Question.updateMany(
        { _id: { $in: ids } },
        { $set: { is_active: false } }
      );

      // Fix round 1, Minor 1: audit immediately after the write that
      // actually deactivates, before the per-test updateTestQuestionCount
      // loop below (which can throw) — one entry for the whole bulk
      // operation, not one per question (addendum A).
      await recordAudit(req, {
        action: 'question.deactivated',
        target_type: 'question',
        target_label: `${existing.length} questions`,
        after: { ids: existing.map((question) => String(question._id)) },
      });

      const testIds = [...new Set(
        existing
          .map((question) => (question.test_id ? String(question.test_id) : ''))
          .filter(Boolean)
      )];
      for (const testId of testIds) {
        await updateTestQuestionCount(testId);
      }

      return res.json({ deactivated: existing.length });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to deactivate questions' });
    }
  }

  async function bulkActivateQuestions(req, res) {
    try {
      const { question_ids: questionIds } = req.body || {};
      if (!Array.isArray(questionIds) || questionIds.length === 0) {
        return res.status(400).json({ error: 'question_ids is required' });
      }
      const ids = questionIds.filter(Boolean);
      const existing = await Question.find({ _id: { $in: ids } })
        .select('_id test_id')
        .lean();
      if (existing.length === 0) {
        return res.status(404).json({ error: 'Questions not found' });
      }

      await Question.updateMany(
        { _id: { $in: ids } },
        { $set: { is_active: true } }
      );

      // Fix round 1, Minor 1: audit immediately after the write that
      // actually reactivates, before the per-test updateTestQuestionCount
      // loop below (which can throw) — one entry for the whole bulk
      // operation, not one per question (addendum A).
      await recordAudit(req, {
        action: 'question.reactivated',
        target_type: 'question',
        target_label: `${existing.length} questions`,
        after: { ids: existing.map((question) => String(question._id)) },
      });

      const testIds = [...new Set(
        existing
          .map((question) => (question.test_id ? String(question.test_id) : ''))
          .filter(Boolean)
      )];
      for (const testId of testIds) {
        await updateTestQuestionCount(testId);
      }

      return res.json({ activated: existing.length });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to activate questions' });
    }
  }

  async function listAttempts(req, res) {
    try {
      const { test_id: testId, status, all, limit } = req.query;
      const filter = {};

      if (testId) {
        filter.test_id = testId;
      }
      if (status) {
        filter.status = status;
      }

      if (all === 'true') {
        if (!can(req.user, 'CanViewAllAttempts')) {
          return res.status(403).json({ error: 'Staff access required' });
        }
      } else {
        filter.user_id = req.userId;
      }

      const max = clampLimit(limit, 100);
      const attempts = await TestAttempt.find(filter)
        .sort({ created_date: -1 })
        .limit(max)
        .lean();

      if (attempts.length > 0) {
        const testIds = [...new Set(attempts.map((a) => String(a.test_id)))];
        const tests = await Test.find({ _id: { $in: testIds } })
          .select('title subject total_marks difficulty')
          .lean();
        const testMap = new Map(tests.map((test) => [String(test._id), test]));
        attempts.forEach((attempt) => {
          const test = testMap.get(String(attempt.test_id));
          if (test) {
            attempt.test_title = test.title;
            attempt.test_subject = test.subject;
            attempt.test_total_marks = test.total_marks;
            attempt.test_difficulty = test.difficulty;
          }
        });
      }

      return res.json({ attempts });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load attempts' });
    }
  }

  async function getTestStats(req, res) {
    try {
      const test = await Test.findById(req.params.id).lean();
      if (!test) {
        return res.status(404).json({ error: 'Test not found' });
      }

      // Test-content visibility (drafts/inactive) and attempts-data widening are
      // separate decisions: a content role may see a draft test's stats without
      // being able to see every user's attempts, and vice versa.
      const canSeeDrafts = canAny(req.user, ['CanViewTests', 'CanViewQuestions']);
      const canViewAllAttempts = can(req.user, 'CanViewAllAttempts');

      if (test.is_active === false && !canSeeDrafts) {
        return res.status(404).json({ error: 'Test not found' });
      }
      if (!test.is_published && !canSeeDrafts) {
        return res.status(403).json({ error: 'Staff access required' });
      }

      const completedFilter = { test_id: test._id, status: 'completed' };
      const numericFilter = { ...completedFilter, percentage: { $type: 'number' } };
      const [summary] = await TestAttempt.aggregate([
        { $match: completedFilter },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            scored: { $sum: { $cond: [{ $isNumber: '$percentage' }, 1, 0] } },
          },
        },
      ]);
      const totalAttempts = summary?.total || 0;
      const scoredCount = summary?.scored || 0;

      const stats = {
        total_attempts: totalAttempts,
        median_percentage: null,
        top_percentage: null,
        top_score: null,
        top_total_marks: null,
        percentile: null,
        user_percentage: null,
      };

      if (scoredCount > 0) {
        // Median: fetch only the middle one or two values instead of every attempt.
        const mid = Math.floor(scoredCount / 2);
        const even = scoredCount % 2 === 0;
        const [middle, topAttempt] = await Promise.all([
          TestAttempt.find(numericFilter)
            .sort({ percentage: 1, _id: 1 })
            .skip(even ? mid - 1 : mid)
            .limit(even ? 2 : 1)
            .select('percentage')
            .lean(),
          TestAttempt.findOne(numericFilter)
            .sort({ percentage: -1, score: -1 })
            .select('percentage score total_marks')
            .lean(),
        ]);
        stats.median_percentage = computeMedian(middle.map((a) => Number(a.percentage)));
        if (topAttempt) {
          stats.top_percentage = Number(topAttempt.percentage);
          stats.top_score = topAttempt.score ?? null;
          stats.top_total_marks = topAttempt.total_marks ?? test.total_marks ?? null;
        }
      }

      let userAttempt = null;
      if (req.query.attempt_id && mongoose.isValidObjectId(String(req.query.attempt_id))) {
        const attemptFilter = {
          _id: req.query.attempt_id,
          test_id: test._id,
          status: 'completed',
        };
        if (!canViewAllAttempts) attemptFilter.user_id = req.userId;
        userAttempt = await TestAttempt.findOne(attemptFilter).select('percentage').lean();
      }

      if (!userAttempt && req.userId) {
        userAttempt = await TestAttempt.findOne({
          test_id: test._id,
          user_id: req.userId,
          status: 'completed',
        }).sort({ completed_at: -1 }).select('percentage').lean();
      }

      if (userAttempt && Number.isFinite(Number(userAttempt.percentage)) && scoredCount > 0) {
        const userPercentage = Number(userAttempt.percentage);
        const belowCount = await TestAttempt.countDocuments({
          ...completedFilter,
          percentage: { $type: 'number', $lt: userPercentage },
        });
        stats.user_percentage = userPercentage;
        stats.percentile = Math.round((belowCount / scoredCount) * 1000) / 10;
      }

      return res.json({ stats });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load test stats' });
    }
  }

  async function createAttempt(req, res) {
    try {
      const test = await Test.findById(req.params.id).lean();
      if (!test) {
        return res.status(404).json({ error: 'Test not found' });
      }

      const user = req.user;
      const isStaff = canAny(user, ['CanViewTests', 'CanViewQuestions']);
      if (!isStaff && !isTestLiveForStudent(test)) {
        return res.status(403).json({ error: 'This test is not currently available' });
      }

      // Status, start time and marks are server-controlled; the request body is ignored.
      const attempt = await TestAttempt.create({
        test_id: req.params.id,
        user_id: user._id,
        user_email: user.email,
        user_name: user.full_name,
        status: 'in_progress',
        started_at: new Date(),
        total_marks: test.total_marks ?? 0,
      });

      return res.status(201).json({ attempt });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to create attempt' });
    }
  }

  function sanitizeTimeTaken(value, attempt) {
    const startedAt = new Date(attempt.started_at || attempt.created_date || Date.now()).getTime();
    const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return elapsed;
    // Clients may report slightly less than wall-clock time, never more.
    return Math.min(Math.floor(n), elapsed + 5);
  }

  async function runCompletionSideEffects(attempt) {
    const steps = [
      () => updateTestAttemptCount(attempt.test_id),
      () => updateUserAttemptStats(attempt.user_id),
      () => broadcastUserEvent && broadcastUserEvent({
        userId: attempt.user_id,
        userEmail: attempt.user_email,
        type: 'attempt_completed',
        data: { attemptId: attempt._id, testId: attempt.test_id },
      }),
      // The single place a tutor session is enqueued on completion. The frontend
      // no longer POSTs /attempts/:id/tutor after submit; it only polls GET.
      () => enqueueTutorSession && enqueueTutorSession(attempt._id),
    ];
    for (const step of steps) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await step();
      } catch (err) {
        // The attempt is already saved; a failed side effect must not fail the request.
        console.error('Attempt completion side effect failed:', err);
      }
    }
  }

  // PATCH /attempts/:id
  // Body (all optional): { answers, status: 'in_progress' | 'completed', time_taken_seconds }
  //   answers: [{ question_id, selected_options: [optionId] }] or { [questionId]: [optionId] }
  // Any other field (score, percentage, total_marks, completed_at, ...) is ignored.
  // On completion the server grades the answers and responds with
  //   { attempt, questions } where questions include correct_answers/explanations.
  // Completed attempts are immutable (409).
  async function updateAttempt(req, res) {
    try {
      if (!mongoose.isValidObjectId(String(req.params.id))) {
        return res.status(404).json({ error: 'Attempt not found' });
      }
      const attempt = await TestAttempt.findById(req.params.id).lean();
      if (!attempt) {
        return res.status(404).json({ error: 'Attempt not found' });
      }

      const isOwner = String(attempt.user_id) === String(req.userId);
      if (!isOwner) {
        return res.status(403).json({ error: 'Not authorized' });
      }
      if (attempt.status === 'completed') {
        return res.status(409).json({ error: 'Attempt is already completed and cannot be modified' });
      }

      const body = req.body || {};
      const nextStatus = body.status === undefined ? attempt.status : body.status;
      if (!['in_progress', 'completed'].includes(nextStatus)) {
        return res.status(400).json({ error: "status must be 'in_progress' or 'completed'" });
      }
      const hasAnswers = Object.prototype.hasOwnProperty.call(body, 'answers');
      const answerMap = hasAnswers
        ? normalizeSubmittedAnswers(body.answers)
        : normalizeSubmittedAnswers(attempt.answers);
      const timeTaken = sanitizeTimeTaken(body.time_taken_seconds, attempt);
      const notCompleted = { _id: attempt._id, status: { $ne: 'completed' } };

      if (nextStatus !== 'completed') {
        const set = { status: nextStatus, time_taken_seconds: timeTaken };
        if (hasAnswers) {
          set.answers = Object.entries(answerMap)
            .filter(([id]) => mongoose.isValidObjectId(id))
            .map(([id, selected]) => ({
              question_id: id,
              selected_options: selected,
              is_correct: false,
              marks_obtained: 0,
            }));
        }
        const saved = await TestAttempt.findOneAndUpdate(notCompleted, { $set: set }, { new: true, runValidators: true }).lean();
        if (!saved) {
          return res.status(409).json({ error: 'Attempt is already completed and cannot be modified' });
        }
        return res.json({ attempt: saved });
      }

      // Grade against exactly the questions the attempt owner (the caller, per the
      // owner-only check above) can see.
      const questions = await Question.find(buildQuestionFilter(attempt.test_id, req.user))
        .sort({ created_date: 1 })
        .lean();
      const graded = gradeAttempt(questions, answerMap);

      // Atomic transition: only one request can move the attempt to completed,
      // so completion side effects (incl. tutor enqueue) run exactly once.
      const saved = await TestAttempt.findOneAndUpdate(
        notCompleted,
        {
          $set: {
            status: 'completed',
            answers: graded.answers,
            score: graded.score,
            total_marks: graded.total_marks,
            percentage: graded.percentage,
            time_taken_seconds: timeTaken,
            completed_at: new Date(),
          },
        },
        { new: true, runValidators: true }
      ).lean();
      if (!saved) {
        return res.status(409).json({ error: 'Attempt is already completed and cannot be modified' });
      }

      await runCompletionSideEffects(saved);
      return res.json({ attempt: saved, questions });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to update attempt' });
    }
  }

  // GET /attempts/:id/review
  // Returns { attempt, questions } with the answer key (correct_answers,
  // explanation, explanation_image_url) for a COMPLETED attempt. Allowed for the
  // attempt owner, or a caller holding CanViewAllAttempts.
  async function getAttemptReview(req, res) {
    try {
      if (!mongoose.isValidObjectId(String(req.params.id))) {
        return res.status(404).json({ error: 'Attempt not found' });
      }
      const attempt = await TestAttempt.findById(req.params.id).lean();
      if (!attempt) {
        return res.status(404).json({ error: 'Attempt not found' });
      }
      const isOwner = String(attempt.user_id) === String(req.userId);
      if (!isOwner && !can(req.user, 'CanViewAllAttempts')) {
        return res.status(403).json({ error: 'Not authorized' });
      }
      if (attempt.status !== 'completed') {
        return res.status(409).json({ error: 'Answers are available once the attempt is completed' });
      }

      const ids = (attempt.answers || []).map((a) => a.question_id).filter(Boolean);
      const found = await Question.find({ _id: { $in: ids } }).lean();
      const byId = new Map(found.map((q) => [String(q._id), q]));
      const questions = ids.map((id) => byId.get(String(id))).filter(Boolean);
      return res.json({ attempt, questions });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load attempt review' });
    }
  }

  return {
    listTests,
    getTest,
    createTest,
    updateTest,
    deleteTest,
    listTestQuestions,
    createTestQuestion,
    bulkCsvTestQuestions,
    assignQuestions,
    unassignQuestions,
    listQuestionBank,
    listAllQuestions,
    createQuestionBank,
    bulkCsvQuestionBank,
    updateQuestionBank,
    deleteQuestionBank,
    updateQuestion,
    deleteQuestion,
    bulkDeleteQuestions,
    bulkActivateQuestions,
    listAttempts,
    getTestStats,
    createAttempt,
    updateAttempt,
    getAttemptReview,
  };
}

module.exports = { createTestsController };
