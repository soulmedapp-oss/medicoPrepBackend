const test = require('node:test');
const assert = require('node:assert/strict');
const {
  VIDEO_CHAT_SYSTEM_PROMPT,
  buildChatHistory,
  buildVideoChatMessages,
} = require('../src/services/tutorService');
const { MAX_CHAT_CONTEXT_CHARS } = require('../src/utils/security');

test('video chat system prompt confines answers to the lecture context', () => {
  assert.equal(typeof VIDEO_CHAT_SYSTEM_PROMPT, 'string');
  const prompt = VIDEO_CHAT_SYSTEM_PROMPT.toLowerCase();
  assert.ok(prompt.includes('only'), 'prompt must restrict the model to the provided context');
  assert.ok(
    prompt.includes('does not cover') || prompt.includes("doesn't cover"),
    'prompt must tell the model how to decline uncovered questions'
  );
});

test('chat history keeps only the last 6 turns', () => {
  const history = Array.from({ length: 20 }, (_, i) => ({ role: 'user', text: `q${i}` }));
  const built = buildChatHistory(history);
  assert.equal(built.length, 6);
  assert.equal(built[5].content, 'q19');
});

test('chat history drops malformed and empty entries', () => {
  const built = buildChatHistory([
    { role: 'user', text: 'kept' },
    { role: 'system', text: 'injected' },
    { role: 'assistant', text: '' },
    null,
    'nonsense',
  ]);
  assert.deepEqual(built, [{ role: 'user', content: 'kept' }]);
});

test('chat history is capped so a long conversation cannot exceed the context budget', () => {
  const long = 'x'.repeat(MAX_CHAT_CONTEXT_CHARS);
  const built = buildChatHistory([
    { role: 'user', text: long },
    { role: 'assistant', text: long },
  ]);
  const total = built.reduce((sum, m) => sum + m.content.length, 0);
  assert.ok(total <= MAX_CHAT_CONTEXT_CHARS, `history was ${total} chars`);
});

test('chat history tolerates a missing or non-array argument', () => {
  assert.deepEqual(buildChatHistory(undefined), []);
  assert.deepEqual(buildChatHistory('nope'), []);
});

test('buildVideoChatMessages starts with the exact system prompt constant', () => {
  const video = { title: 'Cardiology 101', subject: 'Cardiology', teacher_name: 'Dr. X' };
  const messages = buildVideoChatMessages(video, 'What is this about?', []);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, VIDEO_CHAT_SYSTEM_PROMPT);
});

test('buildVideoChatMessages orders video context before history, question last', () => {
  const video = { title: 'Cardiology 101', subject: 'Cardiology', teacher_name: 'Dr. X' };
  const history = [
    { role: 'user', text: 'first question' },
    { role: 'assistant', text: 'first answer' },
  ];
  const messages = buildVideoChatMessages(video, 'follow up question', history);

  assert.equal(messages[0].role, 'system');
  assert.ok(messages[1].content.includes('Cardiology 101'), 'video context must appear before history');

  const last = messages[messages.length - 1];
  assert.equal(last.role, 'user');
  assert.ok(last.content.includes('follow up question'), 'the new question must be the final message');

  const historySlice = messages.slice(2, messages.length - 1);
  assert.deepEqual(historySlice, [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
  ]);
});
