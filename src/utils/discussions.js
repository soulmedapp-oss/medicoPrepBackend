const { DEFAULT_AVATAR_ID } = require('./identity');

const EDIT_WINDOW_MS = 15 * 60 * 1000;
const AUTO_HIDE_REPORTS = 3;
const MUTE_THRESHOLD = 3;
const MUTE_DAYS = 7;
const MUTE_LOOKBACK_DAYS = 30;
const REPORT_REASONS = Object.freeze(['spam', 'abuse', 'wrong', 'other']);
const BODY_MIN = 2;
const BODY_MAX = 2000;

// Spec §4.3. Students get the snapshot (or "Anonymous"); moderators get the
// same plus who really wrote it. author_id is deliberately absent for
// students so an anonymous author can't be correlated across posts.
function displayIdentity(post, { viewerIsModerator, author }) {
  const base = post.is_anonymous
    ? { display_name: 'Anonymous', avatar_id: DEFAULT_AVATAR_ID, is_anonymous: true }
    : {
      display_name: post.author_snapshot?.display_name || 'Student',
      avatar_id: post.author_snapshot?.avatar_id || DEFAULT_AVATAR_ID,
      is_anonymous: false,
    };
  if (!viewerIsModerator) return base;
  return {
    ...base,
    author_id: String(post.author_id),
    real_name: author?.full_name || '',
    email: author?.email || '',
    nickname: author?.nickname || '',
  };
}

// Pinned answer, then teacher replies, then by upvotes, then oldest first.
function sortThread(posts) {
  return [...posts].sort((a, b) =>
    Number(!!b.is_pinned) - Number(!!a.is_pinned)
    || Number(!!b.is_teacher_reply) - Number(!!a.is_teacher_reply)
    || (b.upvotes?.length || 0) - (a.upvotes?.length || 0)
    || new Date(a.created_date) - new Date(b.created_date));
}

function canEditPost(post, userId, now = Date.now()) {
  if (String(post.author_id) !== String(userId)) return false;
  return now - new Date(post.created_date).getTime() <= EDIT_WINDOW_MS;
}

function shouldAutoHide(reports) {
  return new Set((reports || []).map((r) => String(r.user_id))).size >= AUTO_HIDE_REPORTS;
}

// hiddenDates: created_date of the author's posts hidden by a moderator or
// by reports. Returns the new mute expiry, or null if under the threshold.
function nextMuteUntil(hiddenDates, now = Date.now()) {
  const cutoff = now - MUTE_LOOKBACK_DAYS * 86400000;
  const recent = (hiddenDates || []).filter((d) => new Date(d).getTime() >= cutoff);
  return recent.length >= MUTE_THRESHOLD ? new Date(now + MUTE_DAYS * 86400000) : null;
}

module.exports = {
  displayIdentity, sortThread, canEditPost, shouldAutoHide, nextMuteUntil,
  EDIT_WINDOW_MS, AUTO_HIDE_REPORTS, MUTE_THRESHOLD, MUTE_DAYS, MUTE_LOOKBACK_DAYS, REPORT_REASONS, BODY_MIN, BODY_MAX,
};
