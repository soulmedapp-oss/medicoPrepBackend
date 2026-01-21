const express = require('express');
const { createTestsController } = require('../controllers/testsController');

function createTestsRoutes({
  authMiddleware,
  requireStaff,
  csvUpload,
  createNotification,
  broadcastUserEvent,
}) {
  const router = express.Router();
  const controller = createTestsController({ createNotification, broadcastUserEvent });

  router.get('/tests', authMiddleware, controller.listTests);
  router.get('/tests/:id', authMiddleware, controller.getTest);
  router.post('/tests', authMiddleware, requireStaff, controller.createTest);
  router.patch('/tests/:id', authMiddleware, requireStaff, controller.updateTest);
  router.delete('/tests/:id', authMiddleware, requireStaff, controller.deleteTest);
  router.get('/tests/:id/questions', authMiddleware, controller.listTestQuestions);
  router.post('/tests/:id/questions', authMiddleware, requireStaff, controller.createTestQuestion);
  router.post(
    '/tests/:id/questions/bulk-csv',
    authMiddleware,
    requireStaff,
    csvUpload.single('file'),
    controller.bulkCsvTestQuestions
  );
  router.post('/tests/:id/questions/assign', authMiddleware, requireStaff, controller.assignQuestions);
  router.post('/tests/:id/questions/unassign', authMiddleware, requireStaff, controller.unassignQuestions);

  router.get('/question-bank', authMiddleware, requireStaff, controller.listQuestionBank);
  router.post('/question-bank', authMiddleware, requireStaff, controller.createQuestionBank);
  router.post(
    '/question-bank/bulk-csv',
    authMiddleware,
    requireStaff,
    csvUpload.single('file'),
    controller.bulkCsvQuestionBank
  );
  router.patch('/question-bank/:id', authMiddleware, requireStaff, controller.updateQuestionBank);
  router.delete('/question-bank/:id', authMiddleware, requireStaff, controller.deleteQuestionBank);

  router.patch('/questions/:id', authMiddleware, requireStaff, controller.updateQuestion);
  router.delete('/questions/:id', authMiddleware, requireStaff, controller.deleteQuestion);

  router.get('/attempts', authMiddleware, controller.listAttempts);
  router.post('/tests/:id/attempts', authMiddleware, controller.createAttempt);
  router.patch('/attempts/:id', authMiddleware, controller.updateAttempt);

  return router;
}

module.exports = createTestsRoutes;
