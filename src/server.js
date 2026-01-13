require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { OAuth2Client } = require('google-auth-library');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const User = require('./models/User');
const Test = require('./models/Test');
const Question = require('./models/Question');
const TestAttempt = require('./models/TestAttempt');
const LiveClass = require('./models/LiveClass');
const LiveClassNote = require('./models/LiveClassNote');
const SubscriptionPlan = require('./models/SubscriptionPlan');
const Subscription = require('./models/Subscription');
const Doubt = require('./models/Doubt');
const Notification = require('./models/Notification');
const Feedback = require('./models/Feedback');
const ConnectionRequest = require('./models/ConnectionRequest');
const StudyGroup = require('./models/StudyGroup');
const GroupResource = require('./models/GroupResource');
const TeacherRequest = require('./models/TeacherRequest');

const app = express();
const server = http.createServer(app);

function resolveCorsOrigins() {
  const raw = process.env.CORS_ORIGIN;
  if (!raw) return true;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === 'string') return [parsed];
  } catch (err) {
    return raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return raw;
}

const corsOrigins = resolveCorsOrigins();
const corsOptions = {
  origin: (origin, cb) => {
    if (!origin || corsOrigins === true) return cb(null, true);
    if (Array.isArray(corsOrigins) && corsOrigins.includes(origin)) {
      return cb(null, true);
    }
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options('/*', cors(corsOptions));
app.use(express.json({ limit: '1mb' }));

const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use('/uploads', express.static(uploadsDir));

const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const unique = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    cb(null, `${unique}_${safeName}`);
  },
});

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image uploads are allowed'));
    }
    return cb(null, true);
  },
});

const csvUpload = multer({
  storage: uploadStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const isCsv =
      file.mimetype === 'text/csv' ||
      file.mimetype === 'application/vnd.ms-excel' ||
      file.originalname.toLowerCase().endsWith('.csv');
    if (!isCsv) {
      return cb(new Error('Only CSV uploads are allowed'));
    }
    return cb(null, true);
  },
});

const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const closeUnauthorized = () => {
    try {
      ws.close(1008, 'Unauthorized');
    } catch (err) {
      // ignore close errors
    }
  };

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    if (!token) {
      closeUnauthorized();
      return;
    }
    const payload = jwt.verify(token, JWT_SECRET);
    User.findById(payload.sub).lean()
      .then((user) => {
        if (!user) {
          closeUnauthorized();
          return;
        }
        ws.userEmail = user.email;
        ws.userId = user._id;
        ws.userRole = user.role;
        ws.isTeacher = Boolean(user.is_teacher);
        wsClients.add(ws);
        ws.on('close', () => wsClients.delete(ws));
      })
      .catch(() => closeUnauthorized());
  } catch (err) {
    closeUnauthorized();
  }
});

const { MONGODB_URI, GOOGLE_CLIENT_ID, PORT, JWT_SECRET, JWT_EXPIRES_IN } = process.env;

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
}

requireEnv('MONGODB_URI', MONGODB_URI);
requireEnv('GOOGLE_CLIENT_ID', GOOGLE_CLIENT_ID);
requireEnv('JWT_SECRET', JWT_SECRET);

const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID);
const tokenExpiry = JWT_EXPIRES_IN || '7d';

function signToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: tokenExpiry });
}

function sanitizeUser(user) {
  if (!user) return null;
  const { passwordHash, __v, ...rest } = user.toObject ? user.toObject() : user;
  return rest;
}

const wsClients = new Set();

function broadcastNotification(notification) {
  if (!notification) return;
  const payload = JSON.stringify({ type: 'notification', notification });
  wsClients.forEach((client) => {
    if (client.readyState !== WebSocket.OPEN) return;
    const isStaffClient = client.userRole === 'admin' || client.userRole === 'teacher' || client.isTeacher;
    if (
      notification.user_email === 'all' ||
      (notification.user_email === 'teachers' && isStaffClient) ||
      (notification.user_email === 'students' && !isStaffClient) ||
      client.userEmail === notification.user_email
    ) {
      client.send(payload);
    }
  });
}

function broadcastFeedback(feedback) {
  if (!feedback) return;
  const payload = JSON.stringify({ type: 'feedback', feedback });
  wsClients.forEach((client) => {
    if (client.readyState !== WebSocket.OPEN) return;
    if (client.userEmail === feedback.student_email) {
      client.send(payload);
    }
  });
}

function broadcastUserEvent({ userId, userEmail, type, data = {} }) {
  if (!type) return;
  const payload = JSON.stringify({ type, ...data, userId, userEmail });
  wsClients.forEach((client) => {
    if (client.readyState !== WebSocket.OPEN) return;
    if (userId && String(client.userId) === String(userId)) {
      client.send(payload);
      return;
    }
    if (userEmail && client.userEmail === userEmail) {
      client.send(payload);
    }
  });
}


async function hasAcceptedConnection(userId, otherId) {
  const existing = await ConnectionRequest.findOne({
    status: 'accepted',
    $or: [
      { requester_id: userId, target_id: otherId },
      { requester_id: otherId, target_id: userId },
    ],
  }).lean();
  return Boolean(existing);
}

function isStudentUser(user) {
  if (!user) return false;
  if (user.role === 'student') return true;
  return !user.role && !user.is_teacher;
}

