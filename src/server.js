require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const nodemailer = require('nodemailer');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { enqueueJob } = require('./utils/inMemoryQueue');
const authRoutes = require('./routes/authRoutes');
const createTestsRoutes = require('./routes/testsRoutes');
const createDoubtsRoutes = require('./routes/doubtsRoutes');
const createFeedbackRoutes = require('./routes/feedbackRoutes');
const createConnectionsRoutes = require('./routes/connectionsRoutes');
const createGroupsRoutes = require('./routes/groupsRoutes');
const createSubscriptionsRoutes = require('./routes/subscriptionsRoutes');
const createNotificationsRoutes = require('./routes/notificationsRoutes');
const createTeacherRequestsRoutes = require('./routes/teacherRequestsRoutes');
const createUsersRoutes = require('./routes/usersRoutes');
const createClassesRoutes = require('./routes/classesRoutes');
const {
  authMiddleware,
  requireAdmin,
  requireStaff,
} = require('./middlewares/auth');
const User = require('./models/User');
const SubscriptionPlan = require('./models/SubscriptionPlan');
const Notification = require('./models/Notification');
const ConnectionRequest = require('./models/ConnectionRequest');

const app = express();
const server = http.createServer(app);

const corsEnabled = String(process.env.CORS_ENABLED || 'true').toLowerCase() === 'true';
if (corsEnabled) {
  app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
}
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'soulmedapp@gmail.com';
let supportTransport;
const plansCacheTtlMs = Math.max(0, Number(process.env.PLANS_CACHE_TTL_MS || 60000));
const plansCache = {
  public: { value: null, expiresAt: 0 },
  all: { value: null, expiresAt: 0 },
};

function getPlansCache(key) {
  if (plansCacheTtlMs === 0) return null;
  const entry = plansCache[key];
  if (!entry) return null;
  if (entry.expiresAt > Date.now()) return entry.value;
  entry.value = null;
  entry.expiresAt = 0;
  return null;
}

function setPlansCache(key, value) {
  if (plansCacheTtlMs === 0) return;
  if (!plansCache[key]) return;
  plansCache[key].value = value;
  plansCache[key].expiresAt = Date.now() + plansCacheTtlMs;
}

function clearPlansCache() {
  plansCache.public.value = null;
  plansCache.public.expiresAt = 0;
  plansCache.all.value = null;
  plansCache.all.expiresAt = 0;
}

function getSupportTransport() {
  if (supportTransport !== undefined) return supportTransport;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    supportTransport = null;
    return supportTransport;
  }
  supportTransport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: SMTP_SECURE === 'true',
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });
  return supportTransport;
}

async function sendSupportEmail({ subject, text }) {
  const transport = getSupportTransport();
  if (!transport) return;
  const fromAddress = process.env.SMTP_FROM || SUPPORT_EMAIL;
  try {
    await transport.sendMail({
      from: fromAddress,
      to: SUPPORT_EMAIL,
      subject,
      text,
    });
  } catch (err) {
    console.error('Failed to send support email:', err);
  }
}

function scheduleSupportEmail(payload) {
  enqueueJob(() => sendSupportEmail(payload));
}

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
app.options(/.*/, cors(corsOptions));
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  const headerId = req.headers['x-correlation-id'] || req.headers['x-request-id'];
  const correlationId = headerId || (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'));
  req.correlationId = correlationId;
  res.setHeader('X-Correlation-Id', correlationId);

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (body && typeof body.error === 'string' && !res.locals.errorMessage) {
      res.locals.errorMessage = body.error;
    }
    return originalJson(body);
  };

  res.on('finish', () => {
    if (res.statusCode < 400) return;
    const level = res.statusCode >= 500 ? 'error' : 'warn';
    const userName =
      req.user?.email ||
      req.user?.full_name ||
      req.body?.email ||
      req.query?.email ||
      'unknown';
    const errorMessage =
      res.locals.errorMessage ||
      `HTTP ${res.statusCode} ${req.method} ${req.originalUrl}`;

    logMessage(level, {
      userName,
      correlationId,
      errorMessage,
      statusCode: res.statusCode,
    });
  });

  next();
});

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
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.originalname.toLowerCase().endsWith('.csv') ||
      file.originalname.toLowerCase().endsWith('.xls') ||
      file.originalname.toLowerCase().endsWith('.xlsx');
    if (!isCsv) {
      return cb(new Error('Only CSV or Excel uploads are allowed'));
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

const {
  MONGODB_URI,
  PORT,
  JWT_SECRET,
  LOG_DIR,
  LOG_FILE_PREFIX,
  LOG_ENV_NAME,
  LOG_APP_NAME,
} = process.env;

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
}

requireEnv('MONGODB_URI', MONGODB_URI);
requireEnv('JWT_SECRET', JWT_SECRET);

