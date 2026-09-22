const Playlist = require('../models/Playlist');
const Video = require('../models/Video');
const { isValidTextLength } = require('../utils/validation');
const { canAccessPlaylist, visibleItems } = require('../utils/playlistAccess');
const { recordActiveStateChange, recordDeactivated } = require('../utils/audit');

// Allowlist: created_by/updated_by/items can never be set through req.body —
// created_by is set only from req.userId on create, updated_by/updated_by_at
// are set only from req.userId/now on every admin write below, and items are
// only ever written via the dedicated /items routes (which go through
// normaliseItems, never buildPlaylistPayload). is_active is included so a
// PATCH can reactivate a playlist — the dedicated DELETE route is the only
// way to deactivate one, mirroring videosController's UPDATABLE_VIDEO_FIELDS
// / deleteVideo split.
const PLAYLIST_ALLOWED_FIELDS = [
  'name',
  'description',
  'subject_ids',
  'allowed_plans',
  'is_free',
  'is_published',
  'is_active',
];

function pickFields(source, fields) {
  const out = {};
  fields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(source || {}, field)) {
      out[field] = source[field];
    }
  });
  return out;
}

// Pure: trims each plan name and drops blanks and duplicates, keeping the
// first occurrence's position — mirrors the trim/filter videosController
// already does for allowed_plans, plus de-duplication.
function normalisePlans(plans) {
  if (!Array.isArray(plans)) return [];
  const seen = new Set();
  const out = [];
  plans.forEach((plan) => {
    const trimmed = String(plan).trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  });
  return out;
}

// Pure: normalises subject_ids to an array of non-empty, de-duplicated
// string ids, preserving order. Absent entirely from the output when not an
// array, so a malformed value never reaches Mongoose as a cast attempt.
function normaliseSubjectIds(subjectIds) {
  if (!Array.isArray(subjectIds)) return [];
  const seen = new Set();
  const out = [];
  subjectIds.forEach((id) => {
    const trimmed = String(id || '').trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  });
  return out;
}

// Pure: the request-shaping allowlist for playlist create/update. Only
// fields present on the incoming body are ever copied through (pickFields'
// hasOwnProperty check), so omitting a field on a PATCH never clobbers it
// with undefined.
function buildPlaylistPayload(body) {
  const out = pickFields(body, PLAYLIST_ALLOWED_FIELDS);
  if (Object.prototype.hasOwnProperty.call(out, 'allowed_plans')) {
    out.allowed_plans = normalisePlans(out.allowed_plans);
  }
  if (Object.prototype.hasOwnProperty.call(out, 'subject_ids')) {
    out.subject_ids = normaliseSubjectIds(out.subject_ids);
  }
  return out;
}

// Pure: renumbers `order` contiguously from 0 in the given sequence,
// collapsing a repeated lecture_id to its first occurrence, and dropping any
// entry that isn't a plain object with a non-empty string lecture_id. Used
// both to replace a playlist's item list wholesale and (by the add-items
// route) to merge newly-added lectures onto the existing list.
function normaliseItems(rawItems) {
  const items = Array.isArray(rawItems) ? rawItems : [];
  const seen = new Set();
  const kept = [];
  items.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const lectureId = item.lecture_id;
    if (!lectureId || typeof lectureId !== 'string') return;
    if (seen.has(lectureId)) return;
    seen.add(lectureId);
    kept.push(lectureId);
  });
  return kept.map((lectureId, index) => ({ lecture_id: lectureId, order: index }));
}

// Pure: the Mongo filter for student browsing. Only constrains
// published/active/subject — entitlement (is_free / allowed_plans) is never
// expressed here; it is applied in code via canAccessPlaylist after the
// query, because "empty allowed_plans" and "is_free" both mean "everyone"
// and encoding that as a query predicate is easy to get subtly wrong.
function browseFilter(subjectId) {
  const filter = { is_published: true, is_active: { $ne: false } };
  if (subjectId) {
    filter.subject_ids = subjectId;
  }
  return filter;
}

