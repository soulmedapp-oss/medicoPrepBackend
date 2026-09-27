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
  // Fix round 2, Important 5: reporting and upvoting were the two unmetered
  // writes on this router — a script could report every post on a lecture, or
  // spin the upvote toggle, as fast as the network allowed. Wired exactly like
  // postLimiter: route-level and after the auth marker, so each route still
  // declares exactly one access rule (test/rbacCoverage.test.js).
  const reportLimiter = createRateLimiter({
    name: 'discussion-report',
    windowMs: 60 * 1000,
    max: 20,
    keyGenerator: userOrIpKey,
    message: 'Too many reports. Please wait a minute.',
  });
  const upvoteLimiter = createRateLimiter({
    name: 'discussion-upvote',
    windowMs: 60 * 1000,
    max: 60,
    keyGenerator: userOrIpKey,
    message: 'Too many upvotes. Please wait a minute.',
  });

  // /discussions/reports stays first, ahead of every /discussions/:id route.
  // Nothing shadows it today (there is no GET /discussions/:id), but the day
  // one is added, the :id param validator would answer 400 "Invalid id" for
  // the literal "reports" — and the shadowing would be silent.
  router.get('/discussions/reports', authMiddleware, authorize('CanModerateDiscussions'), controller.listReports);
  // Fix round 2, Important 4: a moderator built from legacy `manage_doubts`
  // holds CanModerateDiscussions WITHOUT CanAccessDiscussions, and could not
  // read the very threads they moderate. One marker, either code — the gate()
  // moderator bypass inside the controller handles the rest of the read path.
  router.get('/discussions', authMiddleware, authorize.any('CanAccessDiscussions', 'CanModerateDiscussions'), controller.listThread);
  router.post('/discussions', authMiddleware, authorize('CanAccessDiscussions'), postLimiter, controller.createPost);
  router.post('/discussions/:id/upvote', authMiddleware, authorize('CanAccessDiscussions'), upvoteLimiter, controller.toggleUpvote);
  router.post('/discussions/:id/report', authMiddleware, authorize('CanAccessDiscussions'), reportLimiter, controller.reportPost);
  router.patch('/discussions/:id', authMiddleware, authorize.any('CanAccessDiscussions', 'CanModerateDiscussions'), controller.updatePost);

  return router;
}

module.exports = createDiscussionsRoutes;
