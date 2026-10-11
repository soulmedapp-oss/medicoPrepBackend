# S3, environment configuration and CloudFront: changes and reasons

Date: 6 October 2026

## Purpose

Store backend uploads and AI documents in one bucket per environment, separate
the services with folders, and deliver selected public images through CloudFront
while keeping the S3 bucket private. This document records implemented code,
the AWS setup discussed with the user, and remaining verification separately.

## Current layout

The user confirmed creating the `soulmed-dev-uploads` bucket in Mumbai and the
`soulmed-dev-assets` CloudFront distribution. The distribution ID and domain are
not recorded here. OAC attachment, final policies and live delivery still need
verification; the assistant did not apply AWS changes.

```text
soulmed-dev-uploads/                       S3 bucket
  soulmed-dev-uploads-question/            Backend service prefix
    questions/                            Question images
    thumbnails/                           Lecture, playlist and class thumbnails
    plans/banners/
    profiles/
    doubts/
    recordings/classes/
    videos/uploads/
    transcripts/classes/
  soulmed-dev-ai-ingest/                   AI service prefix
    subjects/                             Source documents, imports and AI images
    _staging/                             Temporary processing/upload objects
    _system/                              Service health probes
```

S3 folders are object-key prefixes, not nested buckets. They appear on upload;
there is no need to create empty folders. Despite its name, `uploads-question`
contains all backend upload categories, not only question images. AI import and
generated question images remain in the AI service prefix.

## What changed and why

| Change | Reason and effect |
| --- | --- |
| APP_ENV identifies dev, uat, production or custom environments | Keeps storage names and log directories consistent across services. |
| Shared S3_BUCKET supports an environment template | Backend and AI can use one existing bucket per environment. The application resolves names but does not provision buckets. |
| Backend and AI prepend their own service prefixes | Separates objects and permits IAM policies restricted to each service's paths. |
| Backend shared prefix renamed from uploads-thumbnails to uploads-question | Implements the user's requested exact name: soulmed-dev-uploads-question. |
| Environment-specific log directories | Makes local/server logs easier to identify by environment and service. |
| AWS IAM and CORS JSON files prepared | Provides repeatable service permissions and browser upload configuration. |
| CloudFront delivery configured through UPLOADS_PUBLIC_BASE_URL | Enables selected assets to load from a private S3 origin through a CDN. |

The bucket setting is configurable. The backend folder pattern is currently
hardcoded in `src/lib/deploymentEnvironment.js`, function `uploadsPrefix()`:

```js
return sharedBucket(env)
  ? `soulmed-${normalizeEnvironment(env.APP_ENV)}-uploads-question`
  : '';
```

Only the environment portion changes automatically. `UPLOADS_S3_PREFIX` is not
implemented. Legacy separate-bucket defaults are unchanged by this rename.

## Application configuration

Backend file: `C:\SoulMedAi\myBranch\backend\medicoPrepBackend\.env`

```dotenv
APP_ENV=dev
S3_BUCKET=soulmed-{env}-uploads
AWS_REGION=ap-south-1
UPLOADS_S3_REGION=ap-south-1
UPLOADS_PUBLIC_BASE_URL=https://YOUR_DISTRIBUTION.cloudfront.net
LOG_DIR=C:/MedicoPreplogs
```

Replace the CloudFront placeholder with the actual domain. Do not append a
folder: the backend appends the complete object key. A literal bucket name is
also supported. Shared S3_BUCKET takes precedence over old service-specific
bucket settings. Keep AWS credentials outside committed files; use runtime IAM
roles on AWS or the existing credential/profile configuration locally.

AI file: `C:\SoulMedAi\myBranch\agents\soulmed-agents\.env`

```dotenv
STORAGE_BACKEND=s3
AWS_REGION=ap-south-1
PUBLIC_BASE_URL=http://localhost:8100
```

In the local sibling-repository layout, AI inherits APP_ENV, S3_BUCKET,
AWS_ACCOUNT_ID and LOG_DIR from backend configuration unless overridden. Own
AI settings or process environment variables take precedence. On separate
deployments, explicitly set matching APP_ENV/S3_BUCKET on backend, AI API and
AI worker. Use the deployed AI URL for PUBLIC_BASE_URL.

| APP_ENV | Bucket using the template above | Backend prefix | AI prefix |
| --- | --- | --- | --- |
| dev | soulmed-dev-uploads | soulmed-dev-uploads-question | soulmed-dev-ai-ingest |
| uat | soulmed-uat-uploads | soulmed-uat-uploads-question | soulmed-uat-ai-ingest |
| production | soulmed-production-uploads | soulmed-production-uploads-question | soulmed-production-ai-ingest |
| dev2 | soulmed-dev2-uploads | soulmed-dev2-uploads-question | soulmed-dev2-ai-ingest |

Aliases: local/development become dev; prod becomes production; spaces are
removed, so dev 2 becomes dev2. Provision each intended bucket and matching IAM,
CORS and CDN configuration before switching. The supplied JSON files contain
explicit dev names and do not substitute templates automatically.

APP_ENV does not switch MongoDB connections, vector databases, credentials or
frontend/API URLs. Set those separately. NODE_ENV is independent.

With LOG_DIR set, logs use `<LOG_DIR>/<env>/backend/` and
`<LOG_DIR>/<env>/ai-service/`. Backend retains its date-at-startup filename;
AI logs use process-specific filenames with daily rotation and 14 backups.
These directories contain enabled log levels, not exclusively errors.

## Why CloudFront and OAC are used

