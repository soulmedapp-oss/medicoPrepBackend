const test = require('node:test');
const assert = require('node:assert/strict');
const { containsProfanity } = require('../src/utils/profanity');
test('containsProfanity: whole words, case-insensitive, no false positives on substrings', () => {
  assert.equal(containsProfanity('This is a perfectly fine question about the scrotum'), false, 'anatomy is not profanity');
  assert.equal(containsProfanity('what the F*** is this'), false, 'masked words are not matched by the simple filter');
  assert.equal(containsProfanity('you are a bastard'), true);
  assert.equal(containsProfanity('BASTARD!'), true);
  assert.equal(containsProfanity(''), false);
});