const logAppName = LOG_APP_NAME || 'SOULMED';
const logEnvName = (LOG_ENV_NAME || process.env.NODE_ENV || 'DEV').toUpperCase();
const logDir = LOG_DIR || path.join(__dirname, '..', 'logs');
const logFilePrefix = LOG_FILE_PREFIX || `${logAppName}_LOG`;
const maxLogFileSize = 5 * 1024 * 1024;
const LOG_LEVELS = {
  info: 1,
  warn: 2,
  error: 3,
};
const devEnvs = new Set(['DEV', 'LOCAL', 'DEVELOPMENT']);
const isDevEnv = devEnvs.has(logEnvName);
const consoleLevelName = String(
  process.env.LOG_CONSOLE_LEVEL || (isDevEnv ? 'info' : 'error')
).toLowerCase();
const fileLevelName = String(process.env.LOG_FILE_LEVEL || 'info').toLowerCase();
const consoleLevel = LOG_LEVELS[consoleLevelName] || LOG_LEVELS.info;
const fileLevel = LOG_LEVELS[fileLevelName] || LOG_LEVELS.info;

function ensureLogDir() {
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
}

function getLogFilePath() {
  ensureLogDir();
  const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const base = `${logFilePrefix}_${dateStamp}_${logEnvName}`;
  const files = fs.readdirSync(logDir).filter((name) =>
    name.startsWith(base) && name.endsWith('.log')
  );

  const indices = files.map((name) => {
    const match = name.match(/_(\d{3})\.log$/);
    return match ? Number(match[1]) : 1;
  });

  let index = indices.length ? Math.max(...indices) : 1;
  let fileName = `${base}_${String(index).padStart(3, '0')}.log`;
  let filePath = path.join(logDir, fileName);

  if (fs.existsSync(filePath)) {
    const size = fs.statSync(filePath).size;
    if (size >= maxLogFileSize) {
      index += 1;
      fileName = `${base}_${String(index).padStart(3, '0')}.log`;
      filePath = path.join(logDir, fileName);
    }
  }

  return filePath;
}

function redactSensitive(value) {
  if (!value) return value;
  return String(value).replace(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    '[redacted-email]'
  );
}

function formatLogEntry(
  { logType, userName, correlationId, errorMessage, statusCode, errorStack },
  redact
) {
  const safeUser = redact ? '[redacted]' : (userName || 'unknown');
  const safeMessage = redact ? redactSensitive(errorMessage) : (errorMessage || '-');
  const safeStack = redact ? undefined : errorStack;
  return [
    '------------------',
    `APP Name: ${logAppName}`,
    `Log Type: ${logType}`,
    `Environment: ${logEnvName}`,
    `Date Time: ${new Date().toISOString()}`,
    `User Name: ${safeUser}`,
    `Status Code: ${statusCode || '-'}`,
    `Correlationid: ${correlationId || 'unknown'}`,
    `Error Message: ${safeMessage}`,
    safeStack ? `Stack Trace: ${safeStack}` : '',
    '',
  ].join('\n');
}

function writeLogEntry(entry) {
  const payload = formatLogEntry(entry, false);

  try {
    const filePath = getLogFilePath();
    fs.appendFileSync(filePath, `${payload}\n`, 'utf8');
  } catch (err) {
    try {
      process.stderr.write(`Failed to write log file: ${err.message || err}\n`);
    } catch (innerErr) {
      // ignore logging failures
    }
  }
}

function writeConsoleEntry(entry, level) {
  const payload = formatLogEntry(entry, !isDevEnv);
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(`${payload}\n`);
}

function logMessage(level, { userName, correlationId, errorMessage, statusCode, errorStack }) {
  const logType = level.charAt(0).toUpperCase() + level.slice(1);
  const entry = { logType, userName, correlationId, errorMessage, statusCode, errorStack };
  const levelValue = LOG_LEVELS[level] || LOG_LEVELS.info;
  if (levelValue >= fileLevel) {
    writeLogEntry(entry);
  }
  if (levelValue >= consoleLevel) {
    writeConsoleEntry(entry, level);
  }
}

console.error = (...args) => {
  const errorArg = args.find((arg) => arg instanceof Error);
  const message = args
    .map((arg) => (arg instanceof Error ? (arg.stack || arg.message) : String(arg)))
    .join(' ');
  logMessage('error', { errorMessage: message, errorStack: errorArg?.stack });
};

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

app.use('/auth', authRoutes);
app.use(
  createTestsRoutes({
    authMiddleware,
    requireStaff,
    csvUpload,
    createNotification,
    broadcastUserEvent,
  })
);
app.use(
  createDoubtsRoutes({
    authMiddleware,
    createNotification,
  })
);
app.use(
  createFeedbackRoutes({
    authMiddleware,
    createNotification,
    sendSupportEmail: scheduleSupportEmail,
    broadcastFeedback,
  })
);
app.use(
  createConnectionsRoutes({
    authMiddleware,
    createNotification,
    isStudentUser,
  })
);
app.use(
  createGroupsRoutes({
    authMiddleware,
    createNotification,
    hasAcceptedConnection,
    isStudentUser,
  })
);
app.use(
  createSubscriptionsRoutes({
    authMiddleware,
    requireAdmin,
    createNotification,
    getPlansCache,
    setPlansCache,
    clearPlansCache,
  })
);
app.use(
  createNotificationsRoutes({
    authMiddleware,
    requireAdmin,
    createNotification,
  })
);
app.use(
  createTeacherRequestsRoutes({
    authMiddleware,
    createNotification,
  })
);
app.use(
  createUsersRoutes({
    authMiddleware,
    requireAdmin,
  })
);
app.use(
  createClassesRoutes({
    authMiddleware,
    requireStaff,
    createNotification,
  })
);

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

