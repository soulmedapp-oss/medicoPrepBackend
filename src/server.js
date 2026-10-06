require('dotenv').config();

const { logger } = require('./lib/logger');
const errorReporter = require('./lib/errorReporter');

errorReporter.init();
const { reportError } = errorReporter;

const express = require('express');
const pinoHttp = require('pino-http');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const { csrfProtection } = require('./middlewares/csrf');
const { COOKIE } = require('./auth/session');
const http = require('http');
const cors = require('cors');
const nodemailer = require('nodemailer');
const mongoose = require('mongoose');
const path = require('path');
const os = require('os');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { enqueueJob } = require('./utils/inMemoryQueue');
const { syncPermissions } = require('./rbac/syncPermissions');
const { defaultRoleUpserts } = require('./rbac/defaultRoles');
const { authorize, selfService, publicRoute } = require('./rbac/authorize');
const authRoutes = require('./routes/authRoutes');
const createTestsRoutes = require('./routes/testsRoutes');
const createDoubtsRoutes = require('./routes/doubtsRoutes');
const createDiscussionsRoutes = require('./routes/discussionsRoutes');
const createFeedbackRoutes = require('./routes/feedbackRoutes');
const createConnectionsRoutes = require('./routes/connectionsRoutes');
const createGroupsRoutes = require('./routes/groupsRoutes');
const createSubscriptionsRoutes = require('./routes/subscriptionsRoutes');
const createNotificationsRoutes = require('./routes/notificationsRoutes');
const createTeacherRequestsRoutes = require('./routes/teacherRequestsRoutes');
const createUsersRoutes = require('./routes/usersRoutes');
const createVideosRoutes = require('./routes/videosRoutes');
const createPlaylistsRoutes = require('./routes/playlistsRoutes');
const createVideoProgressRoutes = require('./routes/videoProgressRoutes');
const createClassesRoutes = require('./routes/classesRoutes');
const createSubjectsRoutes = require('./routes/subjectsRoutes');
const createTutorSessionsRoutes = require('./routes/tutorSessionsRoutes');
const createRolesRoutes = require('./routes/rolesRoutes');
const createPermissionsRoutes = require('./routes/permissionsRoutes');
const createAuditLogRoutes = require('./routes/auditLogRoutes');
const createSettingsRoutes = require('./routes/settingsRoutes');
const createPaymentsRoutes = require('./routes/paymentsRoutes');
const createCouponsRoutes = require('./routes/couponsRoutes');
const createDashboardRoutes = require('./routes/dashboardRoutes');
// removed: engagement routes (case of day, precision review, boss week)
const { handleZoomWebhook } = require('./controllers/zoomController');
const { createPaymentsController } = require('./controllers/paymentsController');
const { createVideosController } = require('./controllers/videosController');
const { authMiddleware } = require('./middlewares/auth');
const { getRateLimitStats } = require('./middlewares/rateLimit');
const { errorHandler, createCorsError } = require('./middlewares/errorHandler');
const { bodyLimits } = require('./middlewares/bodyLimits');
const {
  createFileFilter,
  validateUploadedFile,
  isInlineSafeExtension,
  getExtension,
} = require('./utils/uploadValidation');
const { isTokenVersionCurrent } = require('./utils/security');
const { assignMissingTiers } = require('./utils/planPitch');
const { defaultFeaturesFor } = require('./utils/defaultPlanFeatures');
const User = require('./models/User');
const SubscriptionPlan = require('./models/SubscriptionPlan');
const Notification = require('./models/Notification');
const ConnectionRequest = require('./models/ConnectionRequest');
const Role = require('./models/Role');
const Video = require('./models/Video');
const { enqueueTutorSession } = require('./services/tutorService');
const { verifyBunnySignature } = require('./utils/bunnyWebhook');
const { applyBunnyStatusTransition } = require('./services/video/statusTransition');
const { getStatus } = require('./services/video/bunnyProvider');

const runningOnVercel = Boolean(process.env.VERCEL);
const runningOnLambda = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
const runningServerless = runningOnVercel || runningOnLambda;
const isProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production' || runningOnLambda;
const app = express();
let server;