async function createNotification({ userEmail, title, message, type = 'info', link = '' }) {
  if (!userEmail || !title || !message) return null;
  const notification = await Notification.create({
    user_email: userEmail,
    title,
    message,
    type,
    link,
  });
  broadcastNotification(notification.toObject());
  return notification;
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Authorization required' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.sub;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

async function requireAdmin(req, res, next) {
  try {
    const user = await User.findById(req.userId).lean();
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    req.user = user;
    return next();
  } catch (err) {
    return res.status(500).json({ error: 'Failed to verify admin access' });
  }
}

async function requireStaff(req, res, next) {
  try {
    const user = await User.findById(req.userId).lean();
    if (!user || (user.role !== 'admin' && user.role !== 'teacher' && !user.is_teacher)) {
      return res.status(403).json({ error: 'Staff access required' });
    }
    req.user = user;
    return next();
  } catch (err) {
    return res.status(500).json({ error: 'Failed to verify staff access' });
  }
}

function hasPermission(user, permission) {
  if (!user) return false;
  if (user.role === 'admin') {
    if (!Array.isArray(user.permissions) || user.permissions.length === 0) return true;
    if (user.permissions.includes(permission)) return true;
    if (permission === 'manage_feedback') return true;
    return false;
  }
  return false;
}

const PLAN_RANKS = {
  free: 0,
  basic: 1,
  medium: 2,
  advance: 3,
  premium: 4,
  ultimate: 5,
};

function getPlanRank(plan) {
  if (!plan) return 0;
  return PLAN_RANKS[plan] ?? 0;
}

async function updateTestQuestionCount(testId) {
  const count = await Question.countDocuments({ test_id: testId, is_active: true });
  await Test.findByIdAndUpdate(testId, { $set: { question_count: count } });
}

async function updateTestAttemptCount(testId) {
  const count = await TestAttempt.countDocuments({ test_id: testId, status: 'completed' });
  await Test.findByIdAndUpdate(testId, { $set: { attempt_count: count } });
}

async function updateUserAttemptStats(userId) {
  const attempts = await TestAttempt.find({ user_id: userId, status: 'completed' }).lean();
  const testsTaken = attempts.length;
  const avgScore = testsTaken
    ? attempts.reduce((sum, a) => sum + (a.percentage || 0), 0) / testsTaken
    : 0;
  await User.findByIdAndUpdate(userId, {
    $set: { tests_taken: testsTaken, average_score: avgScore },
  });
}

async function connectDb() {
  await mongoose.connect(MONGODB_URI, {
    autoIndex: true,
  });
  await ensureDefaultSubscriptionPlans();
  // eslint-disable-next-line no-console
  console.log('MongoDB connected');
}

async function ensureDefaultSubscriptionPlans() {
  const count = await SubscriptionPlan.countDocuments();
  if (count > 0) return;

  const defaults = [
    {
      plan_name: 'free',
      display_name: 'Free',
      description: 'Get started with essential practice tools.',
      price: 0,
      video_hours: 0,
      live_classes_per_month: '0',
      practice_questions: '0',
      notes_access: false,
      doubt_support: 'none',
      support_response_time: '',
      mock_tests: false,
      performance_analytics: false,
      study_plan: false,
      mentoring_sessions: '0',
      career_counseling: false,
      is_popular: false,
      is_active: true,
      sort_order: 0,
    },
    {
      plan_name: 'basic',
      display_name: 'Basic',
      description: 'Unlock premium tests and live classes.',
      price: 999,
      video_hours: 50,
      live_classes_per_month: '5',
      practice_questions: '500+',
      notes_access: true,
      doubt_support: 'basic',
      support_response_time: '24 hours',
      mock_tests: true,
      performance_analytics: true,
      study_plan: false,
      mentoring_sessions: '0',
      career_counseling: false,
      is_popular: false,
      is_active: true,
      sort_order: 1,
    },
    {
      plan_name: 'premium',
      display_name: 'Premium',
      description: 'Advanced analytics, mentoring, and priority support.',
      price: 2499,
      video_hours: 150,
      live_classes_per_month: 'Unlimited',
      practice_questions: '2000+',
      notes_access: true,
      doubt_support: 'priority',
      support_response_time: '12 hours',
      mock_tests: true,
      performance_analytics: true,
      study_plan: true,
      mentoring_sessions: '2',
      career_counseling: true,
      is_popular: true,
      is_active: true,
      sort_order: 2,
    },
    {
      plan_name: 'ultimate',
      display_name: 'Ultimate',
      description: 'Dedicated mentor with full access.',
      price: 4999,
      video_hours: 300,
      live_classes_per_month: 'Unlimited',
      practice_questions: '5000+',
      notes_access: true,
      doubt_support: 'dedicated',
      support_response_time: '2 hours',
      mock_tests: true,
      performance_analytics: true,
      study_plan: true,
      mentoring_sessions: 'Unlimited',
      career_counseling: true,
      is_popular: false,
      is_active: true,
      sort_order: 3,
    },
  ];

  await SubscriptionPlan.insertMany(defaults);
}

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/auth/register', async (req, res) => {
  try {
    const { email, password, full_name } = req.body;
    if (!email || !password || !full_name) {
      return res.status(400).json({ error: 'email, password, and full_name are required' });
    }

    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({ email, passwordHash, full_name });
    const token = signToken(user.id);

    return res.json({ user: sanitizeUser(user), token });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const user = await User.findOne({ email });
    if (!user || typeof user.passwordHash !== 'string' || !user.passwordHash.length) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = signToken(user.id);
    return res.json({ user: sanitizeUser(user), token });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    return res.json({ user: sanitizeUser(user) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to load user' });
  }
});

app.patch('/auth/me', authMiddleware, async (req, res) => {
  try {
    const allowedFields = [
      'full_name',
      'phone',
      'college',
      'year_of_study',
      'target_exam',
      'profile_image',
      'last_login_date',
      'subscription_plan',
      'role',
      'permissions',
      'admin_status',
      'is_teacher',
      'tests_taken',
      'average_score',
    ];

    const updates = {};
    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        updates[field] = req.body[field];
      }
    }

    const user = await User.findByIdAndUpdate(
      req.userId,
      { $set: updates },
      { new: true }
    );

    return res.json({ user: sanitizeUser(user) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update user' });
  }
});

app.get('/subscription-plans', async (req, res) => {
  try {
    const plans = await SubscriptionPlan.find({ is_active: true })
      .sort({ sort_order: 1 })
      .lean();
    return res.json({ plans });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to load plans' });
  }
});

app.get('/subscription-plans/all', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const plans = await SubscriptionPlan.find({})
      .sort({ sort_order: 1 })
      .lean();
    return res.json({ plans });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to load plans' });
  }
});

app.post('/subscription-plans', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const data = req.body || {};
    if (!data.plan_name || !data.display_name) {
      return res.status(400).json({ error: 'plan_name and display_name are required' });
    }
    const existing = await SubscriptionPlan.findOne({ plan_name: data.plan_name });
    if (existing) {
      return res.status(409).json({ error: 'Plan already exists' });
    }
    const plan = await SubscriptionPlan.create(data);
    return res.status(201).json({ plan });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create plan' });
  }
});

app.patch('/subscription-plans/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const updates = req.body || {};
    const plan = await SubscriptionPlan.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true }
    ).lean();
    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' });
    }
    return res.json({ plan });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update plan' });
  }
});

app.delete('/subscription-plans/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const plan = await SubscriptionPlan.findByIdAndDelete(req.params.id).lean();
    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to delete plan' });
  }
});

