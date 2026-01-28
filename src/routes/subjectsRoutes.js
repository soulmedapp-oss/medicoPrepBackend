const express = require('express');
const { createSubjectsController } = require('../controllers/subjectsController');

function createSubjectsRoutes({ authMiddleware, requireStaff }) {
  const router = express.Router();
  const controller = createSubjectsController();

  router.get('/subjects', authMiddleware, controller.listSubjects);
  router.post('/subjects', authMiddleware, requireStaff, controller.createSubject);
  router.patch('/subjects/:id', authMiddleware, requireStaff, controller.updateSubject);
  router.post('/subjects/:id/subtopics', authMiddleware, requireStaff, controller.createSubtopic);
  router.patch('/subjects/:id/subtopics/:subtopicId', authMiddleware, requireStaff, controller.updateSubtopic);

  return router;
}

module.exports = createSubjectsRoutes;
