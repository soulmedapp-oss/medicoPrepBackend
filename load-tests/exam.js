import http from 'k6/http';
import { check, sleep, fail } from 'k6';
import exec from 'k6/execution';
import { SharedArray } from 'k6/data';
import { Counter, Rate } from 'k6/metrics';

const base = (__ENV.BASE_URL || '').replace(/\/$/, '');
if (__ENV.LOAD_TEST_APPROVED !== 'staging-only' || !base || !__ENV.TEST_ID) {
  throw new Error('Set LOAD_TEST_APPROVED=staging-only, BASE_URL to isolated staging, and TEST_ID.');
}
const users = new SharedArray('synthetic students', () => JSON.parse(open(__ENV.USERS_FILE || './users.local.json')));
const target = Number(__ENV.STUDENTS || 100);
if (users.length < target) throw new Error('Provide one unique staging account per concurrent student.');
const answerLoss = new Rate('answer_loss');
const conflicts = new Counter('save_conflicts');

export const options = {
  scenarios: { exam: { executor: 'per-vu-iterations', vus: target, iterations: 1, maxDuration: '45m' } },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{operation:save}': ['p(95)<750', 'p(99)<2000'],
    'http_req_duration{operation:start}': ['p(95)<3000'],
    'http_req_duration{operation:submit}': ['p(95)<3000'],
    answer_loss: ['rate==0'],
    checks: ['rate>0.99'],
  },
};

function request(method, path, body, operation) {
  const cookies = http.cookieJar().cookiesForURL(base);
  return http.request(method, base + path, body === undefined ? null : JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': cookies.mp_csrf?.[0] || '' },
    tags: { operation, name: operation }, timeout: '15s',
  });
}

export default function () {
  const account = users[exec.vu.idInTest - 1];
  // Separate login ramp from synchronized exam opening. Set START_EPOCH_SECONDS
  // at least several minutes ahead so login does not dominate the start burst.
  sleep(Math.random() * Number(__ENV.LOGIN_SPREAD_SECONDS || 30));
  const login = request('POST', '/auth/login', account, 'login');
  if (!check(login, { 'login accepted': (r) => r.status === 200 })) fail('Staging login failed');
  const startAt = Number(__ENV.START_EPOCH_SECONDS || 0) * 1000;
  if (startAt > Date.now()) sleep((startAt - Date.now()) / 1000);
  const started = request('POST', `/tests/${__ENV.TEST_ID}/attempts`, {}, 'start');
  if (!check(started, { 'attempt started': (r) => r.status === 201 || r.status === 200 })) fail('Attempt start failed');
  const payload = started.json();
  let attempt = payload.attempt;
  const id = attempt._id || attempt.id;
  const questions = payload.questions || [];
  const answers = {};
  const steps = Math.min(questions.length, Number(__ENV.ANSWER_STEPS || 20));
  for (let i = 0; i < steps; i += 1) {
    const question = questions[i];
    answers[question._id || question.id] = [question.options?.[0]?.id || 'A'];
    sleep(5 + Math.random() * 5);
    const saved = request('PATCH', `/attempts/${id}`, { answers, answer_version: attempt.answer_version }, 'save');
    if (saved.status === 409) conflicts.add(1);
    if (!check(saved, { 'save acknowledged': (r) => r.status === 200 })) fail('Save failed; investigate before increasing load');
    attempt = saved.json('attempt');
    // Read periodically, simulating refresh and checking durable acknowledgments.
    if (i % 5 === 0) {
      const reloaded = request('GET', `/attempts/${id}`, undefined, 'resume');
      const remote = reloaded.json('attempt');
      const selected = new Map((remote?.answers || []).map((a) => [String(a.question_id), a.selected_options]));
      answerLoss.add(Object.entries(answers).some(([key, value]) => JSON.stringify(selected.get(key)) !== JSON.stringify(value)));
    }
  }
  const finishAt = Number(__ENV.SUBMIT_EPOCH_SECONDS || 0) * 1000;
  if (finishAt > Date.now()) sleep((finishAt - Date.now()) / 1000);
  const finished = request('PATCH', `/attempts/${id}`, { status: 'completed', answers, answer_version: attempt.answer_version }, 'submit');
  check(finished, { 'completed once': (r) => r.status === 200 });
  request('GET', `/tests/${__ENV.TEST_ID}/stats?attempt_id=${id}`, undefined, 'results');
  // Tutor and paid video calls are deliberately separate cost-controlled scenarios.
}
