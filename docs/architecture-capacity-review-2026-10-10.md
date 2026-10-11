# SoulMed architecture and capacity review

Date: 10 October 2026. Target: 10,000 concurrent students, nationwide tests,
broadcast classes and smaller interactive sessions, with growth over two years.

## Scope and confidence

Reviewed the current working files in the backend, frontend, AI service and
extracted infrastructure directories. This includes uncommitted changes. No live
AWS configuration, Terraform state, database query plans, production metrics,
provider contracts or performance benchmarks were inspected. Terraform defaults
are configuration evidence, not proof of what is deployed. No cloud changes or
load against production were performed.

Assessment: a functional pilot foundation with useful security and correctness
features, but not ready to certify for a synchronized 10,000-student exam. There
is no defensible measured concurrent-user ceiling yet. Even a small exam needs
answer durability and deadline fixes; these are correctness issues independent
of traffic. Use staged performance tests rather than advertising an invented
capacity number.

## Architecture present in code

| Component | Configuration found |
| --- | --- |
| Frontend | React/Vite, private S3 origin and CloudFront; API caching disabled |
| Backend | Express packaged for Lambda, API Gateway HTTP API; default 512 MB and 30-second timeout |
| Realtime | Node ws server on the persistent-server path; process-local connection set |
| AI API | App Runner; defaults 1 vCPU, 4 GB, maximum one instance; resource disabled by default |
| AI jobs | Optional SQS, DLQ and Fargate worker; default disabled, 0 minimum and 2 maximum tasks |
| MongoDB | External URI supplied out of band; optional self-hosted single EC2 node, default t4g.small and 30 GB gp3 |
| Vector database | Configurable; optional RDS pgvector defaults db.t4g.micro, disabled |
| Video | Zoom meeting integration and Bunny recorded-video integration; IVS was a recommendation, not an implemented deployment |

## Findings, ordered by impact

### 1. Critical: exam answers are not saved during the attempt

`frontend/soulmed/src/pages/TakeTest.jsx:222` updates React state on selection.
The only update mutation invocation is in final submission around line 285.
No answer persistence to local/session storage or resume of an in-progress
attempt was found in this page. The existing-attempt query asks for completed
attempts; page reload can create a new attempt and restart the client timer.
The backend supports in-progress updates but this page does not use them.

Impact: refresh, browser termination, or a failed connection near submission can
lose work. Add acknowledged periodic saves, a recoverable local pending-write
buffer, server resume, save status and retry/reconciliation behavior. Account for
shared-device privacy in any local storage design.

### 2. Critical: duration and exam closure are not enforced on submission

`src/controllers/testsController.js:1330` validates owner/status and grades on
the server, but does not reject completion based on started_at + duration_minutes
or available_until. Time reporting is clamped, which is not deadline enforcement.
The test live-window checks apply on starting/loading, not on completion. The
client timer is initialized from browser page state, not the saved server start.

Impact: late submissions and timer reset behavior undermine a national exam.
Persist a server deadline and paper version on creation, return server time,
enforce a documented grace policy, and reliably finalize saved work when the
browser disappears. Preserve answers during grace/retry handling.

### 3. High: attempts are not idempotently created or versioned

`src/controllers/testsController.js:1254` always creates a new attempt.
`src/models/TestAttempt.js` has useful query indexes but no request-id uniqueness
or active-attempt constraint. A frontend ref prevents some same-page duplicates;
it does not cover retries, multiple tabs or reloads. In-progress saves replace the
whole answer array without an expected-version check, so adding autosave as-is
would allow older requests to overwrite newer selections. Completion grades the
current questions, without a frozen paper version.

Add idempotent start/resume, a defined retake policy, answer sequence/version
checks and immutable exam content per attempt. Completion already has an atomic
not-completed condition; retain it.

### 4. High: exam completion and result statistics amplify database work

`src/controllers/testsController.js:205` recounts all completed attempts for the
test and writes the same Test record for each completion. User statistics are
also recomputed. `runCompletionSideEffects` awaits these operations before the
response. With N completions, repeated per-test counts can approach O(N^2)
index-entry work; an index makes each count cheaper but does not remove repetition.
Concurrent count-then-set operations can also leave a stale counter.

`getTestStats` around line 1149 computes summaries, median, top score and a
per-user percentile on request. Its score sorts are not covered by the declared
TestAttempt indexes. TakeTest requests stats after showing results, concentrating
these queries at exam end. Verify deployed indexes with explain rather than
assuming the schema is the complete database index inventory.

Keep the answer/completion write on the critical path; move derived stats and
tutor work to a durable outbox/queue. Precompute/cache per-exam aggregates and
publish ranked results on a defined schedule. Design event deduplication so a
retry cannot increment counts twice. Completion side effects currently have
no durable retry guarantee if the process dies after saving completion.