function createPlaylistsController() {
  async function listPlaylists(req, res) {
    try {
      const playlists = await Playlist.find({}).sort({ created_date: -1 }).lean();
      return res.json({ playlists });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load playlists' });
    }
  }

  async function createPlaylist(req, res) {
    try {
      const data = req.body || {};
      if (!data.name || !isValidTextLength(String(data.name), 2, 200)) {
        return res.status(400).json({ error: 'name must be between 2 and 200 characters' });
      }
      const payload = buildPlaylistPayload(data);
      const playlist = await Playlist.create({
        ...payload,
        created_by: req.userId,
      });
      return res.status(201).json({ playlist });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to create playlist' });
    }
  }

  async function updatePlaylist(req, res) {
    try {
      const updates = buildPlaylistPayload(req.body);
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No updatable fields provided' });
      }
      if (updates.name !== undefined && !isValidTextLength(String(updates.name), 2, 200)) {
        return res.status(400).json({ error: 'name must be between 2 and 200 characters' });
      }

      const existing = await Playlist.findById(req.params.id).lean();
      if (!existing) {
        return res.status(404).json({ error: 'Playlist not found' });
      }

      // updated_by/updated_by_at are written as a pair, only here — matches
      // updateVideo's convention: a human hit this endpoint.
      updates.updated_by = req.userId;
      updates.updated_by_at = new Date();

      const playlist = await Playlist.findByIdAndUpdate(
        req.params.id,
        { $set: updates },
        { new: true }
      ).lean();
      if (!playlist) {
        return res.status(404).json({ error: 'Playlist not found' });
      }
      await recordActiveStateChange(req, { resource: 'playlist', before: existing, after: playlist, targetLabel: playlist.name });
      return res.json({ playlist });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to update playlist' });
    }
  }

  async function deletePlaylist(req, res) {
    try {
      const playlist = await Playlist.findById(req.params.id);
      if (!playlist) {
        return res.status(404).json({ error: 'Playlist not found' });
      }
      playlist.is_active = false;
      playlist.is_published = false;
      playlist.updated_by = req.userId;
      playlist.updated_by_at = new Date();
      await playlist.save();
      await recordDeactivated(req, { resource: 'playlist', targetId: playlist._id, targetLabel: playlist.name });
      return res.json({ ok: true, playlist: playlist.toObject() });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to deactivate playlist' });
    }
  }

  // Appends lecture_ids to the playlist, de-duplicated against what's
  // already there. One Video.find({_id:{$in}}) verifies every id exists —
  // never a query per id. Ids that don't exist, or that are already on the
  // playlist, are reported back rather than silently ignored.
  async function addPlaylistItems(req, res) {
    try {
      const { lecture_ids: rawIds } = req.body || {};
      if (!Array.isArray(rawIds) || rawIds.length === 0) {
        return res.status(400).json({ error: 'lecture_ids is required' });
      }
      const ids = rawIds.map((id) => String(id)).filter(Boolean);

      const playlist = await Playlist.findById(req.params.id);
      if (!playlist) {
        return res.status(404).json({ error: 'Playlist not found' });
      }

      const foundVideos = await Video.find({ _id: { $in: ids } }).select('_id').lean();
      const foundSet = new Set(foundVideos.map((video) => String(video._id)));
      const notFound = ids.filter((id) => !foundSet.has(id));
      const toAdd = ids.filter((id) => foundSet.has(id));

      const currentItems = playlist.items.map((item) => ({ lecture_id: String(item.lecture_id) }));
      const currentIdSet = new Set(currentItems.map((item) => item.lecture_id));
      const alreadyPresent = toAdd.filter((id) => currentIdSet.has(id));

      const merged = normaliseItems([...currentItems, ...toAdd.map((id) => ({ lecture_id: id }))]);
      playlist.items = merged;
      playlist.updated_by = req.userId;
      playlist.updated_by_at = new Date();
      await playlist.save();

      return res.json({
        playlist: playlist.toObject(),
        skipped: { not_found: notFound, already_present: alreadyPresent },
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to add playlist items' });
    }
  }

  // Replaces the full ordered item list. normaliseItems renumbers/dedupes so
  // a reorder from the client can never leave gaps, ties, or a duplicate
  // lecture behind.
  async function replacePlaylistItems(req, res) {
    try {
      const { items } = req.body || {};
      const normalised = normaliseItems(items);

      const playlist = await Playlist.findById(req.params.id);
      if (!playlist) {
        return res.status(404).json({ error: 'Playlist not found' });
      }
      playlist.items = normalised;
      playlist.updated_by = req.userId;
      playlist.updated_by_at = new Date();
      await playlist.save();

      return res.json({ playlist: playlist.toObject() });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to reorder playlist items' });
    }
  }

  // Student browsing: published + active, narrowed by subject in the query,
  // then filtered in code by canAccessPlaylist for the caller's plan — see
  // browseFilter's comment for why entitlement never becomes a Mongo filter.
  async function browsePlaylists(req, res) {
    try {
      const { subject_id: subjectId } = req.query;
      const filter = browseFilter(subjectId || null);
      const playlists = await Playlist.find(filter).sort({ created_date: -1 }).lean();
      const planName = req.user?.subscription_plan || 'free';
      const visible = playlists.filter((playlist) => canAccessPlaylist(playlist, planName));
      return res.json({ playlists: visible });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load playlists' });
    }
  }

  // Student single-playlist read. A playlist that is unpublished, inactive
  // or not entitled to the caller's plan returns the SAME 404 as one that
  // doesn't exist — a student must never learn a playlist exists that they
  // cannot open. Lectures are loaded with one Video.find({_id:{$in}}) and
  // filtered/ordered through visibleItems, so a deactivated lecture is
  // absent from the response while its playlist item (and any VideoProgress
  // row) is never touched — this handler never writes.
  async function getPlaylist(req, res) {
    try {
      const playlist = await Playlist.findById(req.params.id).lean();
      if (!playlist) {
        return res.status(404).json({ error: 'Playlist not found' });
      }
      const planName = req.user?.subscription_plan || 'free';
      const entitled =
        playlist.is_published && playlist.is_active !== false && canAccessPlaylist(playlist, planName);
      if (!entitled) {
        return res.status(404).json({ error: 'Playlist not found' });
      }

      const lectureIds = (playlist.items || []).map((item) => item.lecture_id);
      const lectures = lectureIds.length
        ? await Video.find({ _id: { $in: lectureIds } }).lean()
        : [];
      const lecturesById = new Map(lectures.map((lecture) => [String(lecture._id), lecture]));
      const visibleLectures = visibleItems(playlist, lecturesById);

      return res.json({ playlist, lectures: visibleLectures });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load playlist' });
    }
  }

  return {
    listPlaylists,
    createPlaylist,
    updatePlaylist,
    deletePlaylist,
    addPlaylistItems,
    replacePlaylistItems,
    browsePlaylists,
    getPlaylist,
  };
}

module.exports = {
  createPlaylistsController,
  buildPlaylistPayload,
  normaliseItems,
  browseFilter,
};
