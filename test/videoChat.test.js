const test = require('node:test');
const assert = require('node:assert/strict');
const { VIDEO_CHAT_SYSTEM_PROMPT } = require('../src/services/tutorService');

test('video chat system prompt confines answers to the lecture context', () => {
  assert.equal(typeof VIDEO_CHAT_SYSTEM_PROMPT, 'string');
  const prompt = VIDEO_CHAT_SYSTEM_PROMPT.toLowerCase();
  assert.ok(prompt.includes('only'), 'prompt must restrict the model to the provided context');
  assert.ok(
    prompt.includes('does not cover') || prompt.includes("doesn't cover"),
    'prompt must tell the model how to decline uncovered questions'
  );
});
