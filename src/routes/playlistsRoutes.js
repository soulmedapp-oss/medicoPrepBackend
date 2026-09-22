const express = require('express');
const { createPlaylistsController } = require('../controllers/playlistsController');
const { validateObjectIdParams } = require('../middlewares/validateObjectId');
const { authorize } = require('../rbac/authorize');

function createPlaylistsRoutes({ authMiddleware }) {
  const router = express.Router();
  validateObjectIdParams(router, ['id']);
  const controller = createPlaylistsController();

  // Student routes first: /playlists/browse must be matched before
  // /playlists/:id, or the :id param validator would 400 it as an invalid
  // ObjectId.
  //
  // Fix round 3, Minor 11: these three carry the same marker as their
  // /videos siblings — authorize.any('CanAccessVideos', 'CanViewVideos') —
  // so a staff role holding CanViewVideos alone can open the student views
  // it curates instead of being 403'd by its own library.
  router.get('/playlists/browse', authMiddleware, authorize.any('CanAccessVideos', 'CanViewVideos'), controller.browsePlaylists);
  router.get('/playlists/:id', authMiddleware, authorize.any('CanAccessVideos', 'CanViewVideos'), controller.getPlaylist);
  // "Also in": lives on this router (validateObjectIdParams(['id']) already
  // covers its :id) even though the path is /lectures rather than
  // /playlists — it answers a lecture-scoped question about playlists.
  router.get('/lectures/:id/playlists', authMiddleware, authorize.any('CanAccessVideos', 'CanViewVideos'), controller.getLecturePlaylists);

  // Admin (staff) routes.
  router.get('/playlists', authMiddleware, authorize.any('CanViewVideos', 'CanAddVideos'), controller.listPlaylists);
  router.post('/playlists', authMiddleware, authorize.any('CanAddVideos', 'CanEditVideos'), controller.createPlaylist);
  // Fix round 3, Important 5: PATCH also admits CanDeactivateVideos, since
  // reactivating a playlist is a PATCH (DELETE only ever deactivates) — a
  // deactivate-only role could otherwise switch a playlist off for good.
  // updatePlaylist confines such a caller to the is_active field alone.
  router.patch('/playlists/:id', authMiddleware, authorize.any('CanAddVideos', 'CanEditVideos', 'CanDeactivateVideos'), controller.updatePlaylist);
  // Fix round 1, Important 1: parity with videos' DELETE /videos/:id, which
  // requires CanDeactivateVideos alone — a role can hold CanAddVideos/
  // CanEditVideos without also holding CanDeactivateVideos.
  router.delete('/playlists/:id', authMiddleware, authorize('CanDeactivateVideos'), controller.deletePlaylist);
  router.post('/playlists/:id/items', authMiddleware, authorize.any('CanAddVideos', 'CanEditVideos'), controller.addPlaylistItems);
  router.patch('/playlists/:id/items', authMiddleware, authorize.any('CanAddVideos', 'CanEditVideos'), controller.replacePlaylistItems);

  return router;
}

module.exports = createPlaylistsRoutes;
