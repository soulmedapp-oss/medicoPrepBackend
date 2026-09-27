// Deliberately small and whole-word: this stops the obvious, not the
// determined. Anatomy terms must never trip it. Moderators handle the rest.
const WORDS = ['bastard', 'bitch', 'asshole', 'fuck', 'fucking', 'shit', 'dick', 'cunt', 'slut', 'whore', 'motherfucker',
  'chutiya', 'bhosdike', 'madarchod', 'behenchod', 'gandu', 'randi', 'harami', 'kutte', 'kamina', 'saala'];
const PATTERN = new RegExp(`\\b(${WORDS.join('|')})\\b`, 'i');
const containsProfanity = (text) => PATTERN.test(String(text || ''));
module.exports = { containsProfanity, WORDS };
