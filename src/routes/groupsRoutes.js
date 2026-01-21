const express = require('express');
const { createGroupsController } = require('../controllers/groupsController');

function createGroupsRoutes({ authMiddleware, createNotification, hasAcceptedConnection, isStudentUser }) {
  const router = express.Router();
  const controller = createGroupsController({
    createNotification,
    hasAcceptedConnection,
    isStudentUser,
  });

  router.get('/groups', authMiddleware, controller.listGroups);
  router.post('/groups', authMiddleware, controller.createGroup);
  router.post('/groups/:id/members', authMiddleware, controller.addGroupMember);
  router.get('/groups/:id/resources', authMiddleware, controller.listGroupResources);
  router.post('/groups/:id/resources', authMiddleware, controller.createGroupResource);
  router.post('/groups/:groupId/resources/:resourceId/like', authMiddleware, controller.toggleGroupResourceLike);
  router.post('/groups/:groupId/resources/:resourceId/comments', authMiddleware, controller.addGroupResourceComment);

  return router;
}

module.exports = createGroupsRoutes;
