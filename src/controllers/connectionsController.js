const mongoose = require('mongoose');
const ConnectionRequest = require('../models/ConnectionRequest');
const User = require('../models/User');
const { isValidTextLength } = require('../utils/validation');

function serializeConnectionRequest(request) {
  return {
    _id: request._id,
    requester_id: request.requester_id,
    requester_name: request.requester_name || 'Student',
    target_id: request.target_id,
    target_name: request.target_name || 'Student',
    status: request.status,
    created_date: request.created_date,
    updated_date: request.updated_date,
  };
}

function createConnectionsController({ createNotification, isStudentUser }) {
  async function listRequests(req, res) {
    try {
      const { direction, status } = req.query;
      const filter = {};
      if (status) filter.status = status;

      if (direction === 'incoming') {
        filter.target_id = req.userId;
      } else if (direction === 'outgoing') {
        filter.requester_id = req.userId;
      } else {
        filter.$or = [{ requester_id: req.userId }, { target_id: req.userId }];
      }

      const requests = await ConnectionRequest.find(filter)
        .sort({ created_date: -1 })
        .lean();
      return res.json({ requests: requests.map(serializeConnectionRequest) });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load connection requests' });
    }
  }

  async function createRequest(req, res) {
    try {
      const { target_user_id: targetUserId } = req.body || {};
      if (!mongoose.isValidObjectId(targetUserId)) {
        return res.status(400).json({ error: 'Valid target_user_id is required' });
      }

      // The route's authorize('CanAccessCommunity') is now the only access
      // decision for the caller; the isStudentUser check below still applies
      // to the TARGET user (identity of the other person, not the caller).
      const requester = req.user;

      const target = await User.findOne({
        _id: targetUserId,
        is_active: { $ne: false },
      }).lean();
      if (!target || !isStudentUser(target)) {
        return res.status(404).json({ error: 'Student not found' });
      }
      if (String(target._id) === String(requester._id)) {
        return res.status(400).json({ error: 'Cannot connect with yourself' });
      }

      const existing = await ConnectionRequest.findOne({
        $or: [
          { requester_id: requester._id, target_id: target._id },
          { requester_id: target._id, target_id: requester._id },
        ],
      });

      if (existing) {
        return res.status(409).json({ error: 'Connection request already exists' });
      }

      const request = await ConnectionRequest.create({
        requester_id: requester._id,
        requester_email: requester.email,
        requester_name: requester.full_name || '',
        target_id: target._id,
        target_email: target.email,
        target_name: target.full_name || '',
        status: 'pending',
      });

      await createNotification({
        userEmail: target.email,
        title: 'New connection request',
        message: `${requester.full_name || requester.email} sent you a connection request.`,
        type: 'info',
      });

      return res.status(201).json({ request: serializeConnectionRequest(request.toObject()) });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to create connection request' });
    }
  }

  async function updateRequest(req, res) {
    try {
      const { status } = req.body || {};
      if (!status || !['accepted', 'rejected'].includes(status)) {
        return res.status(400).json({ error: 'status must be accepted or rejected' });
      }

      const request = await ConnectionRequest.findById(req.params.id);
      if (!request) {
        return res.status(404).json({ error: 'Request not found' });
      }

      if (String(request.target_id) !== String(req.userId)) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      request.status = status;
      await request.save();

      await createNotification({
        userEmail: request.requester_email,
        title: status === 'accepted' ? 'Connection accepted' : 'Connection declined',
        message: `${request.target_name || request.target_email} ${status} your request.`,
        type: 'info',
      });

      return res.json({ request: serializeConnectionRequest(request.toObject()) });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to update connection request' });
    }
  }

  async function listConnections(req, res) {
    try {
      const requests = await ConnectionRequest.find({
        status: 'accepted',
        $or: [{ requester_id: req.userId }, { target_id: req.userId }],
      }).lean();

      const connections = requests.map((request) => {
        const isRequester = String(request.requester_id) === String(req.userId);
        return {
          id: request._id,
          user_id: isRequester ? request.target_id : request.requester_id,
          user_name: isRequester ? request.target_name : request.requester_name,
        };
      });

      return res.json({ connections });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load connections' });
    }
  }

  async function listStudents(req, res) {
    try {
      // The route's authorize('CanAccessCommunity') is now the only access
      // decision for the caller.
      const user = req.user;
      const { q, limit } = req.query;
      if (q && !isValidTextLength(String(q), 1, 100)) {
        return res.status(400).json({ error: 'q must be between 1 and 100 characters' });
      }

      const filter = {
        _id: { $ne: user._id },
        is_active: { $ne: false },
        is_teacher: { $ne: true },
        $or: [{ role: 'student' }, { role: { $exists: false } }],
      };

      if (q) {
        const escaped = String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.full_name = new RegExp(escaped, 'i');
      }

      const max = Math.min(Number(limit) || 50, 200);
      const students = await User.find(filter)
        .select('full_name profile_image role')
        .sort({ created_date: -1 })
        .limit(max)
        .lean();

      return res.json({ students });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load students' });
    }
  }

  return {
    listRequests,
    createRequest,
    updateRequest,
    listConnections,
    listStudents,
  };
}

module.exports = { createConnectionsController };