// req.ip / rate limiting. On Lambda + API Gateway (HTTP API), serverless-express
// sets the socket address from requestContext.http.sourceIp, which the client
// cannot spoof, so X-Forwarded-For must NOT be trusted there. Locally, trust
// only loopback proxies. Override with TRUST_PROXY (e.g. "1" behind CloudFront).
function resolveTrustProxy() {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || raw === '') return runningOnLambda ? false : 'loopback';
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}
app.set('trust proxy', resolveTrustProxy());

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
    reportError(null, err, 'failed to send support email');
  }
}

function scheduleSupportEmail(payload) {
  enqueueJob(() => sendSupportEmail(payload));
}

function resolveCorsOrigins() {
  const enabled = String(process.env.CORS_ENABLED || 'true').toLowerCase() === 'true';
  if (!enabled) return false;
  const raw = process.env.CORS_ORIGIN;
  if (!raw) {
    if (isProduction) {
      // Never reflect arbitrary origins with credentials in production.
      process.stderr.write(
        'WARNING: CORS_ORIGIN is not set in production; cross-origin requests will be denied.\n'
      );
      return false;
    }
    return true;
  }
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
    if (corsOrigins === false) return cb(null, false);
    if (!origin || corsOrigins === true) return cb(null, true);
    if (Array.isArray(corsOrigins) && corsOrigins.includes(origin)) {
      return cb(null, true);
    }
    return cb(createCorsError());
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
// API-only security headers. The SPA's own CSP lives with the SPA (Vercel
// headers); these cover JSON responses, uploads and swagger.
app.use(helmet({
  contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } },
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // /uploads images are embedded by the SPA on another origin in dev
  referrerPolicy: { policy: 'no-referrer' },
  hsts: isProduction ? { maxAge: 15552000, includeSubDomains: true } : false,
}));
app.use(cookieParser());