app.get('/subscriptions', authMiddleware, async (req, res) => {
  try {
    const { status, plan, all, limit } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (plan) filter.plan = plan;

    if (all === 'true') {
      const user = await User.findById(req.userId).lean();
      if (!user || user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
      }
    } else {
      filter.user_id = req.userId;
    }

    const max = Number(limit) || 100;
    const subscriptions = await Subscription.find(filter)
      .sort({ created_date: -1 })
      .limit(max)
      .lean();

    return res.json({ subscriptions });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to load subscriptions' });
  }
});

app.post('/subscriptions', authMiddleware, async (req, res) => {
  try {
    const data = req.body || {};
    if (!data.plan) {
      return res.status(400).json({ error: 'plan is required' });
    }

    const plan = await SubscriptionPlan.findOne({ plan_name: data.plan, is_active: true }).lean();
    if (!plan) {
      return res.status(400).json({ error: 'Plan is not available' });
    }

    const user = await User.findById(req.userId).lean();
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const startDate = data.start_date ? new Date(data.start_date) : new Date();
    const endDate = data.end_date ? new Date(data.end_date) : new Date(startDate);
    if (!data.end_date) {
      endDate.setMonth(endDate.getMonth() + 1);
    }

    const subscription = await Subscription.create({
      user_id: user._id,
      user_email: user.email,
      user_name: user.full_name || '',
      plan: data.plan,
      status: data.status || 'active',
      start_date: startDate,
      end_date: endDate,
    });

    if (subscription.status === 'active') {
      await User.findByIdAndUpdate(user._id, { $set: { subscription_plan: data.plan } });
      await createNotification({
        userEmail: user.email,
        title: 'Subscription activated',
        message: `Your ${data.plan} plan is now active.`,
        type: 'subscription',
      });
    }

    return res.status(201).json({ subscription });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create subscription' });
  }
});

app.patch('/subscriptions/:id', authMiddleware, async (req, res) => {
  try {
    const subscription = await Subscription.findById(req.params.id);
    if (!subscription) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    const user = await User.findById(req.userId).lean();
    const isAdmin = user?.role === 'admin';
    if (!isAdmin && String(subscription.user_id) !== String(req.userId)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const updates = req.body || {};
    const allowed = ['status', 'plan', 'start_date', 'end_date'];
    allowed.forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(updates, field)) {
        subscription[field] = updates[field];
      }
    });

    await subscription.save();

    if (subscription.status === 'active') {
      await User.findByIdAndUpdate(subscription.user_id, { $set: { subscription_plan: subscription.plan } });
    }

    return res.json({ subscription: subscription.toObject() });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update subscription' });
  }
});

app.delete('/subscriptions/:id', authMiddleware, async (req, res) => {
  try {
    const subscription = await Subscription.findById(req.params.id);
    if (!subscription) {
      return res.status(404).json({ error: 'Subscription not found' });
    }
    const user = await User.findById(req.userId).lean();
    const isAdmin = user?.role === 'admin';
    if (!isAdmin && String(subscription.user_id) !== String(req.userId)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    await subscription.deleteOne();
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to delete subscription' });
  }
});

app.get('/notifications', authMiddleware, async (req, res) => {
  try {
    const { limit, unread } = req.query;
    const user = await User.findById(req.userId).lean();
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const isStaff = user.role === 'admin' || user.role === 'teacher' || user.is_teacher;
    const audiences = isStaff
      ? [user.email, 'all', 'teachers']
      : [user.email, 'all', 'students'];
    const filter = { user_email: { $in: audiences } };
    if (unread === 'true') {
      filter.is_read = false;
    }

    const max = Number(limit) || 50;
    const notifications = await Notification.find(filter)
      .sort({ created_date: -1 })
      .limit(max)
      .lean();

    return res.json({ notifications });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to load notifications' });
  }
});

app.post('/notifications', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const data = req.body || {};
    if (!data.title || !data.message) {
      return res.status(400).json({ error: 'title and message are required' });
    }
    const userEmail = data.user_email || 'all';
    const notification = await createNotification({
      userEmail,
      title: data.title,
      message: data.message,
      type: data.type || 'info',
    });
    return res.status(201).json({ notification });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create notification' });
  }
});

app.patch('/notifications/:id', authMiddleware, async (req, res) => {
  try {
    const notification = await Notification.findById(req.params.id);
    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }
    const user = await User.findById(req.userId).lean();
    const isAdmin = user?.role === 'admin';
    if (!isAdmin && notification.user_email !== user.email && notification.user_email !== 'all') {
      return res.status(403).json({ error: 'Not authorized' });
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'is_read')) {
      notification.is_read = Boolean(req.body.is_read);
    }
    await notification.save();
    return res.json({ notification: notification.toObject() });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update notification' });
  }
});

app.post('/auth/google', async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) {
      return res.status(400).json({ error: 'idToken is required' });
    }

    const ticket = await oauthClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload) {
      return res.status(401).json({ error: 'Invalid Google token' });
    }

    const { sub: googleId, email, name, picture } = payload;
    if (!email) {
      return res.status(400).json({ error: 'Google account has no email' });
    }

    let user = await User.findOne({ $or: [{ googleId }, { email }] });
    if (user) {
      user.googleId = googleId;
      user.email = email;
      user.full_name = name || user.full_name;
      user.profile_image = picture || user.profile_image;
      await user.save();
    } else {
      user = await User.create({
        googleId,
        email,
        full_name: name || email,
        profile_image: picture,
      });
    }

    const token = signToken(user.id);
    return res.json({ user: sanitizeUser(user), token });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    return res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/tests', authMiddleware, async (req, res) => {
  try {
    const { all } = req.query;
    if (all === 'true') {
      const user = await User.findById(req.userId).lean();
      if (!user || (user.role !== 'admin' && user.role !== 'teacher' && !user.is_teacher)) {
        return res.status(403).json({ error: 'Staff access required' });
      }
    }
    const filter = all === 'true' ? {} : { is_published: true };
    const tests = await Test.find(filter).sort({ created_date: -1 }).lean();
    return res.json({ tests });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to load tests' });
  }
});

app.get('/tests/:id', authMiddleware, async (req, res) => {
  try {
    const test = await Test.findById(req.params.id).lean();
    if (!test) {
      return res.status(404).json({ error: 'Test not found' });
    }
    if (!test.is_published) {
      const user = await User.findById(req.userId).lean();
      if (!user || (user.role !== 'admin' && user.role !== 'teacher' && !user.is_teacher)) {
        return res.status(403).json({ error: 'Staff access required' });
      }
    }
    return res.json({ test });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to load test' });
  }
});

