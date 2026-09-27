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

// Fix round 1, Important 3: `nickname_lc` is only ever checked for a taken
// value before the write (updateMe / usersController.updateUser), which is a
// read-then-write race — two concurrent requests can both pass that check
// and both attempt to write the same nickname_lc, and only one wins the
// unique index. The loser gets a Mongo duplicate-key error (code 11000)
// instead of the 409 the pre-check would have given it; this turns that
// error back into the same 409, rather than letting it fall through to a 500.
function isDuplicateNicknameError(err) {
  if (!err || err.code !== 11000) return false;
  if (err.keyPattern && Object.prototype.hasOwnProperty.call(err.keyPattern, 'nickname_lc')) return true;
  if (err.keyValue && Object.prototype.hasOwnProperty.call(err.keyValue, 'nickname_lc')) return true;
  return /nickname_lc/.test(String(err.message || ''));
}

module.exports = { validateNickname, isValidAvatarId, AVATAR_IDS, DEFAULT_AVATAR_ID, displayNameFor, isDuplicateNicknameError };
