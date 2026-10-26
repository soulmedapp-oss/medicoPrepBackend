# AI job dispatcher (cost candidate)

`npm run worker:ai-dispatcher` runs the durable dispatcher on the backend EC2 host.
It requires AI_DISPATCH_ENABLED=true, AI_DB_NAME, MONGODB_URI and
AI_WORKER_STATE_MACHINE_ARN. Use the same existing AI database as the agents API,
not the application database. AWS credentials come from the ECS task role; no
static access keys are accepted or needed. `--once` performs one scan.

The dispatcher scans jobs and question_bank_imports, repairs the pending/outbox
gap, and starts at most one live Step Functions execution globally. It records
execution names before AWS calls, so uncertain start responses can be retried
idempotently. Database processing leases still govern each job. A leadership
lease fences dispatcher starts; AWS calls have bounded timeouts. This does not
promise exactly-once model invocation after a worker crash.

The new role needs only StartExecution on the candidate state machine and
DescribeExecution on its execution ARN pattern. Reproduce the baseline with:

```sh
uvx iam-policy-autopilot@latest generate-policies src/services/aiJobDispatcher.js scripts/aiDispatcher.js --region ap-south-1 --account 986518320302 --service-hints sfn --pretty
```

Review and restrict the generated resource wildcards before attachment. Do not
add these permissions to the teammate's roles. The candidate Terraform creates
an independent dispatcher task role and a dedicated secret-reading execution
role. The current backend services do not start this script automatically.

Build the merged image through Release with prod + build_only=true, smoke-test
it, drain old consumers, and then enable the single candidate dispatcher. For
rollback stop the dispatcher first, allow in-flight finite tasks to finish or
stop them deliberately, and restore the previous consumer definition. Keep the
existing maintenance and tutor workers separate; they still run continuously on
the small EC2 backend host. This migration does not remove WebSockets.