### 5. High: realtime does not match the Lambda deployment

`src/server.js:404` creates a WebSocket server and line 488 stores connections
in a local Set. It is initialized only by the persistent server startup path.
`lambda.js` proxies HTTP requests to the raw Express app and never starts this
listener. Terraform defines an HTTP API, not a WebSocket API; the frontend derives
its socket endpoint from /api/ws.

Under the shown Lambda architecture this is an unsupported realtime path. Under
multiple containers, broadcasts reach only clients on the broadcasting process.
Choose container WebSockets with shared pub/sub, or a separate managed realtime
service. Add connection limits, heartbeat cleanup, bounded send buffers,
reconnect jitter and replay/reconciliation. Sticky routing alone cannot fix
cross-instance broadcasts. The frontend has exponential reconnect delay but no
jitter, allowing reconnect bursts.

### 6. High: the backend tutor queue is process-local and serial

`src/utils/inMemoryQueue.js` has an unbounded array and runs one job at a time.
`src/services/tutorService.js:322` uses it for post-test feedback, separately from
the Python worker infrastructure. Its durable TutorSession record and stale
pending recovery help, but do not make job dispatch durable. Lambda can freeze
after the HTTP response, delaying unfinished work indefinitely until reuse.

Each tutor session makes sequential model batches (default five questions per
batch), plus a summary. For illustration, 100 questions and 10,000 sessions
would imply about 210,000 model calls before retries or failure handling. This
is workload arithmetic, not a measured throughput estimate.

Move this workflow to durable workers; make feedback opt-in/lazy or prioritize
incorrect questions; enforce global throughput and cost budgets and separate it
from exam submission. Do not enable unlimited post-exam generation for a cohort.

### 7. High: current AI defaults deliberately cap scaling

`infrastructure/aws/variables.tf:146` defaults API max instances to one.
`ai_service_max_concurrency=100` is an autoscaling threshold, not verified model
request capacity. Increasing it cannot add capacity when max instances is one.
The container starts one Uvicorn process. The optional worker defaults to two
tasks; its main job loop handles a job at a time, with additional extraction
behavior needing profiling. API lifespan also starts legacy reconciliation and
extraction tasks, so complete API/worker separation is not yet established.

Useful foundations already exist: SQS visibility extension, DLQ, Mongo job
leases/heartbeats, atomic per-user tutor daily quotas and a cost ledger. These
should not be discarded. Verify which features use each queue path. Daily quotas
are not a global simultaneous-request limit. Model RPM/TPM, retries, distributed
admission control and streaming load need separate validation.

For new deployments AWS recommends ECS Express Mode instead of App Runner:
https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html

### 8. High: database capacity and availability are not established

The optional Mongo Terraform creates one standalone EC2 database node. Defaults
are cost-oriented; daily EBS backups with seven-day retention provide recovery,
not live failover. An instance/AZ failure interrupts the application if this
option is used. The live Mongo URI may instead point elsewhere; verify it.
Use a suitable multi-AZ Mongo replica set/managed MongoDB deployment, restore
testing, connection monitoring and measured sizing. Do not assume DocumentDB is
a drop-in replacement without compatibility testing.

`src/server.js:568` reuses the database connection but enables autoIndex and runs
seeding on each execution environment's initialization. Mongo pool size and
connection wait bounds are not explicitly set. Lambda scaling multiplies pools
and cold-start database operations. `authMiddleware` loads User, then non-admin
role documents on authenticated requests. Shared role caching with prompt
invalidation and projections can reduce that read load without weakening session
revocation. The Mongo-backed rate limiter is shared, but adds writes on the
routes where it is attached; it is not a global per-request limiter.

Optional pgvector RDS has one-day backups, no deletion protection, skips the final
snapshot and enables public accessibility; no multi-AZ setting was found. Review
these settings before using it for production. Network exposure depends on the
security groups, not the public flag alone.

### 9. Medium/high: background polling creates substantial baseline load

NotificationBell polls every 30 seconds: 10,000 eligible active clients imply
about 333 requests/second. AuthContext heartbeats every 120 seconds add about
83/second. WatchLecture progress sync every 15 seconds adds about 667 writes/sec
if all 10,000 are using that HTML-video player. These are average calculations;
timers can cluster. Hidden tabs, pauses and actual mounted components change
the totals. Zoom participants are not automatically WatchLecture viewers.

Thus a fully active recorded-lecture scenario can approach 1,083 requests/sec
before navigation, chat, playback authorization or AI. Authentication adds DB
reads to these calls. Reduce unchanged progress writes, pause appropriately,
batch/delta-save, add jitter and rely on working realtime with infrequent fallback
polling. Do not infer 1,083 RPS capacity from 1,083 RPS generated demand.