// One JSON line per request (method, url, status, duration, correlationId,
// userId once auth has run). Bodies and Authorization headers are never
// logged. The correlation id is honoured from X-Correlation-Id /
// X-Request-Id when a caller sends one, minted otherwise, and echoed back so
// a student can read it to you from an error toast.
app.use(
  pinoHttp({
    logger,
    genReqId: (req) =>
      req.headers['x-correlation-id'] ||
      req.headers['x-request-id'] ||
      (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex')),
    customLogLevel: (req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    customSuccessMessage: (req, res) => `${req.method} ${req.originalUrl || req.url} ${res.statusCode}`,
    customErrorMessage: (req, res) => `${req.method} ${req.originalUrl || req.url} ${res.statusCode}`,
    quietReqLogger: true,
    customAttributeKeys: { reqId: 'correlationId' },
    customProps: (req, res) => ({
      userId: req.userId ? String(req.userId) : undefined,
      plan: req.user?.subscription_plan,
      errorMessage: res.locals.errorMessage,
    }),
    serializers: {
      req: (req) => ({ method: req.method, url: req.url }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
    autoLogging: { ignore: (req) => req.url === '/health' },
  })
);
app.use((req, res, next) => {
  req.correlationId = req.id;
  res.setHeader('X-Correlation-Id', req.id);
  // Keep the API's own error string on the request log line without ever
  // logging the body.
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (body && typeof body.error === 'string' && !res.locals.errorMessage) {
      res.locals.errorMessage = body.error;
    }
    return originalJson(body);
  };
  next();
});
app.options(/.*/, publicRoute, cors(corsOptions));
app.post('/webhooks/zoom', publicRoute, express.raw({ type: '*/*', limit: '2mb' }), handleZoomWebhook);
const paymentsController = createPaymentsController();
app.get('/webhooks/razorpay', publicRoute, (req, res) => {
  res.json({ ok: true });
});
app.post('/webhooks/razorpay', publicRoute, express.raw({ type: '*/*', limit: '2mb' }), paymentsController.handleWebhook);
app.use(
  express.json({
    limit: '1mb',
    // Bunny webhook signatures are computed over the raw bytes; keep a copy
    // before the body is parsed away.
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
// Safety net under the per-field checks in controllers: no string field
// over 20,000 characters anywhere in a JSON body, except the few that are
// legitimately long (a lecture transcript, rich-text question explanations).
app.use(bodyLimits({ overrides: { transcript_text: 200000, explanation: 50000, question_text: 50000 } }));
// Cookie sessions need CSRF protection on every state-changing request;
// bearer-header clients and public webhooks are exempt by construction
// (see checkCsrf). Same origin allow-list as CORS.
app.use(csrfProtection({ allowedOrigins: Array.isArray(corsOrigins) ? corsOrigins : [] }));
const apiDocsEnabled =
  String(process.env.ENABLE_API_DOCS || '').toLowerCase() === 'true' || !isProduction;
if (apiDocsEnabled) {
  // Loaded lazily so production cold starts skip swagger entirely.
  // eslint-disable-next-line global-require
  const swaggerUi = require('swagger-ui-express');
  // eslint-disable-next-line global-require
  const swaggerDocument = require('./docs/swagger');
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
}

function resolveUploadsDir() {
  const configured = process.env.UPLOADS_DIR;
  const defaultDir = configured || path.join(__dirname, '..', 'uploads');
  try {
    if (!fs.existsSync(defaultDir)) {
      fs.mkdirSync(defaultDir, { recursive: true });
    }
    return defaultDir;
  } catch (err) {
    const fallback = path.join(os.tmpdir(), 'uploads');
    try {
      if (!fs.existsSync(fallback)) {
        fs.mkdirSync(fallback, { recursive: true });
      }
      return fallback;
    } catch (fallbackErr) {
      return defaultDir;
    }
  }
}

const uploadsDir = resolveUploadsDir();
app.use(
  '/uploads',
  express.static(uploadsDir, {
    dotfiles: 'deny',
    index: false,
    setHeaders: (res, filePath) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (!isInlineSafeExtension(getExtension(filePath))) {
        // Anything that is not a raster image is downloaded, never rendered.
        res.setHeader('Content-Disposition', 'attachment');
      }
    },
  })
);

// Serverless (Lambda) has no persistent/shared filesystem, so uploads are held
// in memory and pushed to S3. Local dev with no S3 bucket configured still
// writes to the local uploads dir.
const uploadStorage = multer.memoryStorage();

const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { createUploadStorage, setDefaultStorage, UPLOAD_FOLDERS, uploadKeyFromUrl } = require('./lib/uploadStorage');
const { transcriptToPlainText } = require('./utils/transcriptText');
const uploadsBucket = require('./lib/deploymentEnvironment').uploadsBucket();
const uploadsS3Region =
  process.env.UPLOADS_S3_REGION || process.env.AWS_REGION || 'ap-south-1';
const s3Client = uploadsBucket ? new S3Client({ region: uploadsS3Region }) : null;

// Storage backend (S3 or local disk) and the readable key scheme live in
// src/lib/uploadStorage.js; every upload route names its UPLOAD_FOLDERS entry.
const fileStore = createUploadStorage({
  uploadsDir,
  bucket: uploadsBucket,
  prefix: require('./lib/deploymentEnvironment').uploadsPrefix(),
  region: uploadsS3Region,
  publicBaseUrl: process.env.UPLOADS_PUBLIC_BASE_URL || '',
  s3Client,
  PutObjectCommand,
  GetObjectCommand,
  isInlineSafeExtension,
});
const storeUpload = fileStore.storeUpload;
setDefaultStorage(fileStore);
logger.info({ mode: fileStore.mode, bucket: uploadsBucket || undefined, dir: fileStore.mode === 'disk' ? uploadsDir : undefined }, 'uploads storage');

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: createFileFilter('image'),
});

const csvUpload = multer({
  storage: uploadStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: createFileFilter('spreadsheet'),
});

const transcriptUpload = multer({
  storage: uploadStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: createFileFilter('transcript'),
});

const videoUpload = multer({
  storage: uploadStorage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: createFileFilter('video'),
});

function initRealtime(serverInstance) {
  const wss = new WebSocket.Server({ server: serverInstance, path: '/ws' });

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
      // Browsers send the session cookie on the upgrade request; the ?token=
      // query form remains for non-browser clients.
      const cookieHeader = String(req.headers.cookie || '');
      const cookieToken = cookieHeader
        .split(';')
        .map((c) => c.trim())
        .filter((c) => c.startsWith(`${COOKIE.access}=`))
        .map((c) => decodeURIComponent(c.slice(COOKIE.access.length + 1)))[0];
      const token = url.searchParams.get('token') || cookieToken;
      if (!token) {
        closeUnauthorized();
        return;
      }
      const payload = jwt.verify(token, JWT_SECRET);
      User.findById(payload.sub).lean()
        .then((user) => {
          if (!user || user.is_active === false || !isTokenVersionCurrent(payload, user)) {
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
}

const {
  MONGODB_URI,
  PORT,
  JWT_SECRET,
} = process.env;

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
}

requireEnv('MONGODB_URI', MONGODB_URI);
requireEnv('JWT_SECRET', JWT_SECRET);

// Every controller's own try/catch reports through reportError. This catches
// what doesn't: an error thrown outside any try/catch (a fire-and-forget
// async task, a WebSocket handler, a timer), which would otherwise only hit
// Node's default stderr and never reach the logs or the error tracker. On
// exit, flush so a report is not lost with the process.
process.on('uncaughtException', (err) => {
  reportError(null, err, 'uncaught exception');
  // Node's own guidance: the process is in an undefined state afterwards
  // and should exit, letting the process manager (nodemon locally, PM2/
  // systemd in prod) restart it cleanly. Not safe inside a single Lambda
  // invocation — that would tear down the execution environment for
  // unrelated concurrent invocations — so Lambda logs and keeps running.
  if (!runningOnLambda) {
    errorReporter.flush(1500).finally(() => process.exit(1));
  }
});

process.on('unhandledRejection', (reason) => {
  reportError(null, reason instanceof Error ? reason : new Error(String(reason)), 'unhandled promise rejection');
});

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
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }
  await mongoose.connect(MONGODB_URI, {
    autoIndex: true,
  });
  await ensureDefaultSubscriptionPlans();
  await ensurePlanTiers();
  await ensurePlanFeatures();
  await ensureDefaultRoles();
  // eslint-disable-next-line no-console
  logger.info({ db: mongoose.connection.name, host: mongoose.connection.host }, `MongoDB connected (db: ${mongoose.connection.name})`);
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
      tier: 0,
      features: ['transcript'],
      pitch: {
        headline: 'Start for free',
        highlights: [
          { icon: 'video', text: 'Sample recorded lectures' },
          { icon: 'questions', text: 'Limited practice questions' },
        ],
        banner_url: '',
      },
    },
    {
      plan_name: 'basic',
      display_name: 'Basic',
      description: 'Unlock premium tests and live classes.',
      price: 999,
      duration_value: 1,
      duration_unit: 'months',
      is_lifetime: false,
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
      tier: 1,
      features: ['transcript', 'ai_summary'],
      pitch: {
        headline: 'Unlock premium tests and live classes.',
        highlights: [
          { icon: 'video', text: 'All recorded lectures, organised by subject' },
          { icon: 'questions', text: 'Full question bank and mock tests' },
          { icon: 'check', text: 'Notes access included' },
        ],
        banner_url: '',
      },
    },
    {
      plan_name: 'premium',
      display_name: 'Premium',
      description: 'Advanced analytics, mentoring, and priority support.',
      price: 2499,
      duration_value: 1,
      duration_unit: 'months',
      is_lifetime: false,
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
      tier: 2,
      features: ['ai_tutor', 'ai_summary', 'transcript'],
      pitch: {
        headline: 'Everything in Basic, plus the full lecture library and live classes.',
        highlights: [
          { icon: 'video', text: 'All recorded lectures, organised by subject' },
          { icon: 'live', text: 'Live classes every week with recordings' },
          { icon: 'questions', text: 'Full question bank and mock tests' },
          { icon: 'doubt', text: 'Ask doubts and get a teacher’s answer' },
        ],
        banner_url: '',
      },
    },
    {
      plan_name: 'ultimate',
      display_name: 'Ultimate',
      description: 'Dedicated mentor with full access.',
      price: 4999,
      duration_value: 1,
      duration_unit: 'months',
      is_lifetime: false,
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
      tier: 3,
      features: ['ai_tutor', 'ai_summary', 'transcript'],
      pitch: {
        headline: 'Dedicated mentor with full access to everything.',
        highlights: [
          { icon: 'video', text: 'All recorded lectures, organised by subject' },
          { icon: 'live', text: 'Unlimited live classes with recordings' },
          { icon: 'questions', text: 'Full question bank and mock tests' },
          { icon: 'doubt', text: 'Dedicated mentor doubt support' },
          { icon: 'ai', text: 'AI-powered study plan' },
          { icon: 'analytics', text: 'Deep performance analytics' },
        ],
        banner_url: '',
      },
    },
  ];

  await SubscriptionPlan.insertMany(defaults);
}

// One-time, idempotent: plans created before `tier` existed order by sort_order.
// Final fix wave C1. This used to copy `sort_order` into `tier`, which put
// every plan sharing the default sort_order 0 at tier 0 — including PAID
// plans, which then unlocked all their gated content for every free student.
// assignMissingTiers (utils/planPitch, unit-tested) ranks instead: free plans
// (price <= 0) get 0, paid plans get 1, 2, 3… by (sort_order, then price). Any
// plan that already has a tier is preserved, so this stays idempotent.
async function ensurePlanTiers() {
  const plans = await SubscriptionPlan.find({})
    .select('plan_name price sort_order tier is_active')
    .lean();
  const assignments = assignMissingTiers(plans);
  if (assignments.length > 0) {
    await Promise.all(
      assignments.map(({ _id, tier }) => SubscriptionPlan.updateOne({ _id }, { $set: { tier } }))
    );
  }
  // `tier` carries a schema default of 0, so a paid plan can still be sitting
  // at tier 0 from before the API refusal landed, or from a hand-edited
  // document. entitlement.tierOf floors those at 1 so nothing fails open, but
  // an operator has to fix the ladder — say so loudly at every start.
  const byId = new Map(assignments.map(({ _id, tier }) => [String(_id), tier]));
  const misTiered = plans
    .filter((plan) => plan && plan.is_active !== false && Number(plan.price) > 0)
    .filter((plan) => Number(byId.has(String(plan._id)) ? byId.get(String(plan._id)) : plan.tier) === 0)
    .map((plan) => ({ plan_name: plan.plan_name, price: plan.price, tier: 0 }));
  if (misTiered.length > 0) {
    logger.warn(
      { plans: misTiered },
      `${misTiered.length} active paid plan(s) sit at tier 0 — their content is treated as tier 1 so it does not unlock for free students, but set a real tier in Plans`
    );
  }
}

// One-time, idempotent, like ensurePlanTiers: a plan created before `features`
// existed has the field absent (the schema default is `undefined`, not `[]`,
// precisely so this can tell "never set" apart from "admin cleared it to
// none"). Seeds src/utils/defaultPlanFeatures.js's defaults so a fresh deploy
// does not lock every existing student out of everything the moment this
// ships. Any plan that already has a `features` array — even an empty one —
// is left alone.
//
// Final fix wave I1: driven off the plans that actually need seeding rather
// than off the default table's keys, so each plan's STORED plan_name is run
// through normalizePlanName first — "medium" gets premium's set, "advance"
// gets ultimate's, and case no longer decides whether a plan is seeded at
// all. A name the table does not recognize is still left untouched.
async function ensurePlanFeatures() {
  const unseeded = await SubscriptionPlan.find({ features: { $exists: false } }).select('plan_name').lean();
  await Promise.all(
    unseeded.map((plan) => {
      const features = defaultFeaturesFor(plan.plan_name);
      if (!features) return null;
      return SubscriptionPlan.updateOne({ _id: plan._id, features: { $exists: false } }, { $set: { features } });
    })
  );
}

async function ensureDefaultRoles() {
  await syncPermissions();
  // Insert-only (fix round 1, item B): defaultRoleUpserts() puts everything,
  // including `permissions`, in $setOnInsert, so an admin's edits on the
  // Roles page are never overwritten by a later server start.
  await Promise.all(
    defaultRoleUpserts().map(({ filter, update }) => Role.updateOne(filter, update, { upsert: true }))
  );
  await Role.updateMany({ name: { $in: ['admin', 'student'] } }, { $set: { is_system: true } });
}

app.get('/health', publicRoute, (req, res) => {
  res.json({ ok: true });
});

app.use('/auth', authRoutes);
app.get('/admin/debug/rate-limit', authMiddleware, authorize('CanViewSettings'), (req, res) => {
  return res.json({ ok: true, stats: getRateLimitStats() });
});
app.use(
  createTestsRoutes({
    authMiddleware,
    csvUpload,
    createNotification,
    broadcastUserEvent,
    enqueueTutorSession,
  })
);
app.use(
  createDoubtsRoutes({
    authMiddleware,
    createNotification,
  })
);
// A lecture discussion is gated by the lecture, so it reuses the ONE
// playback gate (spec 6) instead of a second copy of the entitlement rule.
// createVideosController() is stateless, so this instance is equivalent to
// the one videosRoutes builds for itself.
const { loadVideoForPlayback } = createVideosController();
app.use(
  createDiscussionsRoutes({
    authMiddleware,
    createNotification,
    loadVideoForPlayback,
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
    createNotification,
    getPlansCache,
    setPlansCache,
    clearPlansCache,
  })
);
app.use(
  createNotificationsRoutes({
    authMiddleware,
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
    createNotification,
  })
);
app.use(
  createSubjectsRoutes({
    authMiddleware,
  })
);
app.use(
  createClassesRoutes({
    authMiddleware,
    createNotification,
  })
);
app.use(
  createVideosRoutes({
    authMiddleware,
  })
);
app.use(
  createPlaylistsRoutes({
    authMiddleware,
  })
);
app.use(
  createRolesRoutes({
    authMiddleware,
  })
);
app.use(
  createPermissionsRoutes({
    authMiddleware,
  })
);
app.use(
  createAuditLogRoutes({
    authMiddleware,
  })
);
app.use(
  createPaymentsRoutes({
    authMiddleware,
  })
);
app.use(
  createCouponsRoutes({
    authMiddleware,
  })
);
app.use(
  createDashboardRoutes({
    authMiddleware,
  })
);
app.use(
  createTutorSessionsRoutes({
    authMiddleware,
  })
);
app.use(
  createVideoProgressRoutes({
    authMiddleware,
  })
);
app.use(
  createSettingsRoutes({
    authMiddleware,
  })
);

async function handleUpload(res, file, kind, folder) {
  if (!file) {
    return res.status(400).json({ error: 'File is required' });
  }
  const validated = validateUploadedFile(kind, file);
  if (!validated.ok) {
    return res.status(400).json({ error: validated.error });
  }
  try {
    const url = await storeUpload(file, validated, folder);
    return res.json({ url });
  } catch (err) {
    reportError(null, err, 'upload failed');
    return res.status(500).json({ error: 'Upload failed' });
  }
}

app.post('/webhooks/bunny/video-status', publicRoute, async (req, res) => {
  const signature = req.get('X-BunnyStream-Signature');
  const secret = process.env.BUNNY_STREAM_READONLY_API_KEY || '';
  if (!verifyBunnySignature(req.rawBody, signature, secret)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  const { VideoGuid: guid, Status: status } = req.body || {};
  if (!guid || typeof guid !== 'string') {
    // Mongoose strips `undefined` filter values, so `findOne({ bunny_video_id:
    // undefined })` below would silently become `findOne({})` and apply the
    // transition to whatever document sorts first — an unrelated row. 200 (not
    // 400) so Bunny doesn't retry a callback we will never be able to use.
    return res.status(200).json({ ok: true });
  }
  const video = await Video.findOne({ bunny_video_id: guid });
  // 200 on an unknown guid so Bunny stops retrying a webhook we cannot use.
  if (!video) return res.status(200).json({ ok: true });

  // Persist the status transition (and any transcript_status bookkeeping) on
  // its own first, via the same logic the admin refresh-status endpoint uses.
  // Bunny already told us encoding finished, so that fact must not be lost -
  // a duration lookup failure below must never leave a ready video stuck
  // pre-ready forever.
  const next = await applyBunnyStatusTransition(video, status);
  if (next === 'ready') {
    // Best-effort metadata only: getStatus can throw (bad key, network error,
    // video deleted upstream, its own timeout). The ready transition above is
    // already saved, so a failure here just skips the duration and logs -
    // it must not hold the webhook response hostage or roll back readiness.
    try {
      const { duration_seconds: duration } = await getStatus(guid);
      video.duration_seconds = duration;
      await video.save();
    } catch (err) {
      reportError(req, err, 'bunny getStatus failed while fetching video duration');
    }
  }
  return res.json({ ok: true });
});

app.post(
  '/uploads/questions',
  authMiddleware,
  authorize.any('CanAddQuestions', 'CanEditQuestions', 'CanAddQuestionBank', 'CanEditQuestionBank'),
  upload.single('file'),
  (req, res) => handleUpload(res, req.file, 'image', UPLOAD_FOLDERS.questionImage)
);

// The bytes of a question image this API uploaded, so the editor can resize it in the
// browser (the bucket sends no CORS headers, so the page cannot read it directly).
// Only links to our own `questions/` uploads are served; anything else is refused.
app.get(
  '/uploads/questions/file',
  authMiddleware,
  authorize.any('CanAddQuestions', 'CanEditQuestions', 'CanAddQuestionBank', 'CanEditQuestionBank'),
  async (req, res) => {
    const key = uploadKeyFromUrl(String(req.query.url || ''), fileStore.config, UPLOAD_FOLDERS.questionImage);
    if (!key) return res.status(400).json({ error: 'Only images uploaded for questions can be opened here' });
    try {
      const { body, contentType } = await fileStore.readUpload(key);
      if (!contentType.startsWith('image/')) return res.status(400).json({ error: 'Not an image' });
      res.set('Content-Type', contentType);
      res.set('Cache-Control', 'private, no-store');
      return res.send(body);
    } catch (err) {
      return res.status(404).json({ error: 'Image not found' });
    }
  }
);

app.post('/uploads/classes', authMiddleware, authorize.any('CanAddClasses', 'CanEditClasses'), upload.single('file'), (req, res) =>
  handleUpload(res, req.file, 'image', UPLOAD_FOLDERS.classThumbnail)
);

app.post('/uploads/recordings', authMiddleware, authorize.any('CanAddClasses', 'CanEditClasses'), videoUpload.single('file'), (req, res) =>
  handleUpload(res, req.file, 'video', UPLOAD_FOLDERS.classRecording)
);

app.post('/uploads/videos', authMiddleware, authorize.any('CanAddVideos', 'CanEditVideos'), videoUpload.single('file'), (req, res) =>
  handleUpload(res, req.file, 'video', UPLOAD_FOLDERS.lectureVideo)
);

// The playlist's own thumbnail image — distinct from /uploads/videos above,
// which is the video FILE upload path (videoUpload, 'video' validation).
// Same permission gate as writing a playlist (playlistsRoutes.js).
app.post('/uploads/playlists', authMiddleware, authorize.any('CanAddVideos', 'CanEditVideos'), upload.single('file'), (req, res) =>
  handleUpload(res, req.file, 'image', UPLOAD_FOLDERS.playlistThumbnail)
);

// A lecture's own thumbnail image (Video.thumbnail_url), shown on the student
// lecture list. Image validation, same gate as editing a lecture.
app.post('/uploads/lecture-thumbnails', authMiddleware, authorize.any('CanAddVideos', 'CanEditVideos'), upload.single('file'), (req, res) =>
  handleUpload(res, req.file, 'image', UPLOAD_FOLDERS.lectureThumbnail)
);

// The banner image for a plan's upgrade pitch (SubscriptionPlan.pitch.banner_url).
// Same permission gate as writing a subscription plan.
app.post('/uploads/plan-banners', authMiddleware, authorize.any('CanAddSubscriptionPlans', 'CanEditSubscriptionPlans'), upload.single('file'), (req, res) =>
  handleUpload(res, req.file, 'image', UPLOAD_FOLDERS.planBanner)
);

app.post('/uploads/transcripts', authMiddleware, authorize.any('CanAddClasses', 'CanEditClasses'), transcriptUpload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: 'File is required' });
  }
  const validated = validateUploadedFile('transcript', file);
  if (!validated.ok) {
    return res.status(400).json({ error: validated.error });
  }
  let text = '';
  let url;
  try {
    url = await storeUpload(file, validated, UPLOAD_FOLDERS.classTranscript);
    text = transcriptToPlainText(file.buffer.toString('utf8'));
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read transcript' });
  }
  return res.json({ url, text });
});