app.post('/tests', authMiddleware, requireStaff, async (req, res) => {
  try {
    const data = req.body || {};
    const test = await Test.create({
      title: data.title,
      description: data.description || '',
      subject: data.subject,
      difficulty: data.difficulty || 'medium',
      duration_minutes: data.duration_minutes ?? 60,
      total_marks: data.total_marks ?? 100,
      passing_marks: data.passing_marks ?? 40,
      is_free: Boolean(data.is_free),
      is_published: Boolean(data.is_published),
      created_by: req.user._id,
    });
    if (test.is_published) {
      await createNotification({
        userEmail: 'students',
        title: 'New test available',
        message: test.title || 'A new test is now available.',
        type: 'test_result',
      });
    }
    return res.status(201).json({ test });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create test' });
  }
});

app.patch('/tests/:id', authMiddleware, requireStaff, async (req, res) => {
  try {
    const updates = req.body || {};
    const existing = await Test.findById(req.params.id).lean();
    const test = await Test.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true }
    ).lean();
    if (!test) {
      return res.status(404).json({ error: 'Test not found' });
    }
    const justPublished = !existing?.is_published && test.is_published;
    const changedTitle = existing?.title !== test.title;
    if (justPublished || changedTitle) {
      await createNotification({
        userEmail: 'students',
        title: justPublished ? 'Test published' : 'Test updated',
        message: test.title || 'A test was updated.',
        type: 'test_result',
      });
    }
    return res.json({ test });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update test' });
  }
});

app.delete('/tests/:id', authMiddleware, requireStaff, async (req, res) => {
  try {
    const test = await Test.findByIdAndDelete(req.params.id).lean();
    if (!test) {
      return res.status(404).json({ error: 'Test not found' });
    }
    await Question.deleteMany({ test_id: req.params.id });
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to delete test' });
  }
});

app.get('/tests/:id/questions', authMiddleware, async (req, res) => {
  try {
    const test = await Test.findById(req.params.id).lean();
    if (!test) {
      return res.status(404).json({ error: 'Test not found' });
    }

    const user = await User.findById(req.userId).lean();
    const isAdmin = user?.role === 'admin';
    const filter = { test_id: req.params.id, is_active: true };

    if (!isAdmin) {
      const userRank = getPlanRank(user?.subscription_plan);
      const allowedPlans = Object.entries(PLAN_RANKS)
        .filter(([, rank]) => rank <= userRank)
        .map(([plan]) => plan);
      filter.required_plan = { $in: allowedPlans };
    }

    const questions = await Question.find(filter).sort({ created_date: 1 }).lean();
    return res.json({ questions });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to load questions' });
  }
});

app.post('/tests/:id/questions', authMiddleware, requireStaff, async (req, res) => {
  try {
    const test = await Test.findById(req.params.id).lean();
    if (!test) {
      return res.status(404).json({ error: 'Test not found' });
    }

    const data = req.body || {};
    const question = await Question.create({
      test_id: req.params.id,
      subject: test.subject,
      question_text: data.question_text,
      question_type: data.question_type || 'single_choice',
      options: data.options || [],
      correct_answers: data.correct_answers || [],
      explanation: data.explanation || '',
      explanation_image_url: data.explanation_image_url || '',
      difficulty: data.difficulty || 'medium',
      marks: data.marks ?? 1,
      negative_marks: data.negative_marks ?? 0,
      required_plan: data.required_plan || 'free',
      is_active: data.is_active !== false,
    });

    await updateTestQuestionCount(req.params.id);
    return res.status(201).json({ question });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create question' });
  }
});

app.post('/tests/:id/questions/bulk-csv', authMiddleware, requireStaff, csvUpload.single('file'), async (req, res) => {
  try {
    const test = await Test.findById(req.params.id).lean();
    if (!test) {
      return res.status(404).json({ error: 'Test not found' });
    }
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'CSV file is required' });
    }

    const content = fs.readFileSync(file.path, 'utf8');
    const records = parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    const created = [];
    const errors = [];
    const normalizePlan = (value) => {
      const plan = String(value || 'free').toLowerCase();
      if (['free', 'basic', 'premium', 'ultimate'].includes(plan)) return plan;
      if (plan === 'medium') return 'premium';
      if (plan === 'advance') return 'ultimate';
      return 'free';
    };

    records.forEach((row, index) => {
      try {
        const questionText = row.question_text || row.question || row.Question;
        if (!questionText) {
          throw new Error('question_text is required');
        }

        const optionA = row.option_a || row.optionA || row.a || row.A || '';
        const optionB = row.option_b || row.optionB || row.b || row.B || '';
        const optionC = row.option_c || row.optionC || row.c || row.C || '';
        const optionD = row.option_d || row.optionD || row.d || row.D || '';
        const options = [
          { id: '1', text: String(optionA) },
          { id: '2', text: String(optionB) },
          { id: '3', text: String(optionC) },
          { id: '4', text: String(optionD) },
        ];

        const correctRaw = row.correct_answers || row.correct || row.answer || '';
        const correctTokens = String(correctRaw)
          .split(/[,|;]/)
          .map((token) => token.trim().toUpperCase())
          .filter(Boolean);
        const mapAnswer = { A: '1', B: '2', C: '3', D: '4' };
        const correct_answers = correctTokens.map((token) => mapAnswer[token]).filter(Boolean);
        if (correct_answers.length === 0) {
          throw new Error('correct_answers is required');
        }

        const question_type =
          String(row.question_type || row.type || 'single_choice').toLowerCase() === 'multiple_choice'
            ? 'multiple_choice'
            : 'single_choice';

        const difficulty = String(row.difficulty || 'medium').toLowerCase();
        const marks = Number(row.marks ?? 1) || 1;
        const negative_marks = Number(row.negative_marks ?? 0) || 0;
        const required_plan = normalizePlan(row.required_plan || row.plan);

        created.push({
          test_id: req.params.id,
          subject: test.subject,
          question_text: String(questionText),
          question_type,
          options,
          correct_answers,
          explanation: String(row.explanation || ''),
          explanation_image_url: String(row.explanation_image_url || ''),
          difficulty,
          marks,
          negative_marks,
          required_plan,
          is_active: true,
        });
      } catch (err) {
        errors.push({ row: index + 1, error: err.message });
      }
    });

    if (created.length === 0) {
      return res.status(400).json({ error: 'No valid questions found', errors });
    }

    const inserted = await Question.insertMany(created);
    await updateTestQuestionCount(req.params.id);
    return res.status(201).json({
      inserted: inserted.length,
      errors,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to import CSV' });
  }
});

