const Playlist = require('../models/Playlist');
const Video = require('../models/Video');
const { isValidTextLength } = require('../utils/validation');
const { isValidObjectId } = require('../utils/security');
const { canAccessPlaylist, visibleItems, countVisibleItems } = require('../utils/playlistAccess');
const { recordActiveStateChange, recordDeactivated } = require('../utils/audit');
const { missingUpdatePermissions } = require('../rbac/updatePermissions');
const { can } = require('../rbac/can');
// Final fix wave, B1/B6: the lecture allowlist used to live here as a local
// constant while videosController's student list had no projection at all.
// Both now share this one definition, so the two student reads cannot drift.
const { STUDENT_LECTURE_FIELDS, studentPlaylistView } = require('../utils/studentProjection');

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

// Pure: normalises subject_ids to an array of non-empty, de-duplicated,
// well-formed ObjectId strings, preserving order. Absent entirely from the
// output when not an array, so a malformed value never reaches Mongoose as a
// cast attempt.
//
// Fix round 3, Minor 10: the array shape was validated but its ELEMENTS were
// not — subject_ids is ObjectId-typed, so `['abc']` sailed through here and
// died in Mongoose as a CastError, i.e. a generic 500 for what is plainly a
// bad request. isValidObjectId now filters them out here, and
// invalidSubjectIds below lets the handlers answer 400 instead of silently
// dropping what the caller asked for.
function normaliseSubjectIds(subjectIds) {
  if (!Array.isArray(subjectIds)) return [];
  const seen = new Set();
  const out = [];
  subjectIds.forEach((id) => {
    const trimmed = String(id || '').trim();
    if (!trimmed || seen.has(trimmed)) return;
    if (!isValidObjectId(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  });
  return out;
}

// Pure: the elements normaliseSubjectIds had to throw away as malformed, in
// the order given. Empty for a non-array (that case is "no subject_ids were
// supplied", not "they were wrong"), so only a genuinely bad element ever
// turns into a 400.
function invalidSubjectIds(subjectIds) {
  if (!Array.isArray(subjectIds)) return [];
  return subjectIds
    .map((id) => String(id || '').trim())
    .filter((id) => id && !isValidObjectId(id));
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
//
// Fix round 1, Important/Minor 2: subject_ids is ObjectId-typed, so handing
// an arbitrary query-string value straight to Mongo throws a CastError at
// query time (an unhandled 500) rather than a clean empty result. A
// malformed subject_id must filter to NOTHING — { _id: null } — never throw
// and never silently drop the filter and show every playlist; same
// fail-closed shape as subjectResolution.js's buildSubjectFilter.
function browseFilter(subjectId) {
  const filter = { is_published: true, is_active: { $ne: false } };
  if (subjectId) {
    if (!isValidObjectId(String(subjectId))) return { _id: null };
    filter.subject_ids = subjectId;
  }
  return filter;
}

// Pure: does this PATCH body, against the playlist's current stored
// is_active, require CanDeactivateVideos? Delegates the actual
// change-detection (a fail-closed comparison — see updatePermissions.js) to
// the exact same missingUpdatePermissions videosController's updateVideo
// uses, so the two can never disagree about what counts as "changing
// is_active". Only the deactivate-specific outcome is surfaced here — unlike
// updateVideo, a plain content edit is NOT additionally required to hold
// CanEditVideos: playlists' PATCH route marker
// (authorize.any('CanAddVideos','CanEditVideos')) is deliberately left
// unchanged, so either permission still admits a non-is_active edit; only
// the is_active-specific gate needed the videos-parity fix (Fix round 1,
// Important 1).
// Pure: is this (already allowlisted) update body a pure is_active toggle
// and nothing else?
//
// Fix round 3, Important 5: PATCH /playlists/:id is the only way to
// REACTIVATE a playlist (DELETE deactivates), but its route marker demanded
// CanAddVideos/CanEditVideos — so a deactivate-only role could switch a
// playlist off and then never switch it back on. The marker now also admits
// CanDeactivateVideos; this function is what keeps that from handing such a
// role the whole edit surface: without CanAddVideos or CanEditVideos, a body
// carrying any other field is refused. An empty body is not a toggle (the
// handler rejects it earlier anyway) and neither is a body that merely
// mentions is_active alongside something else.
function onlyTogglesActive(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const keys = Object.keys(payload);
  return keys.length === 1 && keys[0] === 'is_active';
}

function requiresDeactivatePermission(user, updates, existing) {
  const missing = missingUpdatePermissions(user, updates, existing, {
    edit: 'CanEditVideos',
    deactivate: 'CanDeactivateVideos',
  });
  return Boolean(missing && missing.includes('CanDeactivateVideos'));
}

// Task 6 — pure: projects playlists already known to contain a lecture (via
// the one query in getLecturePlaylists below) down to the ones this student
// may actually open, as {_id, name} only. Review Focus #3: "Also in" must
// never leak a playlist the student cannot access — an unpublished,
// inactive, or unentitled playlist is dropped here even though it contains
// the lecture, exactly like getPlaylist's own entitlement check.
function playlistsForLecture(playlists, planName) {
  return (playlists || [])
    .filter(
      (playlist) =>
        playlist.is_published && playlist.is_active !== false && canAccessPlaylist(playlist, planName)
    )
    .map((playlist) => ({ _id: playlist._id, name: playlist.name }));
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
      const malformedSubjectIds = invalidSubjectIds(data.subject_ids);
      if (malformedSubjectIds.length) {
        return res
          .status(400)
          .json({ error: 'subject_ids must be valid ids', invalid: malformedSubjectIds });
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
      const malformedSubjectIds = invalidSubjectIds((req.body || {}).subject_ids);
      if (malformedSubjectIds.length) {
        return res
          .status(400)
          .json({ error: 'subject_ids must be valid ids', invalid: malformedSubjectIds });
      }

      const existing = await Playlist.findById(req.params.id).lean();
      if (!existing) {
        return res.status(404).json({ error: 'Playlist not found' });
      }

      // Fix round 1, Important 1: a role can hold CanEditVideos without
      // CanDeactivateVideos, exactly as for videos, so a body that flips
      // is_active must be refused unless the caller holds CanDeactivateVideos
      // — same status/shape as updateVideo's own check.
      if (requiresDeactivatePermission(req.user, updates, existing)) {
        return res.status(403).json({ error: 'Permission denied', required: ['CanDeactivateVideos'] });
      }

      // Fix round 3, Important 5: this route's marker now also admits
      // CanDeactivateVideos, because reactivating a playlist happens here
      // and nowhere else. A caller holding ONLY that permission gets exactly
      // the is_active switch — any other field in the body is refused, so
      // widening the marker did not widen the edit surface.
      if (!can(req.user, 'CanAddVideos') && !can(req.user, 'CanEditVideos') && !onlyTogglesActive(updates)) {
        return res
          .status(403)
          .json({ error: 'Permission denied', required: ['CanAddVideos', 'CanEditVideos'] });
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
      // Fix round 1, Minor 1: a malformed id would otherwise reach
      // Video.find({_id:{$in}}) and throw a Mongoose CastError -> a generic
      // 500. Filter it out here and report it the same way a real-but-absent
      // id is reported, rather than letting it crash the request.
      const malformedIds = ids.filter((id) => !isValidObjectId(id));
      const wellFormedIds = ids.filter((id) => isValidObjectId(id));

      const playlist = await Playlist.findById(req.params.id);
      if (!playlist) {
        return res.status(404).json({ error: 'Playlist not found' });
      }

      const foundVideos = await Video.find({ _id: { $in: wellFormedIds } }).select('_id').lean();
      const foundSet = new Set(foundVideos.map((video) => String(video._id)));
      const notFound = [...malformedIds, ...wellFormedIds.filter((id) => !foundSet.has(id))];
      const toAdd = wellFormedIds.filter((id) => foundSet.has(id));

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
      const candidateItems = Array.isArray(items) ? items : [];
      // Fix round 1, Minor 1: same treatment as addPlaylistItems — a
      // malformed lecture_id would otherwise reach playlist.save() (items.
      // lecture_id is ObjectId-typed) and throw a CastError -> a generic
      // 500. Only well-formed ids reach normaliseItems; the rest are
      // reported as skipped, same shape as the add-items route. A missing/
      // non-string lecture_id is left for normaliseItems' own malformed-entry
      // handling, unchanged from Task 3.
      const malformedIds = [];
      const wellFormedItems = candidateItems.filter((item) => {
        const lectureId = item && typeof item === 'object' ? item.lecture_id : undefined;
        if (typeof lectureId === 'string' && lectureId && !isValidObjectId(lectureId)) {
          malformedIds.push(lectureId);
          return false;
        }
        return true;
      });
      const normalised = normaliseItems(wellFormedItems);

      const playlist = await Playlist.findById(req.params.id);
      if (!playlist) {
        return res.status(404).json({ error: 'Playlist not found' });
      }
      playlist.items = normalised;
      playlist.updated_by = req.userId;
      playlist.updated_by_at = new Date();
      await playlist.save();

      return res.json({ playlist: playlist.toObject(), skipped: { not_found: malformedIds } });
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

      // lecture_count mirrors what the detail view (visibleItems) would
      // render: only items whose lecture exists and is not deactivated.
      // One query across every visible playlist's items, not one per card.
      const lectureIds = visible.flatMap((playlist) =>
        (playlist.items || []).map((item) => item.lecture_id)
      );
      const activeLectureIds = lectureIds.length
        ? new Set(
            (
              await Video.find({ _id: { $in: lectureIds }, is_active: { $ne: false } })
                .select('_id')
                .lean()
            ).map((lecture) => String(lecture._id))
          )
        : new Set();
      // Fix round 3, Important 6: projected through studentPlaylistView
      // rather than spread — the spread handed students `items` (every
      // lecture id on the playlist, reachable or not), staff provenance and
      // the curation flags. lecture_count is the only computed field that
      // survives the projection.
      const withCounts = visible.map((playlist) =>
        studentPlaylistView(playlist, {
          lecture_count: countVisibleItems(playlist, activeLectureIds),
        })
      );

      return res.json({ playlists: withCounts });
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
      // Fix round 1, Important 2: no projection meant students received the
      // full lecture document — bunny_video_id/bunny_library_id (internal
      // Bunny identifiers), created_by/updated_by (staff provenance) and
      // transcript_text (large, unneeded here). Explicit allowlist instead;
      // the playback token still comes only from /videos/:id/playback.
      const lectures = lectureIds.length
        ? await Video.find({ _id: { $in: lectureIds } }).select(STUDENT_LECTURE_FIELDS).lean()
        : [];
      const lecturesById = new Map(lectures.map((lecture) => [String(lecture._id), lecture]));
      const visibleLectures = visibleItems(playlist, lecturesById);

      // Fix round 3, Important 6: the raw lean document used to go back
      // whole. The detail read needs no more of the playlist than the
      // browse read does — the lectures it carries arrive separately,
      // already filtered and ordered.
      return res.json({ playlist: studentPlaylistView(playlist), lectures: visibleLectures });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load playlist' });
    }
  }

  // "Also in": GET /lectures/:id/playlists. Resolved lazily — only when a
  // lecture view opens client-side — and entirely separate from getPlaylist
  // above, so it never adds a query to the main playlist read. The Mongo
  // filter narrows to playlists containing this lecture that are published
  // and active (mirroring Task 5's playback query); playlistsForLecture then
  // applies entitlement and projects to {_id, name} only — nothing else
  // about the playlist is exposed.
  async function getLecturePlaylists(req, res) {
    try {
      const playlists = await Playlist.find({
        'items.lecture_id': req.params.id,
        is_published: true,
        is_active: { $ne: false },
      })
        .select('_id name allowed_plans is_free')
        .lean();
      const planName = req.user?.subscription_plan || 'free';
      return res.json({ playlists: playlistsForLecture(playlists, planName) });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load playlists' });
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
    getLecturePlaylists,
  };
}

module.exports = {
  createPlaylistsController,
  buildPlaylistPayload,
  normaliseItems,
  normaliseSubjectIds,
  invalidSubjectIds,
  onlyTogglesActive,
  browseFilter,
  playlistsForLecture,
  requiresDeactivatePermission,
};
