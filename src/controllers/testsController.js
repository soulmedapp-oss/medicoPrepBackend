const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const Test = require('../models/Test');
const Question = require('../models/Question');
const TestAttempt = require('../models/TestAttempt');
const User = require('../models/User');
const { isValidTextLength } = require('../utils/validation');

const PLAN_RANKS = {
  free: 0,
  basic: 1,
  medium: 2,
  advance: 3,
  premium: 4,
  ultimate: 5,
};

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
    const workbook = xlsx.readFile(file.path, { cellDates: false });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return [];
    const sheet = workbook.Sheets[sheetName];
    return xlsx.utils.sheet_to_json(sheet, {
      defval: '',
      raw: false,
      blankrows: false,
    });
  }

  const content = fs.readFileSync(file.path, 'utf8');
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
  const attempts = await TestAttempt.find({ user_id: userId, status: 'completed' }).lean();
  const testsTaken = attempts.length;
  const avgScore = testsTaken
    ? attempts.reduce((sum, a) => sum + (a.percentage || 0), 0) / testsTaken
    : 0;
  await User.findByIdAndUpdate(userId, {
    $set: { tests_taken: testsTaken, average_score: avgScore },
  });
}

function createTestsController({ createNotification, broadcastUserEvent, enqueueTutorSession }) {
  async function listTests(req, res) {
    try {
      const { all } = req.query;
      if (all === 'true') {
        const user = await User.findById(req.userId).lean();
        if (!user || (user.role !== 'admin' && user.role !== 'teacher' && !user.is_teacher)) {
          return res.status(403).json({ error: 'Staff access required' });
        }
      }
      const filter = all === 'true' ? {} : { is_published: true, is_active: { $ne: false } };
      const tests = await Test.find(filter).sort({ created_date: -1 }).lean();
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
        const user = await User.findById(req.userId).lean();
        if (!user || (user.role !== 'admin' && user.role !== 'teacher' && !user.is_teacher)) {
          return res.status(404).json({ error: 'Test not found' });
        }
      }
      if (!test.is_published) {
        const user = await User.findById(req.userId).lean();
        if (!user || (user.role !== 'admin' && user.role !== 'teacher' && !user.is_teacher)) {
          return res.status(403).json({ error: 'Staff access required' });
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
      const requestedPlan = String(
        data.required_plan || (data.is_free ? 'free' : 'premium')
      ).toLowerCase();
      const test = await Test.create({
        title: data.title,
        description: data.description || '',
        subject: data.subject,
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
      const updates = req.body || {};
      if (updates.title && !isValidTextLength(String(updates.title), 2, 200)) {
        return res.status(400).json({ error: 'title must be between 2 and 200 characters' });
      }
      if (updates.subject && !isValidTextLength(String(updates.subject), 2, 120)) {
        return res.status(400).json({ error: 'subject must be between 2 and 120 characters' });
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
      const existing = await Test.findById(req.params.id).lean();
      const test = await Test.findByIdAndUpdate(
        req.params.id,
        { $set: updates },
        { new: true }
      ).lean();
      if (!test) {
        return res.status(404).json({ error: 'Test not found' });
      }
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
      if (test.is_active === false) {
        const user = await User.findById(req.userId).lean();
        if (!user || (user.role !== 'admin' && user.role !== 'teacher' && !user.is_teacher)) {
          return res.status(404).json({ error: 'Test not found' });
        }
      }

      const user = await User.findById(req.userId).lean();
      const isStaff = user?.role === 'admin' || user?.role === 'teacher' || user?.is_teacher;
      const filter = { test_id: req.params.id };

      if (!isStaff) {
        filter.is_active = true;
        const userRank = getPlanRank(user?.subscription_plan);
        const allowedPlans = Object.entries(PLAN_RANKS)
          .filter(([, rank]) => rank <= userRank)
          .map(([plan]) => plan);
        filter.required_plan = { $in: allowedPlans };
      }

      const questions = await Question.find(filter).sort({ created_date: 1 }).lean();
      return res.json({ questions });
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
        options: data.options || [],
        correct_answers: data.correct_answers || [],
        explanation: data.explanation || '',
        explanation_image_url: data.explanation_image_url || '',
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
      const normalizePlan = (value) => {
        const plan = String(value || 'free').toLowerCase();
        if (['free', 'basic', 'premium', 'ultimate'].includes(plan)) return plan;
        if (plan === 'medium') return 'premium';
        if (plan === 'advance') return 'ultimate';
        return 'free';
      };

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
          const options = [
            { id: '1', text: String(optionA) },
            { id: '2', text: String(optionB) },
            { id: '3', text: String(optionC) },
            { id: '4', text: String(optionD) },
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
      if (search) {
        filter.question_text = new RegExp(String(search), 'i');
      }
      const max = Number(limit) || 200;
      const questions = await Question.find(filter).sort({ created_date: -1 }).limit(max).lean();
      return res.json({ questions });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load question bank' });
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
      const question = await Question.create({
        test_id: null,
        subject: data.subject,
        question_text: data.question_text,
        question_type: data.question_type || 'single_choice',
        options: data.options || [],
        correct_answers: data.correct_answers || [],
        explanation: data.explanation || '',
        explanation_image_url: data.explanation_image_url || '',
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
      const normalizePlan = (value) => {
        const plan = String(value || 'free').toLowerCase();
        if (['free', 'basic', 'premium', 'ultimate'].includes(plan)) return plan;
        if (plan === 'medium') return 'premium';
        if (plan === 'advance') return 'ultimate';
        return 'free';
      };

      records.forEach((row, index) => {
        try {
          const questionText = row.question_text || row.question || row.Question;
          if (!questionText) {
            throw new Error('question_text is required');
          }

          const subject = row.subject || row.Subject || req.body.subject;
          if (!subject) {
            throw new Error('subject is required');
          }

          const optionA = row.option_a || row.optionA || row.a || row.A || '';
          const optionB = row.option_b || row.optionB || row.b || row.B || '';
          const optionC = row.option_c || row.optionC || row.c || row.C || '';
          const optionD = row.option_d || row.optionD || row.d || row.D || '';
          const options = [
            { id: '1', text: String(optionA) },
            { id: '2', text: String(optionB) },
            { id: '3', text: String(optionC) },
            { id: '4', text: String(optionD) },
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
            subject: String(subject),
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
      if (updates.question_text && !isValidTextLength(String(updates.question_text), 2, 4000)) {
        return res.status(400).json({ error: 'question_text must be between 2 and 4000 characters' });
      }
      const actor = getActor(req);
      Object.assign(existing, updates);
      existing.updated_by = actor.id;
      existing.updated_by_name = actor.name;
      await existing.save();
      return res.json({ question: existing.toObject() });
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
      return res.json({ ok: true, question: existing.toObject() });
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
      if (updates.question_text && !isValidTextLength(String(updates.question_text), 2, 4000)) {
        return res.status(400).json({ error: 'question_text must be between 2 and 4000 characters' });
      }
      const actor = getActor(req);
      const previousTestId = existing.test_id;
      Object.assign(existing, updates);
      existing.updated_by = actor.id;
      existing.updated_by_name = actor.name;
      await existing.save();

      const nextTestId = existing.test_id;
      const previousId = previousTestId ? String(previousTestId) : '';
      const nextId = nextTestId ? String(nextTestId) : '';

      if (previousId && previousId !== nextId) {
        await updateTestQuestionCount(previousTestId);
      }
      if (nextId) {
        await updateTestQuestionCount(nextTestId);
      }

      return res.json({ question: existing.toObject() });
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
      await updateTestQuestionCount(question.test_id);
      return res.json({ ok: true, question: question.toObject() });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to deactivate question' });
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
        const user = await User.findById(req.userId).lean();
        if (!user || (user.role !== 'admin' && user.role !== 'teacher' && !user.is_teacher)) {
          return res.status(403).json({ error: 'Staff access required' });
        }
      } else {
        filter.user_id = req.userId;
      }

      const max = Number(limit) || 100;
      const attempts = await TestAttempt.find(filter)
        .sort({ created_date: -1 })
        .limit(max)
        .lean();

      if (attempts.length > 0) {
        const testIds = [...new Set(attempts.map((a) => String(a.test_id)))];
        const tests = await Test.find({ _id: { $in: testIds } })
          .select('title subject total_marks')
          .lean();
        const testMap = new Map(tests.map((test) => [String(test._id), test]));
        attempts.forEach((attempt) => {
          const test = testMap.get(String(attempt.test_id));
          if (test) {
            attempt.test_title = test.title;
            attempt.test_subject = test.subject;
            attempt.test_total_marks = test.total_marks;
          }
        });
      }

      return res.json({ attempts });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load attempts' });
    }
  }

  async function createAttempt(req, res) {
    try {
      const test = await Test.findById(req.params.id).lean();
      if (!test) {
        return res.status(404).json({ error: 'Test not found' });
      }

      const user = await User.findById(req.userId).lean();
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const data = req.body || {};
      const attempt = await TestAttempt.create({
        test_id: req.params.id,
        user_id: user._id,
        user_email: user.email,
        user_name: user.full_name,
        status: data.status || 'in_progress',
        started_at: data.started_at || new Date().toISOString(),
        total_marks: data.total_marks ?? test.total_marks ?? 0,
      });

      return res.status(201).json({ attempt });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to create attempt' });
    }
  }

  async function updateAttempt(req, res) {
    try {
      const attempt = await TestAttempt.findById(req.params.id);
      if (!attempt) {
        return res.status(404).json({ error: 'Attempt not found' });
      }

      const user = await User.findById(req.userId).lean();
      const isAdmin = user?.role === 'admin';
      if (!isAdmin && String(attempt.user_id) !== String(req.userId)) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      const updates = req.body || {};
      const allowedFields = [
        'status',
        'answers',
        'score',
        'total_marks',
        'percentage',
        'time_taken_seconds',
        'completed_at',
      ];
      allowedFields.forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(updates, field)) {
          attempt[field] = updates[field];
        }
      });

      const wasCompleted = attempt.status === 'completed';
      await attempt.save();

      if (!wasCompleted && attempt.status === 'completed') {
        await updateTestAttemptCount(attempt.test_id);
        await updateUserAttemptStats(attempt.user_id);
        broadcastUserEvent({
          userId: attempt.user_id,
          userEmail: attempt.user_email,
          type: 'attempt_completed',
          data: { attemptId: attempt._id, testId: attempt.test_id },
        });
        if (enqueueTutorSession) {
          try {
            await enqueueTutorSession(attempt._id);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('Failed to enqueue tutor session:', err);
          }
        }
      }

      return res.json({ attempt: attempt.toObject() });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to update attempt' });
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
    createQuestionBank,
    bulkCsvQuestionBank,
    updateQuestionBank,
    deleteQuestionBank,
    updateQuestion,
    deleteQuestion,
    listAttempts,
    createAttempt,
    updateAttempt,
  };
}

module.exports = { createTestsController };
