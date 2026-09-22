const mongoose = require('mongoose');
const StudyGroup = require('../models/StudyGroup');
const GroupResource = require('../models/GroupResource');
const User = require('../models/User');
const { isValidTextLength } = require('../utils/validation');
const { isHttpUrl } = require('../utils/security');

function serializeGroup(group) {
  const value = group?.toObject ? group.toObject() : group;
  if (!value) return value;
  return {
    ...value,
    members: (value.members || []).map(({ user_email, ...member }) => member),
  };
}

function serializeResource(resource) {
  const value = resource?.toObject ? resource.toObject() : resource;
  if (!value) return value;
  const { user_email, ...safeResource } = value;
  return {
    ...safeResource,
    comments: (value.comments || []).map(({ user_email: commentEmail, ...comment }) => comment),
  };
}

function createGroupsController({ createNotification, hasAcceptedConnection, isStudentUser }) {
  async function listGroups(req, res) {
    try {
      const groups = await StudyGroup.find({ 'members.user_id': req.userId })
        .sort({ updated_date: -1 })
        .lean();
      return res.json({ groups: groups.map(serializeGroup) });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load groups' });
    }
  }

  async function createGroup(req, res) {
    try {
      const data = req.body || {};
      if (!data.name) {
        return res.status(400).json({ error: 'name is required' });
      }
      if (!isValidTextLength(String(data.name), 2, 120)) {
        return res.status(400).json({ error: 'name must be between 2 and 120 characters' });
      }
      if (data.description && !isValidTextLength(String(data.description), 0, 1000)) {
        return res.status(400).json({ error: 'description must be 1000 characters or less' });
      }

      // The route's authorize('CanAccessCommunity') is now the only access
      // decision for the caller; isStudentUser below applies only to the
      // OTHER members being added — an identity check on those records, not
      // a caller access check. (Fix round 1, item A completion: uniqueIds
      // starts with the creator's own id, so without the isCreator carve-out
      // below, this loop re-imposed a caller-side check on the creator by
      // another door.)
      const creator = req.user;

      const requestedIds = Array.isArray(data.member_ids) ? data.member_ids : [];
      const uniqueIds = Array.from(new Set([
        String(creator._id),
        ...requestedIds.map((id) => String(id || '')),
      ].filter(Boolean)));
      if (uniqueIds.some((id) => !mongoose.isValidObjectId(id))) {
        return res.status(400).json({ error: 'member_ids contains an invalid user ID' });
      }

      const members = [];
      for (const userId of uniqueIds) {
        const isCreator = String(userId) === String(creator._id);
        const user = await User.findOne({ _id: userId, is_active: { $ne: false } }).lean();
        if (!user) {
          return res.status(404).json({ error: 'Student not found' });
        }
        if (!isCreator && !isStudentUser(user)) {
          return res.status(404).json({ error: 'Student not found' });
        }
        if (!isCreator) {
          const ok = await hasAcceptedConnection(creator._id, user._id);
          if (!ok) {
            return res.status(400).json({ error: 'All group members must be accepted connections' });
          }
        }
        members.push({
          user_id: user._id,
          user_email: user.email,
          user_name: user.full_name || '',
          role: isCreator ? 'admin' : 'member',
        });
      }

      const group = await StudyGroup.create({
        name: data.name,
        description: data.description || '',
        created_by: creator._id,
        members,
      });

      const notifyEmails = members
        .filter((member) => String(member.user_id) !== String(creator._id))
        .map((member) => member.user_email);

      await Promise.all(
        notifyEmails.map((email) =>
          createNotification({
            userEmail: email,
            title: 'Added to a study group',
            message: `${creator.full_name || creator.email} added you to ${group.name}.`,
            type: 'info',
          })
        )
      );

      return res.status(201).json({ group: serializeGroup(group) });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to create group' });
    }
  }

  async function addGroupMember(req, res) {
    try {
      const { user_id: userId } = req.body || {};
      if (!mongoose.isValidObjectId(userId)) {
        return res.status(400).json({ error: 'Valid user_id is required' });
      }

      const group = await StudyGroup.findById(req.params.id);
      if (!group) {
        return res.status(404).json({ error: 'Group not found' });
      }

      const isAdminMember = group.members.some(
        (member) => String(member.user_id) === String(req.userId) && member.role === 'admin'
      );
      if (!isAdminMember) {
        return res.status(403).json({ error: 'Only group admin can add members' });
      }

      const user = await User.findOne({ _id: userId, is_active: { $ne: false } }).lean();
      if (!user || !isStudentUser(user)) {
        return res.status(404).json({ error: 'Student not found' });
      }

      const alreadyMember = group.members.some((member) => String(member.user_id) === String(user._id));
      if (alreadyMember) {
        return res.status(409).json({ error: 'User already in group' });
      }

      const ok = await hasAcceptedConnection(req.userId, user._id);
      if (!ok) {
        return res.status(400).json({ error: 'No accepted connection with this student' });
      }

      group.members.push({
        user_id: user._id,
        user_email: user.email,
        user_name: user.full_name || '',
        role: 'member',
      });
      await group.save();

      await createNotification({
        userEmail: user.email,
        title: 'Added to a study group',
        message: `You were added to ${group.name}.`,
        type: 'info',
      });

      return res.json({ group: serializeGroup(group) });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to add group member' });
    }
  }

  async function listGroupResources(req, res) {
    try {
      const group = await StudyGroup.findById(req.params.id).lean();
      if (!group) {
        return res.status(404).json({ error: 'Group not found' });
      }

      const isMember = group.members.some((member) => String(member.user_id) === String(req.userId));
      if (!isMember) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      const resources = await GroupResource.find({ group_id: group._id })
        .sort({ created_date: -1 })
        .lean();

      return res.json({ resources: resources.map(serializeResource) });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load resources' });
    }
  }

  async function createGroupResource(req, res) {
    try {
      const data = req.body || {};
      if (!data.title) {
        return res.status(400).json({ error: 'title is required' });
      }
      if (!isValidTextLength(String(data.title), 2, 200)) {
        return res.status(400).json({ error: 'title must be between 2 and 200 characters' });
      }
      if (data.content && !isValidTextLength(String(data.content), 0, 4000)) {
        return res.status(400).json({ error: 'content must be 4000 characters or less' });
      }
      if (data.url && !isValidTextLength(String(data.url), 0, 1000)) {
        return res.status(400).json({ error: 'url must be 1000 characters or less' });
      }
      // Blocks javascript:, data: and other schemes that would execute when clicked.
      if (data.url && !isHttpUrl(String(data.url))) {
        return res.status(400).json({ error: 'url must be a valid http(s) URL' });
      }

      const group = await StudyGroup.findById(req.params.id);
      if (!group) {
        return res.status(404).json({ error: 'Group not found' });
      }

      const member = group.members.find((m) => String(m.user_id) === String(req.userId));
      if (!member) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      const resource = await GroupResource.create({
        group_id: group._id,
        user_id: member.user_id,
        user_email: member.user_email,
        user_name: member.user_name,
        type: data.type || 'note',
        title: data.title,
        content: data.content || '',
        url: data.url || '',
      });

      const notifyEmails = group.members
        .filter((m) => String(m.user_id) !== String(member.user_id))
        .map((m) => m.user_email);

      await Promise.all(
        notifyEmails.map((email) =>
          createNotification({
            userEmail: email,
            title: 'New group resource',
            message: `${member.user_name || member.user_email} shared a ${resource.type} in ${group.name}.`,
            type: 'info',
          })
        )
      );

      return res.status(201).json({ resource: serializeResource(resource) });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to add resource' });
    }
  }

  async function toggleGroupResourceLike(req, res) {
    try {
      const group = await StudyGroup.findById(req.params.groupId);
      if (!group) {
        return res.status(404).json({ error: 'Group not found' });
      }

      const isMember = group.members.some((member) => String(member.user_id) === String(req.userId));
      if (!isMember) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      const resource = await GroupResource.findOne({
        _id: req.params.resourceId,
        group_id: group._id,
      });
      if (!resource) {
        return res.status(404).json({ error: 'Resource not found' });
      }

      const userId = String(req.userId);
      const existingIndex = resource.liked_by.findIndex((id) => String(id) === userId);
      if (existingIndex >= 0) {
        resource.liked_by.splice(existingIndex, 1);
      } else {
        resource.liked_by.push(req.userId);
      }
      resource.like_count = resource.liked_by.length;
      await resource.save();

      return res.json({ resource: serializeResource(resource) });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to update like' });
    }
  }

  async function addGroupResourceComment(req, res) {
    try {
      const { message } = req.body || {};
      if (!message) {
        return res.status(400).json({ error: 'message is required' });
      }
      if (!isValidTextLength(String(message), 1, 1000)) {
        return res.status(400).json({ error: 'message must be between 1 and 1000 characters' });
      }

      const group = await StudyGroup.findById(req.params.groupId);
      if (!group) {
        return res.status(404).json({ error: 'Group not found' });
      }

      const member = group.members.find((m) => String(m.user_id) === String(req.userId));
      if (!member) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      const resource = await GroupResource.findOne({
        _id: req.params.resourceId,
        group_id: group._id,
      });
      if (!resource) {
        return res.status(404).json({ error: 'Resource not found' });
      }

      resource.comments.push({
        user_id: member.user_id,
        user_email: member.user_email,
        user_name: member.user_name,
        message,
      });
      await resource.save();

      const notifyEmails = group.members
        .filter((m) => String(m.user_id) !== String(member.user_id))
        .map((m) => m.user_email);

      await Promise.all(
        notifyEmails.map((email) =>
          createNotification({
            userEmail: email,
            title: 'New comment',
            message: `${member.user_name || member.user_email} commented in ${group.name}.`,
            type: 'info',
            link: `/Community?group=${group._id}`,
          })
        )
      );

      return res.json({ resource: serializeResource(resource) });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to add comment' });
    }
  }

  return {
    listGroups,
    createGroup,
    addGroupMember,
    listGroupResources,
    createGroupResource,
    toggleGroupResourceLike,
    addGroupResourceComment,
  };
}

module.exports = { createGroupsController };