app.post('/uploads/doubts', authMiddleware, authorize.any('CanAccessDoubts', 'CanAnswerDoubts'), upload.single('file'), (req, res) =>
  handleUpload(res, req.file, 'image', UPLOAD_FOLDERS.doubtImage)
);

app.post('/uploads/profile', authMiddleware, selfService, upload.single('file'), (req, res) =>
  handleUpload(res, req.file, 'image', UPLOAD_FOLDERS.profilePhoto)
);

// Final JSON error handler: multer (413/400), CORS (403), body-parser (400/413)
// and unexpected errors (500, generic message; never leaks err.message/stack).
app.use(errorHandler);

const port = Number(PORT) || 4000;

async function startLocalServer() {
  server = http.createServer(app);
  initRealtime(server);
  await connectDb();
  server.listen(port, process.env.HOST || undefined, () => {
    logger.info({ port }, `Server listening on http://localhost:${port}`);
  });
  startClassReminderLoop();
}

// Live-class reminders (1 hour before + at start), sent by one run of
// runClassRemindersOnce(). A long-lived server runs it every 5 minutes; on
// Lambda an EventBridge schedule invokes the function directly every 5 minutes
// (lambda.js, iac/reminders.tf). Send-once is guaranteed by ClassNotificationRun
// rows, so an overlapping run or a restart cannot double-send.
let reminderDeps = null;
async function runClassRemindersOnce() {
  if (!reminderDeps) {
    const { createClassesController } = require('./controllers/classesController');
    const { notifyClass } = require('./services/classNotifier');
    const { notifierDeps } = createClassesController({ createNotification });
    reminderDeps = {
      LiveClass: require('./models/LiveClass'),
      ClassNotificationRun: require('./models/ClassNotificationRun'),
      logger, reportError,
      notifyClass: (args) => notifyClass(args, notifierDeps),
    };
  }
  const { runDueReminders } = require('./services/classReminderScheduler');
  return runDueReminders(reminderDeps);
}

