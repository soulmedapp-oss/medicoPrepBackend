const express = require('express');
const { createTestsController } = require('../controllers/testsController');

function createTestsRoutes({
  authMiddleware,
  requireStaff,
  hasPermission,
  csvUpload,
  createNotification,
  broadcastUserEvent,
  enqueueTutorSession,
}) {
  const router = express.Router();
  const controller = createTestsController({ createNotification, broadcastUserEvent, enqueueTutorSession });
  const requirePermission = (permission) => (req, res, next) => {
    if (hasPermission && hasPermission(req.user, permission)) {
      return next();
    }
    return res.status(403).json({ error: 'Staff access required' });
  };

  router.get('/tests', authMiddleware, controller.listTests);
  router.get('/tests/:id', authMiddleware, controller.getTest);
  router.get('/tests/:id/stats', authMiddleware, controller.getTestStats);
  router.post('/tests', authMiddleware, requirePermission('manage_tests'), controller.createTest);
  router.patch('/tests/:id', authMiddleware, requirePermission('manage_tests'), controller.updateTest);
  router.delete('/tests/:id', authMiddleware, requirePermission('manage_tests'), controller.deleteTest);
  router.get('/tests/:id/questions', authMiddleware, controller.listTestQuestions);
  router.post('/tests/:id/questions', authMiddleware, requirePermission('manage_questions'), controller.createTestQuestion);
  router.post(
    '/tests/:id/questions/bulk-csv',
    authMiddleware,
    requirePermission('manage_questions'),
    csvUpload.single('file'),
    controller.bulkCsvTestQuestions
  );
  router.post('/tests/:id/questions/assign', authMiddleware, requirePermission('manage_questions'), controller.assignQuestions);
  router.post('/tests/:id/questions/unassign', authMiddleware, requirePermission('manage_questions'), controller.unassignQuestions);

  router.get('/questions', authMiddleware, requirePermission('manage_questions'), controller.listAllQuestions);
  router.get('/question-bank', authMiddleware, requirePermission('manage_questions'), controller.listQuestionBank);
  router.post('/question-bank', authMiddleware, requirePermission('manage_questions'), controller.createQuestionBank);
  router.post(
    '/question-bank/bulk-csv',
    authMiddleware,
    requirePermission('manage_questions'),
    csvUpload.single('file'),
    controller.bulkCsvQuestionBank
  );
  router.patch('/question-bank/:id', authMiddleware, requirePermission('manage_questions'), controller.updateQuestionBank);
  router.delete('/question-bank/:id', authMiddleware, requirePermission('manage_questions'), controller.deleteQuestionBank);

  router.patch('/questions/:id', authMiddleware, requirePermission('manage_questions'), controller.updateQuestion);
  router.delete('/questions/:id', authMiddleware, requirePermission('manage_questions'), controller.deleteQuestion);

  router.get('/attempts', authMiddleware, controller.listAttempts);
  router.post('/tests/:id/attempts', authMiddleware, controller.createAttempt);
  router.patch('/attempts/:id', authMiddleware, controller.updateAttempt);

  return router;
}

module.exports = createTestsRoutes;
