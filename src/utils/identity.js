const RESERVED = new Set(['admin', 'teacher', 'soulmed', 'moderator', 'anonymous', 'staff', 'support']);
const NICKNAME_PATTERN = /^[A-Za-z0-9]+( [A-Za-z0-9]+)*$/;
const DEFAULT_AVATAR_ID = 'avatar-default';
const AVATAR_IDS = Object.freeze([
  ...Array.from({ length: 24 }, (_, i) => `avatar-${String(i + 1).padStart(2, '0')}`),
  DEFAULT_AVATAR_ID,
]);

function validateNickname(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'Nickname must be text' };
  const value = raw.trim();
  if (value.length < 2 || value.length > 20) return { ok: false, error: 'Nickname must be 2 to 20 characters' };
  if (!NICKNAME_PATTERN.test(value)) return { ok: false, error: 'Use letters, numbers and single spaces only' };
  const lc = value.toLowerCase();
  if (RESERVED.has(lc)) return { ok: false, error: 'That nickname is reserved' };
  return { ok: true, value, lc };
}

// '' is allowed and means "the default avatar".
const isValidAvatarId = (id) => id === '' || AVATAR_IDS.includes(id);

function displayNameFor(user) {
  if (user?.nickname) return user.nickname;
  const first = String(user?.full_name || '').trim().split(/\s+/)[0];
  return first || 'Student';
}

module.exports = { validateNickname, isValidAvatarId, AVATAR_IDS, DEFAULT_AVATAR_ID, displayNameFor };