app.post('/uploads/questions', authMiddleware, requireStaff, upload.single('file'), (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: 'File is required' });
  }
  const url = `/uploads/${file.filename}`;
  return res.json({ url });
});

app.post('/uploads/doubts', authMiddleware, upload.single('file'), (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: 'File is required' });
  }
  const url = `/uploads/${file.filename}`;
  return res.json({ url });
});

app.post('/uploads/profile', authMiddleware, upload.single('file'), (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: 'File is required' });
  }
  const url = `/uploads/${file.filename}`;
  return res.json({ url });
});

app.patch('/questions/:id', authMiddleware, requireStaff, async (req, res) => {
  try {
    const existing = await Question.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Question not found' });
    }
    const updates = req.body || {};
    const previousTestId = existing.test_id;
    Object.assign(existing, updates);
    await existing.save();

    if (String(previousTestId) !== String(existing.test_id)) {
      await updateTestQuestionCount(previousTestId);
      await updateTestQuestionCount(existing.test_id);
    } else {
      await updateTestQuestionCount(existing.test_id);
    }

    return res.json({ question: existing.toObject() });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update question' });
  }
});

app.delete('/questions/:id', authMiddleware, requireStaff, async (req, res) => {
  try {
    const question = await Question.findByIdAndDelete(req.params.id);
    if (!question) {
      return res.status(404).json({ error: 'Question not found' });
    }
    await updateTestQuestionCount(question.test_id);
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to delete question' });
  }
});

app.get('/users', authMiddleware, requireStaff, async (req, res) => {
  try {
    const { role } = req.query;
    const filter = {};
    if (req.user.role !== 'admin' && !req.user.is_teacher) {
      filter.role = 'student';
      filter.is_teacher = { $ne: true };
    } else if (role) {
      filter.role = role;
    }
    const users = await User.find(filter).sort({ created_date: -1 }).lean();
    return res.json({ users });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to load users' });
  }
});

app.get('/doubts', authMiddleware, async (req, res) => {
  try {
    const { status, student_email: studentEmail, all, limit } = req.query;
    const filter = {};
    if (status) {
      filter.status = status;
    }

    if (all === 'true') {
      const user = await User.findById(req.userId).lean();
      if (!user || (user.role !== 'admin' && user.role !== 'teacher' && !user.is_teacher)) {
        return res.status(403).json({ error: 'Staff access required' });
      }
      if (studentEmail) {
        filter.student_email = studentEmail;
      }
    } else {
      filter.student_id = req.userId;
    }

    const max = Number(limit) || 100;
    const doubts = await Doubt.find(filter).sort({ created_date: -1 }).limit(max).lean();
    return res.json({ doubts });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to load doubts' });
  }
});

app.post('/doubts', authMiddleware, async (req, res) => {
  try {
    const data = req.body || {};
    if (!data.subject || !data.question) {
      return res.status(400).json({ error: 'subject and question are required' });
    }

    const user = await User.findById(req.userId).lean();
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const doubt = await Doubt.create({
      student_id: user._id,
      student_email: user.email,
      student_name: user.full_name || '',
      subject: data.subject,
      topic: data.topic || '',
      question: data.question,
      priority: data.priority || 'medium',
      image_url: data.image_url || '',
      status: data.status || 'pending',
    });

    await createNotification({
      userEmail: user.email,
      title: 'Doubt submitted',
      message: 'Your doubt has been submitted and will be reviewed shortly.',
      type: 'info',
    });
    await createNotification({
      userEmail: 'teachers',
      title: 'New doubt submitted',
      message: doubt.topic || 'A student submitted a new doubt.',
      type: 'doubt',
    });

    return res.status(201).json({ doubt });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create doubt' });
  }
});

app.patch('/doubts/:id', authMiddleware, async (req, res) => {
  try {
    const doubt = await Doubt.findById(req.params.id);
    if (!doubt) {
      return res.status(404).json({ error: 'Doubt not found' });
    }

    const user = await User.findById(req.userId).lean();
    const isStaff = user?.role === 'admin' || user?.role === 'teacher' || user?.is_teacher;
    const isOwner = String(doubt.student_id) === String(req.userId);
    if (!isStaff && !isOwner) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const previousStatus = doubt.status;
    const updates = req.body || {};
    if (isStaff) {
      const allowed = [
        'status',
        'answer',
        'answer_image_url',
        'assigned_teacher_email',
        'assigned_teacher_name',
      ];
      allowed.forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(updates, field)) {
          doubt[field] = updates[field];
        }
      });
    } else if (isOwner && doubt.status === 'pending') {
      const allowed = ['subject', 'topic', 'question', 'priority', 'image_url'];
      allowed.forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(updates, field)) {
          doubt[field] = updates[field];
        }
      });
    }

    const wasResolved = previousStatus === 'resolved';
    const wasAssigned = previousStatus === 'assigned';
    await doubt.save();

    if (!wasAssigned && doubt.status === 'assigned') {
      await createNotification({
        userEmail: doubt.student_email,
        title: 'Doubt assigned',
        message: 'A teacher has started working on your doubt.',
        type: 'info',
      });
    }

    if (!wasResolved && doubt.status === 'resolved') {
      await createNotification({
        userEmail: doubt.student_email,
        title: 'Your doubt was answered',
        message: doubt.topic || 'Check the response from your teacher.',
        type: 'doubt_answered',
      });
    }

    return res.json({ doubt: doubt.toObject() });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update doubt' });
  }
});

app.get('/feedback', authMiddleware, async (req, res) => {
  try {
    const { all, status, category, limit } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (category) filter.category = category;

    if (all === 'true') {
      const user = await User.findById(req.userId).lean();
      if (!user || (user.role !== 'admin' && user.role !== 'teacher' && !user.is_teacher)) {
        return res.status(403).json({ error: 'Staff access required' });
      }
      if (user.role === 'admin' && !hasPermission(user, 'manage_feedback')) {
        return res.status(403).json({ error: 'Feedback access required' });
      }
    } else {
      filter.student_id = req.userId;
    }

    const max = Number(limit) || 100;
    const feedback = await Feedback.find(filter)
      .sort({ created_date: -1 })
      .limit(max)
      .lean();
    return res.json({ feedback });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to load feedback' });
  }
});