### 10. Medium: unbounded lists and writes during reads

`classesController.listClasses` around line 151 reads the full matching class
list and changes status records during GET. Students arriving at a boundary can
perform the same status writes concurrently. Use pagination, projections and a
scheduled/idempotent lifecycle transition, or compute display status without
writing. `listTestQuestions` loads full documents and strips answer fields after
fetch; a student-safe projection and versioned paper cache would reduce work.
Keep answer-key content out of student cache objects entirely.

### 11. High operational gap: capacity has not been demonstrated

CloudWatch logging, Sentry hooks, some indexed queries, deployment scripts and
unit tests exist. Worker scaling alarms exist. No representative load-test suite,
API latency/error alarms, DB capacity alarms, complete canary rollback pipeline,
or WAF attachment was found in the reviewed files. These may exist out of band.
Review runtime support before rollout: Lambda Terraform still specifies
nodejs20.x. Separate dev/prod configuration and immutable release versions also
need verification. Live Zoom/Bunny capacity depends on account plans/quotas; AWS
API scaling does not enlarge a Zoom meeting. IVS broadcasting would require
application integration, access control and quota/cost planning.

## Capacity assessment

- Static frontend: appropriate architecture for a 10,000-user target; API/media
  dependencies still need validation.
- Exams: no safe capacity certification, even for small cohorts, until answer
  durability and deadline issues are addressed. Idle exam screens generate much
  less load than synchronized start/end, so an idle-user test would mislead.
- Backend HTTP: no honest numeric upper limit without hardware, DB tier, data
  volume, p95 latency and request mix. Lambda itself is not intrinsically limited
  to small cohorts; database amplification and workload design are the concern.
- Realtime: unsupported by the shown Lambda HTTP deployment; single-process
  design requires work before horizontal scaling.
- AI: constrained by a single-instance default, small worker cap and provider
  quotas. Concurrent students are not equivalent to concurrent model streams.
- Live video: external provider capacity, not app-server capacity. Confirm actual
  licenses and test join bursts separately from playback traffic.

Workload examples: 10,000 final submissions in 60 seconds means about 167
submissions/sec; in 10 seconds it means 1,000/sec, before result review/stats and
background polling. If future autosave is every 30 seconds, that adds about 333
saves/sec. Request concurrency is approximately RPS * mean service time: 1,000
RPS at 0.5 seconds needs around 500 concurrent requests, not 10,000 server tasks.

## Recommended order of work

1. Fix save/resume, server deadlines, versioned paper and start/save idempotency.
2. Remove aggregate/tutor work from final submission; use durable dispatch and
   reconciliation. Precompute results and bound AI requests.
3. Choose Lambda plus managed realtime, or ECS backend plus pub/sub. Both can
   scale with suitable design; changing compute alone does not fix data loss.
4. Establish production DB HA, capacity, backups, restore drills and bounded pools.
5. Enable/profile queue workers; isolate legacy API background paths; reduce polling.
6. Add monitoring, release rollback, quota headroom and load-test evidence.

## Validation plan

Use an isolated staging deployment and synthetic student accounts/data. Progress
through 100, 250, 500, 1,000, 2,500, 5,000 and 10,000 active users, stopping at the
first failed target. These are test stages, not claimed existing capacity.
Then test a 15,000-20,000 burst only if the baseline passes. Model realistic
student think time and record arrival RPS as well as concurrent users.

Exercise mass login/start, full paper delivery, saves/resume, 60-second and
10-second submission waves, results, notification polling, video progress,
WebSocket reconnection and bounded AI streams. Include a long exam-duration soak,
browser reload, offline recovery, repeated/out-of-order saves, task termination,
worker redelivery and database failover. Test external video/model services only
within approved quotas and cost budgets.

Suggested initial acceptance criteria (to agree as product SLOs): zero lost
acknowledged answers; no duplicate finalization; correct deadline enforcement;
p95 save latency under one second and completion under two seconds; unexpected
errors below 0.1%; no growing queues, pool waits or DB saturation during the soak.
Measure p99, cold starts, DB operation latency, connections, CPU/memory, queue age,
reconnect rate, provider throttles and cost. Capacity is the largest passing
workload with operational headroom, not the maximum before a crash.

## Checks performed

Ran `node --test test/testsAttempts.test.js test/testsLocked.test.js
test/rbacLoadPermissions.test.js`: 23 passed, zero failed. These are functional
tests with mocked dependencies and do not prove database throughput or live
capacity. No production load test or database migration was performed.

AWS references:
- https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html
  (HTTP API integration timeout 30 seconds).
- https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html
  (execution environment lifecycle and unfinished background work).
- https://docs.aws.amazon.com/lambda/latest/dg/best-practices.html
  (connection reuse and stateless durable work).
