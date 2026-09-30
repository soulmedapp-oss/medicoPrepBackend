const express = require('express');
const { createGroupsController } = require('../controllers/groupsController');
const { validateObjectIdParams } = require('../middlewares/validateObjectId');
const { authorize } = require('../rbac/authorize');

function createGroupsRoutes({ authMiddleware, createNotification, hasAcceptedConnection, isStudentUser }) {
  const router = express.Router();
  validateObjectIdParams(router, ["id","groupId","resourceId"]);
  const controller = createGroupsController({
    createNotification,
    hasAcceptedConnection,
    isStudentUser,
  });

  router.get('/groups', authMiddleware, authorize('CanAccessCommunity'), controller.listGroups);
  router.post('/groups', authMiddleware, authorize('CanAccessCommunity'), controller.createGroup);
  router.post('/groups/:id/members', authMiddleware, authorize('CanAccessCommunity'), controller.addGroupMember);
  router.get('/groups/:id/resources', authMiddleware, authorize('CanAccessCommunity'), controller.listGroupResources);
  router.post('/groups/:id/resources', authMiddleware, authorize('CanAccessCommunity'), controller.createGroupResource);
  router.post('/groups/:groupId/resources/:resourceId/like', authMiddleware, authorize('CanAccessCommunity'), controller.toggleGroupResourceLike);
  router.post('/groups/:groupId/resources/:resourceId/comments', authMiddleware, authorize('CanAccessCommunity'), controller.addGroupResourceComment);

  return router;
}

module.exports = createGroupsRoutes;
