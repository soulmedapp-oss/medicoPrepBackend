const express = require('express');
const { createClassesController } = require('../controllers/classesController');
const { validateObjectIdParams } = require('../middlewares/validateObjectId');
const { createRateLimiter, userOrIpKey } = require('../middlewares/rateLimit');
const { authorize } = require('../rbac/authorize');

function createClassesRoutes({ authMiddleware, createNotification }) {
  const router = express.Router();
  validateObjectIdParams(router, ['id', 'classId', 'noteId']);
  const controller = createClassesController({ createNotification });
  const aiChatLimiter = createRateLimiter({
    name: 'class-ai-chat',
    windowMs: 60 * 1000,
    max: 10,
    keyGenerator: userOrIpKey,
    message: 'Too many AI questions. Please wait a minute.',
  });

  router.get('/classes', authMiddleware, authorize.any('CanAccessLiveClasses', 'CanViewClasses'), controller.listClasses);
  router.post('/classes', authMiddleware, authorize('CanAddClasses'), controller.createClass);
  router.patch('/classes/:id', authMiddleware, authorize.any('CanEditClasses', 'CanDeactivateClasses'), controller.updateClass);
  router.delete('/classes/:id', authMiddleware, authorize('CanDeactivateClasses'), controller.deleteClass);
  router.get('/classes/:id/notes', authMiddleware, authorize('CanAccessLiveClasses'), controller.listClassNotes);
  router.post('/classes/:id/notes', authMiddleware, authorize('CanAccessLiveClasses'), controller.createClassNote);
  router.delete('/classes/:classId/notes/:noteId', authMiddleware, authorize('CanAccessLiveClasses'), controller.deleteClassNote);
  router.get('/classes/:id/recording', authMiddleware, authorize('CanAccessLiveClasses'), controller.getClassRecording);
  router.get('/classes/:id/join', authMiddleware, authorize('CanAccessLiveClasses'), controller.getClassJoinLink);
  // Host link: teachers reach it from Live Classes (CanAccessLiveClasses) or
  // Manage Live Class (CanViewClasses); the handler checks teacher/CanHostAnyClass.
  router.get('/classes/:id/host-link', authMiddleware, authorize.any('CanAccessLiveClasses', 'CanViewClasses', 'CanHostAnyClass'), controller.getClassHostLink);
  router.get('/classes/:id/ai-summary', authMiddleware, authorize('CanAccessLiveClasses'), controller.getClassSummary);
  router.post('/classes/:id/ai-chat', authMiddleware, authorize('CanAccessLiveClasses'), aiChatLimiter, controller.chatAboutClass);

  return router;
}

module.exports = createClassesRoutes;
