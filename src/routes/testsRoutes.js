const express = require('express');
const { createTestsController } = require('../controllers/testsController');
const { authorize, selfService } = require('../rbac/authorize');

function createTestsRoutes({
  authMiddleware,
  csvUpload,
  createNotification,
  broadcastUserEvent,
  enqueueTutorSession,
}) {
  const router = express.Router();
  const controller = createTestsController({ createNotification, broadcastUserEvent, enqueueTutorSession });

  router.get('/tests', authMiddleware, authorize.any('CanAccessTests', 'CanViewTests'), controller.listTests);
  router.get('/tests/:id', authMiddleware, authorize.any('CanAccessTests', 'CanViewTests'), controller.getTest);
  router.get('/tests/:id/stats', authMiddleware, authorize.any('CanAccessTests', 'CanViewTests'), controller.getTestStats);
  router.post('/tests', authMiddleware, authorize('CanAddTests'), controller.createTest);
  router.patch('/tests/:id', authMiddleware, authorize.any('CanEditTests', 'CanDeactivateTests'), controller.updateTest);
  router.delete('/tests/:id', authMiddleware, authorize('CanDeactivateTests'), controller.deleteTest);
  router.get('/tests/:id/questions', authMiddleware, authorize.any('CanAccessTests', 'CanViewTests'), controller.listTestQuestions);
  router.post('/tests/:id/questions', authMiddleware, authorize('CanAddQuestions'), controller.createTestQuestion);
  router.post(
    '/tests/:id/questions/bulk-csv',
    authMiddleware,
    authorize('CanBulkUploadQuestions'),
    csvUpload.single('file'),
    controller.bulkCsvTestQuestions
  );
  router.post('/tests/:id/questions/assign', authMiddleware, authorize('CanAssignTestQuestions'), controller.assignQuestions);
  router.post('/tests/:id/questions/unassign', authMiddleware, authorize('CanAssignTestQuestions'), controller.unassignQuestions);

  router.get('/questions', authMiddleware, authorize('CanViewQuestions'), controller.listAllQuestions);
  router.get('/question-bank', authMiddleware, authorize('CanViewQuestionBank'), controller.listQuestionBank);
  router.post('/question-bank', authMiddleware, authorize('CanAddQuestionBank'), controller.createQuestionBank);
  router.post(
    '/question-bank/bulk-csv',
    authMiddleware,
    authorize('CanBulkUploadQuestionBank'),
    csvUpload.single('file'),
    controller.bulkCsvQuestionBank
  );
  router.patch('/question-bank/:id', authMiddleware, authorize.any('CanEditQuestionBank', 'CanDeactivateQuestionBank'), controller.updateQuestionBank);
  router.delete('/question-bank/:id', authMiddleware, authorize('CanDeactivateQuestionBank'), controller.deleteQuestionBank);

  router.patch('/questions/:id', authMiddleware, authorize.any('CanEditQuestions', 'CanDeactivateQuestions'), controller.updateQuestion);
  router.delete('/questions/:id', authMiddleware, authorize('CanDeactivateQuestions'), controller.deleteQuestion);
  router.post('/questions/bulk-delete', authMiddleware, authorize('CanDeactivateQuestions'), controller.bulkDeleteQuestions);
  router.post('/questions/bulk-activate', authMiddleware, authorize('CanDeactivateQuestions'), controller.bulkActivateQuestions);

  router.get('/attempts', authMiddleware, selfService, controller.listAttempts);
  router.post('/tests/:id/attempts', authMiddleware, authorize('CanAccessTests'), controller.createAttempt);
  router.patch('/attempts/:id', authMiddleware, selfService, controller.updateAttempt);
  router.get('/attempts/:id/review', authMiddleware, selfService, controller.getAttemptReview);

  return router;
}

module.exports = createTestsRoutes;
