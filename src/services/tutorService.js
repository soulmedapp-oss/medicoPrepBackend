const OpenAI = require('openai');
const TutorSession = require('../models/TutorSession');
const TestAttempt = require('../models/TestAttempt');
const Question = require('../models/Question');
const { enqueueJob } = require('../utils/inMemoryQueue');

const {
  OPENAI_API_KEY,
  TUTOR_MODEL = 'gpt-4o-mini',
  TUTOR_MAX_TOKENS = '600',
  TUTOR_BATCH_SIZE = '5',
} = process.env;

const maxTokens = Math.max(200, Number(TUTOR_MAX_TOKENS) || 600);
const batchSize = Math.min(10, Math.max(1, Number(TUTOR_BATCH_SIZE) || 5));

let client;
function getOpenAiClient() {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured');
  }
  if (!client) {
    client = new OpenAI({ apiKey: OPENAI_API_KEY });
  }
  return client;
}

function buildQuestionPayload(question, answer) {
  return {
    question_id: String(question._id),
    question_text: question.question_text || '',
    options: Array.isArray(question.options) ? question.options : [],
    correct_answers: Array.isArray(question.correct_answers) ? question.correct_answers : [],
    explanation: question.explanation || '',
    user_answer: Array.isArray(answer?.selected_options) ? answer.selected_options : [],
  };
}

function buildFeedbackPrompt(batch) {
  return [
    'You are a strict medical tutor.',
    'For each question, provide concise, correct feedback:',
    '- Explain briefly why the correct answer is right (even if the user was correct).',
    '- Explain why the user answer is wrong (if wrong).',
    '- Provide a short concept gap label (3-6 words).',
    '- Provide a next step tip (1 sentence).',
    'Return ONLY a JSON array. Each item must include:',
    'question_id, feedback, concept_gap, next_step.',
    '',
    'Questions:',
    JSON.stringify(batch),
  ].join('\n');
}

async function requestBatchFeedback(batch) {
  const openai = getOpenAiClient();
  const response = await openai.chat.completions.create({
    model: TUTOR_MODEL,
    temperature: 0.2,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: 'You are a helpful, precise medical tutor.' },
      { role: 'user', content: buildFeedbackPrompt(batch) },
    ],
  });

  const content = response.choices?.[0]?.message?.content || '';
  try {
    return JSON.parse(content);
  } catch (err) {
    const match = content.match(/\[[\s\S]*\]/);
    if (!match) {
      throw new Error('Failed to parse tutor response');
    }
    return JSON.parse(match[0]);
  }
}

async function requestSummary(items) {
  const openai = getOpenAiClient();
  const payload = items.map((item) => ({
    concept_gap: item.concept_gap,
    next_step: item.next_step,
  }));
  const response = await openai.chat.completions.create({
    model: TUTOR_MODEL,
    temperature: 0.2,
    max_tokens: Math.min(maxTokens, 400),
    messages: [
      { role: 'system', content: 'You are a helpful medical study coach.' },
      {
        role: 'user',
        content: [
          'Provide a concise study summary (3-6 sentences) based on these gaps and tips.',
          'Return plain text only.',
          JSON.stringify(payload),
        ].join('\n'),
      },
    ],
  });
  return response.choices?.[0]?.message?.content?.trim() || '';
}

async function requestChatResponse(message, context) {
  const openai = getOpenAiClient();
  const contextBlock = context
    ? [
      'Context:',
      `Question: ${context.question_text || ''}`,
      `Options: ${JSON.stringify(context.options || [])}`,
      `Correct answers: ${JSON.stringify(context.correct_answers || [])}`,
      `User answer: ${JSON.stringify(context.user_answer || [])}`,
      context.explanation ? `Explanation: ${context.explanation}` : '',
    ].filter(Boolean).join('\n')
    : '';
  const response = await openai.chat.completions.create({
    model: TUTOR_MODEL,
    temperature: 0.2,
    max_tokens: Math.min(maxTokens, 600),
    messages: [
      { role: 'system', content: 'You are a concise medical tutor. Answer clearly in 3-6 sentences.' },
      { role: 'user', content: [contextBlock, message].filter(Boolean).join('\n\n') },
    ],
  });
  return response.choices?.[0]?.message?.content?.trim() || '';
}

async function processTutorSession(sessionId) {
  const session = await TutorSession.findById(sessionId);
  if (!session || session.status === 'ready') return;

  try {
    const attempt = await TestAttempt.findById(session.attempt_id).lean();
    if (!attempt) {
      session.status = 'failed';
      session.error_message = 'Attempt not found';
      await session.save();
      return;
    }

    const answers = Array.isArray(attempt.answers) ? attempt.answers : [];
    const questionIds = answers.map((answer) => answer.question_id).filter(Boolean);
    const questions = await Question.find({ _id: { $in: questionIds } }).lean();
    const questionMap = new Map(questions.map((question) => [String(question._id), question]));

    const payloads = answers
      .map((answer) => {
        const question = questionMap.get(String(answer.question_id));
        if (!question) return null;
        return buildQuestionPayload(question, answer);
      })
      .filter(Boolean);

    if (payloads.length === 0) {
      session.status = 'failed';
      session.error_message = 'No questions found for attempt';
      await session.save();
      return;
    }

    const items = [];
    for (let i = 0; i < payloads.length; i += batchSize) {
      const batch = payloads.slice(i, i + batchSize);
      const feedback = await requestBatchFeedback(batch);
      feedback.forEach((entry) => {
        const source = batch.find((q) => String(q.question_id) === String(entry.question_id));
        if (!source) return;
        items.push({
          question_id: source.question_id,
          correct_answers: source.correct_answers,
          user_answer: source.user_answer,
          feedback: String(entry.feedback || ''),
          concept_gap: String(entry.concept_gap || ''),
          next_step: String(entry.next_step || ''),
        });
      });
    }

    const summary = await requestSummary(items);
    session.status = 'ready';
    session.items = items;
    session.summary = summary;
    session.error_message = '';
    await session.save();
  } catch (err) {
    session.status = 'failed';
    session.error_message = err.message || 'Tutor generation failed';
    await session.save();
  }
}

async function enqueueTutorSession(attemptId) {
  const attempt = await TestAttempt.findById(attemptId).lean();
  if (!attempt) {
    throw new Error('Attempt not found');
  }

  let session = await TutorSession.findOne({ attempt_id: attemptId });
  if (!session) {
    session = await TutorSession.create({
      attempt_id: attempt._id,
      user_id: attempt.user_id,
      test_id: attempt.test_id,
      status: 'pending',
    });
  }

  if (session.status !== 'ready') {
    enqueueJob(() => processTutorSession(session._id));
  }
  return session;
}

module.exports = { enqueueTutorSession, requestChatResponse };
