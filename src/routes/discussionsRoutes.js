const express = require('express');
const { createDiscussionsController } = require('../controllers/discussionsController');
const { validateObjectIdParams } = require('../middlewares/validateObjectId');
const { authorize } = require('../rbac/authorize');
const { createRateLimiter, userOrIpKey } = require('../middlewares/rateLimit');

function createDiscussionsRoutes({ authMiddleware, createNotification, loadVideoForPlayback }) {
  const router = express.Router();
  validateObjectIdParams(router, ['id']);
  const controller = createDiscussionsController({ createNotification, loadVideoForPlayback });
  const postLimiter = createRateLimiter({
    name: 'discussion-post',
    windowMs: 60 * 1000,
    max: 10,
    keyGenerator: userOrIpKey,
    message: 'You are posting too fast. Please wait a minute.',
  });

  // /discussions/reports stays first, ahead of every /discussions/:id route.
  // Nothing shadows it today (there is no GET /discussions/:id), but the day
  // one is added, the :id param validator would answer 400 "Invalid id" for
  // the literal "reports" — and the shadowing would be silent.
  router.get('/discussions/reports', authMiddleware, authorize('CanModerateDiscussions'), controller.listReports);
  router.get('/discussions', authMiddleware, authorize('CanAccessDiscussions'), controller.listThread);
  router.post('/discussions', authMiddleware, authorize('CanAccessDiscussions'), postLimiter, controller.createPost);
  router.post('/discussions/:id/upvote', authMiddleware, authorize('CanAccessDiscussions'), controller.toggleUpvote);
  router.post('/discussions/:id/report', authMiddleware, authorize('CanAccessDiscussions'), controller.reportPost);
  router.patch('/discussions/:id', authMiddleware, authorize.any('CanAccessDiscussions', 'CanModerateDiscussions'), controller.updatePost);

  return router;
}

module.exports = createDiscussionsRoutes;
