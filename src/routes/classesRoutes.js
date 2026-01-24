const express = require('express');
const { createClassesController } = require('../controllers/classesController');

function createClassesRoutes({ authMiddleware, requireStaff, createNotification }) {
  const router = express.Router();
  const controller = createClassesController({ createNotification });

  router.get('/classes', authMiddleware, controller.listClasses);
  router.post('/classes', authMiddleware, requireStaff, controller.createClass);
  router.patch('/classes/:id', authMiddleware, requireStaff, controller.updateClass);
  router.delete('/classes/:id', authMiddleware, requireStaff, controller.deleteClass);
  router.get('/classes/:id/notes', authMiddleware, controller.listClassNotes);
  router.post('/classes/:id/notes', authMiddleware, controller.createClassNote);
  router.delete('/classes/:classId/notes/:noteId', authMiddleware, controller.deleteClassNote);
  router.get('/classes/:id/recording', authMiddleware, controller.getClassRecording);
  router.get('/classes/:id/join', authMiddleware, controller.getClassJoinLink);
  router.get('/classes/:id/ai-summary', authMiddleware, controller.getClassSummary);
  router.post('/classes/:id/ai-chat', authMiddleware, controller.chatAboutClass);

  return router;
}

module.exports = createClassesRoutes;