app.post('/feedback', authMiddleware, async (req, res) => {
  try {
    const data = req.body || {};
    if (!data.message) {
      return res.status(400).json({ error: 'message is required' });
    }

    const user = await User.findById(req.userId).lean();
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const feedback = await Feedback.create({
      student_id: user._id,
      student_email: user.email,
      student_name: user.full_name || '',
      category: data.category || 'general',
      subject: data.subject || '',
      message: data.message,
      rating: Number(data.rating) || 0,
      status: 'open',
    });

    await createNotification({
      userEmail: 'teachers',
      title: 'New feedback submitted',
      message: feedback.subject || 'A student submitted feedback.',
      type: 'info',
    });

    return res.status(201).json({ feedback });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create feedback' });
  }
});

app.patch('/feedback/:id', authMiddleware, async (req, res) => {
  try {
    const feedback = await Feedback.findById(req.params.id);
    if (!feedback) {
      return res.status(404).json({ error: 'Feedback not found' });
    }

    const user = await User.findById(req.userId).lean();
    const isStaff = user?.role === 'admin' || user?.role === 'teacher' || user?.is_teacher;
    const isOwner = String(feedback.student_id) === String(req.userId);
    if (!isStaff && !isOwner) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    if (user?.role === 'admin' && isStaff && !hasPermission(user, 'manage_feedback')) {
      return res.status(403).json({ error: 'Feedback access required' });
    }

    const updates = req.body || {};
    if (isStaff) {
      const allowed = ['status', 'admin_response', 'responded_by'];
      allowed.forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(updates, field)) {
          feedback[field] = updates[field];
        }
      });
      if (updates.admin_response) {
        feedback.responded_at = new Date();
      }
    } else if (isOwner && feedback.status === 'open') {
      const allowed = ['category', 'subject', 'message', 'rating'];
      allowed.forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(updates, field)) {
          feedback[field] = updates[field];
        }
      });
    }

    await feedback.save();

    if (isStaff) {
      broadcastFeedback(feedback.toObject());
    }

    if (isStaff && updates.admin_response) {
      await createNotification({
        userEmail: feedback.student_email,
        title: 'Feedback response',
        message: feedback.subject || 'Your feedback has a response.',
        type: 'info',
      });
    }

    return res.json({ feedback: feedback.toObject() });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update feedback' });
  }
});


app.get('/connections/requests', authMiddleware, async (req, res) => {
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
    return res.json({ requests });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to load connection requests' });
  }
});

app.post('/connections/request', authMiddleware, async (req, res) => {
  try {
    const { target_email } = req.body || {};
    if (!target_email) {
      return res.status(400).json({ error: 'target_email is required' });
    }

    const requester = await User.findById(req.userId).lean();
    if (!requester || !isStudentUser(requester)) {
      return res.status(403).json({ error: 'Student access required' });
    }

    const target = await User.findOne({ email: target_email }).lean();
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

    return res.status(201).json({ request });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create connection request' });
  }
});

app.patch('/connections/requests/:id', authMiddleware, async (req, res) => {
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

    return res.json({ request: request.toObject() });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update connection request' });
  }
});

app.get('/connections', authMiddleware, async (req, res) => {
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
        user_email: isRequester ? request.target_email : request.requester_email,
        user_name: isRequester ? request.target_name : request.requester_name,
      };
    });

    return res.json({ connections });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to load connections' });
  }
});


app.get('/students', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).lean();
    if (!user || !isStudentUser(user)) {
      return res.status(403).json({ error: 'Student access required' });
    }

    const { q, limit } = req.query;
    const filter = {
      _id: { $ne: user._id },
      is_teacher: { $ne: true },
      $or: [{ role: 'student' }, { role: { $exists: false } }],
    };

    if (q) {
      const regex = new RegExp(q, 'i');
      filter.$and = [{ $or: [{ full_name: regex }, { email: regex }] }];
    }

    const max = Math.min(Number(limit) || 50, 200);
    const students = await User.find(filter)
      .select('full_name email role')
      .sort({ created_date: -1 })
      .limit(max)
      .lean();

    return res.json({ students });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to load students' });
  }
});

app.get('/groups', authMiddleware, async (req, res) => {
  try {
    const groups = await StudyGroup.find({ 'members.user_id': req.userId })
      .sort({ updated_date: -1 })
      .lean();
    return res.json({ groups });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to load groups' });
  }
});

app.post('/groups', authMiddleware, async (req, res) => {
  try {
    const data = req.body || {};
    if (!data.name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const creator = await User.findById(req.userId).lean();
    if (!creator || !isStudentUser(creator)) {
      return res.status(403).json({ error: 'Student access required' });
    }

    const emails = Array.isArray(data.member_emails) ? data.member_emails : [];
    const uniqueEmails = Array.from(new Set([creator.email, ...emails].filter(Boolean)));

    const members = [];
    for (const email of uniqueEmails) {
      const user = await User.findOne({ email }).lean();
      if (!user || !isStudentUser(user)) {
        return res.status(404).json({ error: `Student not found: ${email}` });
      }
      if (String(user._id) !== String(creator._id)) {
        const ok = await hasAcceptedConnection(creator._id, user._id);
        if (!ok) {
          return res.status(400).json({ error: `No accepted connection with ${email}` });
        }
      }
      members.push({
        user_id: user._id,
        user_email: user.email,
        user_name: user.full_name || '',
        role: String(user._id) === String(creator._id) ? 'admin' : 'member',
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

    return res.status(201).json({ group });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create group' });
  }
});

app.post('/groups/:id/members', authMiddleware, async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ error: 'email is required' });
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

    const user = await User.findOne({ email }).lean();
    if (!user || !isStudentUser(user)) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const alreadyMember = group.members.some((member) => String(member.user_id) === String(user._id));
    if (alreadyMember) {
      return res.status(409).json({ error: 'User already in group' });
    }

    const ok = await hasAcceptedConnection(req.userId, user._id);
    if (!ok) {
      return res.status(400).json({ error: `No accepted connection with ${email}` });
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

    return res.json({ group: group.toObject() });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to add group member' });
  }
});

app.get('/groups/:id/resources', authMiddleware, async (req, res) => {
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

    return res.json({ resources });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to load resources' });
  }
});

app.post('/groups/:id/resources', authMiddleware, async (req, res) => {
  try {
    const data = req.body || {};
    if (!data.title) {
      return res.status(400).json({ error: 'title is required' });
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

    return res.status(201).json({ resource });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to add resource' });
  }
});


app.post('/groups/:groupId/resources/:resourceId/like', authMiddleware, async (req, res) => {
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

    return res.json({ resource: resource.toObject() });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update like' });
  }
});


app.post('/groups/:groupId/resources/:resourceId/comments', authMiddleware, async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message) {
      return res.status(400).json({ error: 'message is required' });
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

    return res.json({ resource: resource.toObject() });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to add comment' });
  }
});




