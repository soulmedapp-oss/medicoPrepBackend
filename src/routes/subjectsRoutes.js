const express = require('express');
const { createSubjectsController } = require('../controllers/subjectsController');

function createSubjectsRoutes({ authMiddleware, requireStaff, hasPermission }) {
  const router = express.Router();
  const controller = createSubjectsController();
  const requirePermissionOrStaff = (permission) => (req, res, next) => {
    if (hasPermission && hasPermission(req.user, permission)) {
      return next();
    }
    if (requireStaff) {
      return requireStaff(req, res, next);
    }
    return res.status(403).json({ error: 'Staff access required' });
  };

  router.get('/subjects', authMiddleware, controller.listSubjects);
  router.post('/subjects', authMiddleware, requirePermissionOrStaff('manage_questions'), controller.createSubject);
  router.patch('/subjects/:id', authMiddleware, requirePermissionOrStaff('manage_questions'), controller.updateSubject);
  router.post('/subjects/:id/subtopics', authMiddleware, requirePermissionOrStaff('manage_questions'), controller.createSubtopic);
  router.patch(
    '/subjects/:id/subtopics/:subtopicId',
    authMiddleware,
    requirePermissionOrStaff('manage_questions'),
    controller.updateSubtopic
  );

  return router;
}

module.exports = createSubjectsRoutes;