function startClassReminderLoop() {
  const tick = () => runClassRemindersOnce()
    .catch((err) => reportError(null, err, 'class reminder loop failed'));
  const timer = setInterval(tick, 5 * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 15 * 1000).unref?.();
}

if (!runningOnVercel && require.main === module) {
  startLocalServer().catch((err) => {
    reportError(null, err, 'failed to start server');
    process.exit(1);
  });
}

let dbReady = null;
async function ensureDbConnected() {
  if (!dbReady) {
    dbReady = connectDb();
  }
  try {
    await dbReady;
  } catch (err) {
    // Reset so the next invocation retries instead of reusing a rejected promise.
    dbReady = null;
    throw err;
  }
}

module.exports = async (req, res) => {
  if (runningServerless) {
    try {
      await ensureDbConnected();
    } catch (err) {
      reportError(null, err, 'DB connection failed');
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Service unavailable' }));
      return undefined;
    }
  }
  return app(req, res);
};

// For the Lambda entrypoint (lambda.js): the raw Express app plus the DB
// connector, so the handler can await the connection BEFORE the request is
// streamed into Express (awaiting inside the request listener drops the body).
module.exports.rawApp = app;
module.exports.ensureDbConnected = ensureDbConnected;
module.exports.runClassRemindersOnce = runClassRemindersOnce;
