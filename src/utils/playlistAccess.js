function canAccessPlaylist(playlist, planName) {
  if (!playlist) return false;
  if (playlist.is_free) return true;
  const allowed = Array.isArray(playlist.allowed_plans) ? playlist.allowed_plans : [];
  if (allowed.length === 0) return true;
  return allowed.includes(planName);
}

// Read-time filter, never a write: a deactivated lecture disappears for
// students while its playlist item — and every VideoProgress row — survives.
// Ties in `order` fall back to the item's position, so the sequence a student
// sees never reshuffles between requests.
function visibleItems(playlist, lecturesById) {
  const items = Array.isArray(playlist?.items) ? playlist.items : [];
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (a.item.order ?? 0) - (b.item.order ?? 0) || a.index - b.index)
    .map(({ item }) => lecturesById.get(String(item.lecture_id)))
    .filter((lecture) => lecture && lecture.is_active !== false);
}

// Same visibility rule as visibleItems, but a count instead of a list — no
// lecture documents needed, just the set of ids that are visible (exist and
// are not is_active === false). Mirrors visibleItems' lack of de-duping: a
// lecture_id repeated in items is rendered twice by visibleItems, so it is
// counted twice here too.
function countVisibleItems(playlist, activeLectureIds) {
  const items = Array.isArray(playlist?.items) ? playlist.items : [];
  return items.reduce(
    (count, item) => (activeLectureIds.has(String(item.lecture_id)) ? count + 1 : count),
    0
  );
}

function isLecturePlayable(lecture, playlists, planName) {
  if (!lecture || lecture.is_active === false) return false;
  return (playlists || []).some((playlist) =>
    playlist.is_published &&
    playlist.is_active !== false &&
    canAccessPlaylist(playlist, planName) &&
    (playlist.items || []).some((item) => String(item.lecture_id) === String(lecture._id))
  );
}

module.exports = { canAccessPlaylist, visibleItems, isLecturePlayable, countVisibleItems };