app.get('/teacher-requests', authMiddleware, async (req, res) => {
  try {
    const { all, status, category, priority, type, limit } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (category) filter.category = category;
    if (priority) filter.priority = priority;
    if (type) filter.type = type;

    if (all === 'true') {
      const user = await User.findById(req.userId).lean();
      if (!user || user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
      }
    } else {
      filter.teacher_id = req.userId;
    }

    const max = Number(limit) || 100;
    const requests = await TeacherRequest.find(filter)
      .sort({ created_date: -1 })
      .limit(max)
      .lean();

    return res.json({ requests });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to load teacher requests' });
  }
});

app.post('/teacher-requests', authMiddleware, async (req, res) => {
  try {
    const data = req.body || {};
    if (!data.title || !data.description) {
      return res.status(400).json({ error: 'title and description are required' });
    }

    const user = await User.findById(req.userId).lean();
    const isTeacher = user?.role === 'teacher' || user?.is_teacher;
    if (!isTeacher) {
      return res.status(403).json({ error: 'Teacher access required' });
    }

    const request = await TeacherRequest.create({
      teacher_id: user._id,
      teacher_email: user.email,
      teacher_name: user.full_name || '',
      type: data.type || 'suggestion',
      category: data.category || 'general',
      priority: data.priority || 'medium',
      module: data.module || '',
      impact: data.impact || 'students',
      title: data.title,
      description: data.description,
      desired_outcome: data.desired_outcome || '',
      reference_links: Array.isArray(data.reference_links) ? data.reference_links : [],
      contact_methods: Array.isArray(data.contact_methods) ? data.contact_methods : [],
      contact_email: data.contact_email || user.email,
      contact_phone: data.contact_phone || '',
      meeting_requested: Boolean(data.meeting_requested),
      preferred_time_slots: Array.isArray(data.preferred_time_slots) ? data.preferred_time_slots : [],
      timezone: data.timezone || '',
      status: 'open',
    });

    await createNotification({
      userEmail: user.email,
      title: 'Request submitted',
      message: 'Your request has been sent to the developer team.',
      type: 'info',
    });

    return res.status(201).json({ request });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create teacher request' });
  }
});

app.patch('/teacher-requests/:id', authMiddleware, async (req, res) => {
  try {
    const request = await TeacherRequest.findById(req.params.id);
    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    const user = await User.findById(req.userId).lean();
    const isAdmin = user?.role === 'admin';
    const isOwner = String(request.teacher_id) === String(req.userId);
    if (!isAdmin && !isOwner) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const updates = req.body || {};
    if (isAdmin) {
      const allowed = [
        'status',
        'priority',
        'developer_response',
        'response_tags',
        'meeting_link',
        'meeting_time',
        'responded_by',
      ];
      allowed.forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(updates, field)) {
          request[field] = updates[field];
        }
      });
      if (updates.developer_response) {
        request.responded_at = new Date();
      }
    } else if (isOwner && request.status === 'open') {
      const allowed = [
        'title',
        'description',
        'type',
        'category',
        'priority',
        'module',
        'impact',
        'desired_outcome',
        'reference_links',
        'contact_methods',
        'contact_email',
        'contact_phone',
        'meeting_requested',
        'preferred_time_slots',
        'timezone',
      ];
      allowed.forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(updates, field)) {
          request[field] = updates[field];
        }
      });
    }

    await request.save();

    if (isAdmin) {
      await createNotification({
        userEmail: request.teacher_email,
        title: 'Developer response',
        message: updates.developer_response || `Your request is now ${request.status}.`,
        type: 'info',
      });
    }

    return res.json({ request: request.toObject() });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update teacher request' });
  }
});

app.post('/users', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const data = req.body || {};
    if (!data.email || !data.full_name) {
      return res.status(400).json({ error: 'email and full_name are required' });
    }

    const existing = await User.findOne({ email: data.email });
    if (existing) {
      return res.status(409).json({ error: 'Email already exists' });
    }

    const userPayload = {
      email: data.email,
      full_name: data.full_name,
      role: data.role || 'student',
      permissions: data.permissions || [],
      admin_status: data.admin_status || 'active',
      subscription_plan: data.subscription_plan || 'free',
    };

    if (data.password) {
      userPayload.passwordHash = await bcrypt.hash(data.password, 10);
    }

    const user = await User.create(userPayload);
    return res.status(201).json({ user: sanitizeUser(user) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create user' });
  }
});

app.patch('/users/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const updates = req.body || {};
    const allowedFields = [
      'email',
      'full_name',
      'role',
      'permissions',
      'admin_status',
      'subscription_plan',
      'phone',
      'college',
      'year_of_study',
      'target_exam',
    ];

    const payload = {};
    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(updates, field)) {
        payload[field] = updates[field];
      }
    }

    if (updates.password) {
      payload.passwordHash = await bcrypt.hash(updates.password, 10);
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: payload },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({ user: sanitizeUser(user) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update user' });
  }
});

app.delete('/users/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    if (String(req.params.id) === String(req.userId)) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to delete user' });
  }
});

app.get('/classes', authMiddleware, async (req, res) => {
  try {
    const { all } = req.query;
    const filter = {};
    if (all === 'true') {
      const user = await User.findById(req.userId).lean();
      if (!user || (user.role !== 'admin' && user.role !== 'teacher' && !user.is_teacher)) {
        return res.status(403).json({ error: 'Staff access required' });
      }
    } else {
      filter.is_published = true;
    }

    const classes = await LiveClass.find(filter).sort({ scheduled_date: -1 }).lean();
    const now = new Date();
    const updates = [];
    classes.forEach((liveClass) => {
      const start = new Date(liveClass.scheduled_date);
      const end = new Date(start.getTime() + (liveClass.duration_minutes || 60) * 60000);
      let nextStatus = liveClass.status;
      if (now >= start && now <= end) {
        nextStatus = 'live';
      } else if (now > end) {
        nextStatus = 'completed';
      } else {
        nextStatus = 'scheduled';
      }
      if (nextStatus !== liveClass.status) {
        updates.push({ id: liveClass._id, status: nextStatus });
        liveClass.status = nextStatus;
      }
    });
    if (updates.length > 0) {
      await Promise.all(
        updates.map((u) => LiveClass.findByIdAndUpdate(u.id, { $set: { status: u.status } }))
      );
    }
    return res.json({ classes });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to load classes' });
  }
});

