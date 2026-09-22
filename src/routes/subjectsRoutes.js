const express = require('express');
const { createSubjectsController } = require('../controllers/subjectsController');
const { validateObjectIdParams } = require('../middlewares/validateObjectId');
const { authorize, selfService } = require('../rbac/authorize');

function createSubjectsRoutes({ authMiddleware }) {
  const router = express.Router();
  validateObjectIdParams(router, ["id","subtopicId"]);
  const controller = createSubjectsController();

  router.get('/subjects', authMiddleware, selfService, controller.listSubjects);
  router.post('/subjects', authMiddleware, authorize('CanAddSubjects'), controller.createSubject);
  router.patch('/subjects/:id', authMiddleware, authorize('CanEditSubjects'), controller.updateSubject);
  router.post('/subjects/:id/subtopics', authMiddleware, authorize('CanAddSubjects'), controller.createSubtopic);
  router.patch(
    '/subjects/:id/subtopics/:subtopicId',
    authMiddleware,
    authorize('CanEditSubjects'),
    controller.updateSubtopic
  );
  // Assign the teachers allowed to run AI ingestion/generation for a subject.
  router.put('/subjects/:id/owners', authMiddleware, authorize('CanManageSubjectOwners'), controller.setSubjectOwners);

  return router;
}

module.exports = createSubjectsRoutes;
