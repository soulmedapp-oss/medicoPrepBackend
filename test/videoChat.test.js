const test = require('node:test');
const assert = require('node:assert/strict');
const {
  VIDEO_CHAT_SYSTEM_PROMPT,
  VIDEO_CHAT_REMINDER_PROMPT,
  buildChatHistory,
  buildVideoChatMessages,
} = require('../src/services/tutorService');
const { MAX_CHAT_CONTEXT_CHARS } = require('../src/utils/security');

const VIDEO_FIXTURE = { title: 'Cardiology 101', subject: 'Cardiology', teacher_name: 'Dr. X' };

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

test('chat history is capped so a long conversation cannot exceed the context budget, keeping the newest entry', () => {
  const older = 'a'.repeat(MAX_CHAT_CONTEXT_CHARS);
  const newest = 'b'.repeat(MAX_CHAT_CONTEXT_CHARS);
  const built = buildChatHistory([
    { role: 'user', text: older },
    { role: 'assistant', text: newest },
  ]);
  assert.equal(built.length, 1);
  assert.equal(built[0].role, 'assistant');
  assert.equal(built[0].content, newest);
});

test('chat history budget trim drops the rest of the older suffix once one entry overflows', () => {
  // After keeping the newest two entries, only a little budget remains — too
  // little for the mid entry, but enough for the small oldest one. The loop
  // must `break` on the mid entry (dropping it and everything older) rather
  // than `continue` past it, which would splice the oldest entry back in and
  // leave a hole in the middle of the kept conversation.
  const oldest = { role: 'user', text: 'oldest'.padEnd(50, '.') };
  const mid = { role: 'user', text: 'mid'.padEnd(MAX_CHAT_CONTEXT_CHARS - 100, '.') };
  const second = { role: 'user', text: 'second'.padEnd(100, '.') };
  const newest = { role: 'assistant', text: 'newest'.padEnd(100, '.') };
  const built = buildChatHistory([oldest, mid, second, newest]);
  assert.deepEqual(built, [
    { role: 'user', content: second.text },
    { role: 'assistant', content: newest.text },
  ]);
});

test('chat history tolerates a missing or non-array argument', () => {
  assert.deepEqual(buildChatHistory(undefined), []);
  assert.deepEqual(buildChatHistory('nope'), []);
});

test('buildVideoChatMessages starts with the exact system prompt constant', () => {
  const messages = buildVideoChatMessages('What is this about?', VIDEO_FIXTURE, []);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, VIDEO_CHAT_SYSTEM_PROMPT);
});

test('buildVideoChatMessages orders: system prompt, lecture context, history, reminder, question', () => {
  const history = [
    { role: 'user', text: 'first question' },
    { role: 'assistant', text: 'first answer' },
  ];
  const messages = buildVideoChatMessages('follow up question', VIDEO_FIXTURE, history);

  assert.equal(messages.length, 6);

  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, VIDEO_CHAT_SYSTEM_PROMPT);

  assert.ok(messages[1].content.includes('Cardiology 101'), 'video context must appear before history');

  assert.deepEqual(messages.slice(2, 4), [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
  ]);

  assert.equal(messages[4].role, 'system');
  assert.equal(messages[4].content, VIDEO_CHAT_REMINDER_PROMPT);

  const last = messages[5];
  assert.equal(last.role, 'user');
  assert.ok(last.content.includes('follow up question'), 'the new question must be the final message');
});