app.post('/classes', authMiddleware, requireStaff, async (req, res) => {
  try {
    const data = req.body || {};
    const liveClass = await LiveClass.create({
      title: data.title,
      description: data.description || '',
      subject: data.subject,
      teacher_name: data.teacher_name,
      teacher_email: data.teacher_email || '',
      scheduled_date: data.scheduled_date,
      duration_minutes: data.duration_minutes ?? 60,
      meeting_link: data.meeting_link || '',
      youtube_url: data.youtube_url || '',
      is_free: Boolean(data.is_free),
      is_published: Boolean(data.is_published),
      status: data.status || 'scheduled',
    });

    if (liveClass.is_published) {
      await createNotification({
        userEmail: 'students',
        title: 'New class scheduled',
        message: liveClass.title || 'A new class is available.',
        type: 'class_reminder',
      });
    }
    return res.status(201).json({ liveClass });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create class' });
  }
});

app.patch('/classes/:id', authMiddleware, requireStaff, async (req, res) => {
  try {
    const updates = req.body || {};
    const existing = await LiveClass.findById(req.params.id).lean();
    const liveClass = await LiveClass.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true }
    ).lean();

    if (!liveClass) {
      return res.status(404).json({ error: 'Class not found' });
    }

    const justPublished = !existing?.is_published && liveClass.is_published;
    const scheduleChanged = existing?.scheduled_date?.toString() !== liveClass.scheduled_date?.toString();
    if (justPublished || scheduleChanged) {
      await createNotification({
        userEmail: 'students',
        title: justPublished ? 'Class published' : 'Class updated',
        message: liveClass.title || 'A class was updated.',
        type: 'class_reminder',
      });
    }
    return res.json({ liveClass });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update class' });
  }
});

app.delete('/classes/:id', authMiddleware, requireStaff, async (req, res) => {
  try {
    const liveClass = await LiveClass.findByIdAndDelete(req.params.id).lean();
    if (!liveClass) {
      return res.status(404).json({ error: 'Class not found' });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to delete class' });
  }
});

app.get('/classes/:id/notes', authMiddleware, async (req, res) => {
  try {
    const notes = await LiveClassNote.find({
      class_id: req.params.id,
      user_id: req.userId,
    }).sort({ created_date: -1 }).lean();

    return res.json({ notes });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to load notes' });
  }
});

app.post('/classes/:id/notes', authMiddleware, async (req, res) => {
  try {
    const { text, timestamp } = req.body || {};
    if (!text) {
      return res.status(400).json({ error: 'text is required' });
    }

    const note = await LiveClassNote.create({
      class_id: req.params.id,
      user_id: req.userId,
      text,
      timestamp: timestamp || '',
    });

    return res.status(201).json({ note });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create note' });
  }
});

app.delete('/classes/:classId/notes/:noteId', authMiddleware, async (req, res) => {
  try {
    const note = await LiveClassNote.findOneAndDelete({
      _id: req.params.noteId,
      class_id: req.params.classId,
      user_id: req.userId,
    });
    if (!note) {
      return res.status(404).json({ error: 'Note not found' });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to delete note' });
  }
});

app.get('/attempts', authMiddleware, async (req, res) => {
  try {
    const { test_id: testId, status, all, limit } = req.query;
    const filter = {};

    if (testId) {
      filter.test_id = testId;
    }
    if (status) {
      filter.status = status;
    }

    if (all === 'true') {
      const user = await User.findById(req.userId).lean();
      if (!user || (user.role !== 'admin' && user.role !== 'teacher' && !user.is_teacher)) {
        return res.status(403).json({ error: 'Staff access required' });
      }
    } else {
      filter.user_id = req.userId;
    }

    const max = Number(limit) || 100;
    const attempts = await TestAttempt.find(filter)
      .sort({ created_date: -1 })
      .limit(max)
      .lean();

    if (attempts.length > 0) {
      const testIds = [...new Set(attempts.map((a) => String(a.test_id)))];
      const tests = await Test.find({ _id: { $in: testIds } })
        .select('title subject total_marks')
        .lean();
      const testMap = new Map(tests.map((test) => [String(test._id), test]));
      attempts.forEach((attempt) => {
        const test = testMap.get(String(attempt.test_id));
        if (test) {
          attempt.test_title = test.title;
          attempt.test_subject = test.subject;
          attempt.test_total_marks = test.total_marks;
        }
      });
    }

    return res.json({ attempts });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to load attempts' });
  }
});

app.post('/tests/:id/attempts', authMiddleware, async (req, res) => {
  try {
    const test = await Test.findById(req.params.id).lean();
    if (!test) {
      return res.status(404).json({ error: 'Test not found' });
    }

    const user = await User.findById(req.userId).lean();
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const data = req.body || {};
    const attempt = await TestAttempt.create({
      test_id: req.params.id,
      user_id: user._id,
      user_email: user.email,
      user_name: user.full_name,
      status: data.status || 'in_progress',
      started_at: data.started_at || new Date().toISOString(),
      total_marks: data.total_marks ?? test.total_marks ?? 0,
    });

    return res.status(201).json({ attempt });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create attempt' });
  }
});

app.patch('/attempts/:id', authMiddleware, async (req, res) => {
  try {
    const attempt = await TestAttempt.findById(req.params.id);
    if (!attempt) {
      return res.status(404).json({ error: 'Attempt not found' });
    }

    const user = await User.findById(req.userId).lean();
    const isAdmin = user?.role === 'admin';
    if (!isAdmin && String(attempt.user_id) !== String(req.userId)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const updates = req.body || {};
    const allowedFields = [
      'status',
      'answers',
      'score',
      'total_marks',
      'percentage',
      'time_taken_seconds',
      'completed_at',
    ];
    allowedFields.forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(updates, field)) {
        attempt[field] = updates[field];
      }
    });

    const wasCompleted = attempt.status === 'completed';
    await attempt.save();

    if (!wasCompleted && attempt.status === 'completed') {
      await updateTestAttemptCount(attempt.test_id);
      await updateUserAttemptStats(attempt.user_id);
      broadcastUserEvent({
        userId: attempt.user_id,
        userEmail: attempt.user_email,
        type: 'attempt_completed',
        data: { attemptId: attempt._id, testId: attempt.test_id },
      });
    }

    return res.json({ attempt: attempt.toObject() });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update attempt' });
  }
});

const port = Number(PORT) || 4000;

connectDb()
  .then(() => {
    server.listen(port, () => {
      // eslint-disable-next-line no-console
      console.log(`Server listening on http://localhost:${port}`);
    });
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to start server:', err);
    process.exit(1);
  });