```text
Backend upload -> IAM-authorized S3 write
Browser image request -> CloudFront -> OAC-signed S3 read
AI processing -> IAM-authorized access to AI prefix
```

The backend returns permanent asset URLs. A private S3 object cannot be loaded
through an ordinary unsigned S3 URL. CloudFront provides the delivery domain
and caching; Origin Access Control (OAC) authenticates its origin requests.

OAC does not authenticate students or enforce subscriptions. Public CloudFront
URLs can be used by anyone who has them. Signed viewer URLs/cookies or an
authenticated application route are needed for restricted content.

## AWS setup and remaining steps

1. Keep S3 Block Public Access enabled, Bucket owner enforced (ACLs disabled),
   SSE-S3 default encryption and static website hosting disabled.
2. Attach backend IAM policy as `SoulMedDevBackendS3Access` and AI IAM policy as
   `SoulMedDevAiS3Access` to their respective identities. If they share one
   identity, attach both. Existing Bedrock/Textract permissions remain separate.
3. Paste the console CORS file in S3 Permissions > CORS. Add actual frontend
   origins when deploying. CORS allows browser requests; it is not authorization.
4. The user created distribution `soulmed-dev-assets`. The reviewed wizard used
   the correct S3 origin, an empty origin path, automatic origin access disabled,
   default S3 cache settings, Origin Shield off, and WAF protections enabled
   with monitor mode off. Automatic bucket-wide permission was deliberately
   avoided so a restricted policy could be applied manually.
5. Open CloudFront > distribution > Origins > S3 origin > Edit. Select Origin
   access control settings; create/select `soulmed-dev-uploads-oac`, type S3,
   always sign requests. Keep origin path empty and save.
6. Apply the CloudFront S3 bucket-policy statement with the actual account and
   distribution IDs. Preserve unrelated required statements, but remove/narrow
   any broader CloudFront Allow that defeats the intended path restrictions.
7. The prepared policy initially allowed only thumbnails and plan banners.
   Confirm the current edited policy before applying. Question images can be
   added only if URL-accessible delivery is intended. Do not grant public CDN
   access to all uploads or the AI prefix.
8. Verify the relevant cache behavior uses this origin, GET/HEAD and HTTPS
   redirection. Set UPLOADS_PUBLIC_BASE_URL to the distribution domain and
   restart the backend yourself after deployment/configuration is ready.

The creation screen showed a Free CloudFront plan. This is not a guarantee that
all AWS services, storage or requests are free; check account billing separately.

## Configuration files and code locations

The committed files are under
`C:\SoulMedAi\myBranch\backend\medicoPrepBackend`:

| File | Purpose |
| --- | --- |
| src/lib/deploymentEnvironment.js | Environment normalization, bucket resolution, backend prefix and log path. |
| src/lib/uploadStorage.js | Prefix-aware upload keys, URLs and readback validation. |
| test/deploymentEnvironment.test.js | Environment and shared-prefix verification. |
| .env.example | Documents the new shared-prefix pattern. |
| docs/Environment-Storage-and-Logs.md | General storage and logging reference. |
| docs/aws/dev-storage/README.md | Detailed manual AWS setup instructions. |
| docs/aws/dev-storage/backend-iam-policy.json | Backend service S3 permissions; paste in IAM. |
| docs/aws/dev-storage/ai-iam-policy.json | AI service S3 permissions; paste in IAM. |
| docs/aws/dev-storage/cors-console.json | Paste in the S3 CORS editor. |
| docs/aws/dev-storage/cors-cli.json | Equivalent wrapper for AWS CLI. |
| docs/aws/dev-storage/cloudfront-bucket-policy.json | Distribution-specific S3 read permission; paste/merge in bucket policy. |

For CORS via CLI, from the configuration directory:

```powershell
aws s3api put-bucket-cors --bucket soulmed-dev-uploads --region ap-south-1 --cors-configuration file://cors-cli.json
```

This replaces bucket CORS; merge needed existing origins first. It was not run
by the assistant. No additional bucket is needed for dev.

## Verification and limitations

- The prefix rename and AWS setup artifacts were committed as `d2a81dd`; nothing
  was pushed. The two relevant Node test files passed all 13 tests.
- User confirmed bucket and distribution creation. This does not establish that
  OAC, IAM, CORS, bucket policy or live image delivery are correctly configured.
- Test a new backend thumbnail: its key must start with
  `soulmed-dev-uploads-question/` and its CloudFront URL must load.
- Test an AI document import and service storage health check. Its objects must
  use `soulmed-dev-ai-ingest/`.
- An unsigned direct S3 source-document URL should be denied. Test full object
  URLs: denial at the bare CloudFront domain is normal without a root object.
- Existing objects and stored URLs are not migrated. Changing the prefix may
  prevent backend readback of old-prefix URLs, even if old delivery permissions
  still allow them to display. Plan migration before changing a populated setup.
- The previously identified public AI media endpoint and other authorization
  audit findings are separate open issues; these storage changes do not fix them.
- No backend was started by the assistant. No AWS resources were modified by
  the assistant during the prefix rename/documentation work.

## References

- AWS S3 CORS: https://docs.aws.amazon.com/AmazonS3/latest/userguide/ManageCorsUsing.html
- AWS CloudFront OAC: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html
- AWS distribution setup: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/GettingStarted.SimpleDistribution.html

This Markdown document is maintained in backend/docs for Git history and copied
to the requested shared `C:\SoulMedAi\myBranch\docs` directory.
