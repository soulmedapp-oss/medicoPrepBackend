const path = require('path');
const fs = require('fs');
const pino = require('pino');

// One JSON line per event, to stdout. Whoever collects stdout (CloudWatch on
// Lambda, the host's log viewer on Render/Railway, a terminal locally) is a
// hosting decision, not this module's business.
//
// Levels: fatal > error > warn > info > debug. Production runs at `info`
// (one line per request plus business events); set LOG_LEVEL=debug only
// while chasing something. Request/response bodies and Authorization headers
// are never logged — see `redact` below — because that is where log bills and
// leaked tokens both come from.

const runningOnLambda = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
const nodeEnv = String(process.env.NODE_ENV || 'development').toLowerCase();
const isProduction = nodeEnv === 'production' || runningOnLambda;
const isTest = nodeEnv === 'test' || Boolean(process.env.NODE_TEST_CONTEXT);

const level = String(process.env.LOG_LEVEL || (isTest ? 'silent' : 'info')).toLowerCase();

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.refresh_token',
  '*.api_key',
  '*.apiKey',
  '*.secret',
];

// Local/VPS convenience: mirror the stream into a daily file when LOG_DIR is
// set. Never on Lambda (read-only filesystem, and CloudWatch already has it).
function fileDestination() {
  const dir = process.env.LOG_DIR;
  if (!dir || runningOnLambda || isTest) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const prefix = process.env.LOG_FILE_PREFIX || `${process.env.LOG_APP_NAME || 'SOULMED'}_LOG`;
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return pino.destination({ dest: path.join(dir, `${prefix}_${day}.log`), sync: false, mkdir: true });
  } catch (err) {
    process.stderr.write(`logger: cannot open LOG_DIR ${dir}: ${err.message}\n`);
    return null;
  }
}

function buildStream() {
  const file = fileDestination();
  if (!isProduction && !isTest) {
    // Human-readable locally. pino-pretty is a devDependency; fall back to
    // raw JSON if it is not installed (e.g. `npm ci --omit=dev`).
    try {
      // eslint-disable-next-line global-require
      const pretty = require('pino-pretty');
      const prettyStream = pretty({ colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' });
      return file ? pino.multistream([{ stream: prettyStream }, { stream: file }]) : prettyStream;
    } catch (err) {
      // fall through to JSON
    }
  }
  return file ? pino.multistream([{ stream: process.stdout }, { stream: file }]) : process.stdout;
}

const logger = pino(
  {
    level,
    base: {
      app: process.env.LOG_APP_NAME || 'SOULMED',
      env: process.env.LOG_ENV_NAME || nodeEnv,
    },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    // pino's default `err` serializer keeps type/message/stack and drops the
    // rest, which is what we want in a log line.
    serializers: { err: pino.stdSerializers.err },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  buildStream()
);

module.exports = { logger, isProduction, runningOnLambda, REDACT_PATHS };
