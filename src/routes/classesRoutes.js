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

  return router;
}

module.exports = createClassesRoutes;
