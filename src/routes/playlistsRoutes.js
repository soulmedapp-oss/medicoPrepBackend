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
  router.get('/playlists/browse', authMiddleware, authorize('CanAccessVideos'), controller.browsePlaylists);
  router.get('/playlists/:id', authMiddleware, authorize('CanAccessVideos'), controller.getPlaylist);
  // "Also in": lives on this router (validateObjectIdParams(['id']) already
  // covers its :id) even though the path is /lectures rather than
  // /playlists — it answers a lecture-scoped question about playlists.
  router.get('/lectures/:id/playlists', authMiddleware, authorize('CanAccessVideos'), controller.getLecturePlaylists);

  // Admin (staff) routes.
  router.get('/playlists', authMiddleware, authorize.any('CanViewVideos', 'CanAddVideos'), controller.listPlaylists);
  router.post('/playlists', authMiddleware, authorize.any('CanAddVideos', 'CanEditVideos'), controller.createPlaylist);
  router.patch('/playlists/:id', authMiddleware, authorize.any('CanAddVideos', 'CanEditVideos'), controller.updatePlaylist);
  // Fix round 1, Important 1: parity with videos' DELETE /videos/:id, which
  // requires CanDeactivateVideos alone — a role can hold CanAddVideos/
  // CanEditVideos without also holding CanDeactivateVideos.
  router.delete('/playlists/:id', authMiddleware, authorize('CanDeactivateVideos'), controller.deletePlaylist);
  router.post('/playlists/:id/items', authMiddleware, authorize.any('CanAddVideos', 'CanEditVideos'), controller.addPlaylistItems);
  router.patch('/playlists/:id/items', authMiddleware, authorize.any('CanAddVideos', 'CanEditVideos'), controller.replacePlaylistItems);

  return router;
}

module.exports = createPlaylistsRoutes;
