# Exam reliability: first implementation batch

Implemented locally on 10 October 2026. This is not a production deployment or a
10,000-user capacity certification.

## New behavior

- Starting a test resumes the user's active protocol-1 attempt. Atomic upsert
  plus a partial unique Mongo index prevents concurrent starts creating two
  active attempts. Retakes remain available after completion, matching the
  existing product policy.
- Every new attempt stores its server deadline, constrained by test duration
  and the test closing time. No client-provided timer/marks are trusted.
- A shared immutable ExamPaper snapshot freezes questions, answer keys and
  marks. Students receive a stripped paper; grading and later review use the
  snapshot even after the original questions change.
- Answers autosave after an 800 ms pause and retry periodically with jitter.
  Pending answers are buffered in per-tab sessionStorage scoped by account and
  attempt. Acknowledged answers persist on the server. Closing a tab can still
  lose unacknowledged offline work; the UI warns before unloading dirty work.
- Save status is visible. Saves are serialized within a tab and guarded by a
  server answer version across tabs. Lost acknowledgements are reconciled.
  Conflicting edits require an explicit reload of server answers; the browser
  does not silently overwrite another tab's selections.
- The timer uses the stored deadline and server-time offset. Late completion
  grades only previously saved answers, ignoring the late answer payload.
- A finalizer grades expired saved work without a connected browser. It uses
  bounded batches/time budgets and compare-and-set updates. Finalization may
  lag the deadline under backlog; it never extends the answer-acceptance window.
- New completions persist a retryable completion-effects marker instead of
  waiting for counts, statistics and automatic tutor generation. Reconciliation
  batches shared test counts and updates user summaries. New tutor feedback is
  requested separately through the existing tutor endpoint.
- Completed attempts remain immutable; retrying submission lets the frontend
  retrieve the saved review. Reading an attempt requires ownership.

## Deployment prerequisites

1. Validate in an isolated staging database with realistic data and concurrent
   requests. Unit tests use model stubs; they do not exercise Mongo locking,
   index creation, network behavior or actual throughput.
2. Back up the database. Run `node scripts/prepareExamIndexes.js` against the
   intended environment before rollout. It creates declared indexes only and
   does not delete old attempts or drop indexes. In particular, verify
   `one_active_protocol_attempt` exists and is unique. Startup also waits for
   the model's initialization before admitting new attempts when connected.
3. Deploy backend and frontend together before an exam window, then refresh
   frontend delivery. Old cached frontend code does not send answer versions
   for new protocol-1 attempts and is not compatible with their save protocol.
4. Lambda: set `exam_finalizer_enabled = true` in the extracted AWS Terraform
   root after deploying the handler, then review/apply that infrastructure plan.
   The new EventBridge rule invokes `{ "task": "exam-finalizer" } every minute.
   The schedule defaults off so merely adding Terraform does not activate it
   before the matching application release.
5. Persistent Node servers start a bounded finalizer/reconciler loop once per
   minute. Alternatively, schedule `node scripts/finalizeExpiredAttempts.js`
   in a separate worker. Do not rely on a browser to keep this processing alive.
6. Verify a closed-browser attempt is completed, counters catch up, retries
   preserve scores and rejected late answers never appear in grading. Monitor
   expired in-progress attempts and pending completion effects for backlog.

Legacy attempts are intentionally excluded from the new uniqueness predicate,
snapshot requirement and automatic deadline processing. They retain their old
behavior. Do not retroactively assign deadlines during a running exam; resolve
legacy in-progress attempts before starting a national event on the new release.

## Remaining architecture work

- Precomputed/cached exam rankings and percentiles; the existing stats endpoint
  still computes these on demand.
- Durable backend tutor processing and provider-wide AI concurrency/cost limits;
  the existing tutor endpoint still uses its legacy memory queue.
- Complete API/worker separation for Python legacy processing paths.
- Cross-instance WebSocket delivery and a deployment topology that supports it.
- Database HA, measured sizing, connection bounds and production index lifecycle.
- Reduced notification/heartbeat/video polling, paginated lists and removal of
  class status writes from GET requests.
- CI/CD, operational alarms, rollback, provider quotas and live video integration.
- Staged load/failure tests through 10,000 active students and peak submission
  bursts. Defaults and a passing build are not proof of capacity.

No live database migrations, Terraform apply, Git commits, pushes or AWS changes
were performed by this implementation batch.
