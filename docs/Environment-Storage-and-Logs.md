# Environment storage and logs

## Current layout: one bucket per environment

This replaces the earlier recommendation of two buckets per environment.

```text
soulmed-dev-123456789012/                 S3 bucket
  soulmed-dev-ai-ingest/                 AI service folder
    subjects/<subject>__<id>/
      documents/<document-id>/source.pdf
      imports/<import-id>/source.docx
      imports/<import-id>/questions/<question-id>/option-B-<random>.png
      generated/<batch-id>/questions/<question-id>/explanation-<random>.png
    _staging/...
    _system/...
  soulmed-dev-uploads-question/        Backend uploads folder
    questions/<year>/<month>/...
    thumbnails/lectures/<year>/<month>/...
    profiles/...
```

With APP_ENV=uat, both the bucket and the two folder names use `uat`. With APP_ENV=dev2 they use `dev2`. The folders appear when objects are first uploaded; empty folder marker objects are unnecessary.

## Configuration

Set these values in the backend `.env`, replacing the example account ID:

```dotenv
APP_ENV=dev
AWS_ACCOUNT_ID=123456789012
S3_BUCKET=soulmed-{env}-{account_id}
LOG_DIR=C:/MedicoPreplogs
```

The AI service inherits these four values from the backend `.env` when available. Its own `.env` or shell variables override inherited values. On separately deployed backend, AI API and AI worker services, set the same values on every deployment. Set `STORAGE_BACKEND=s3` for deployed AI storage. Restart all relevant processes after configuration changes; the backend was not started by this change.

Aliases: local/development -> dev; prod -> production; dev 2 -> dev2. Names are lowercased, whitespace removed and restricted to 1-30 letters/digits/hyphens, with no leading/trailing hyphen. APP_ENV is separate from NODE_ENV; a UAT server should still use NODE_ENV=production.

S3_BUCKET accepts `{env}` and `{account_id}` placeholders, or a literal existing bucket name. If AWS_ACCOUNT_ID is set and S3_BUCKET is blank, the default is `soulmed-{env}-{account_id}`. AWS_ACCOUNT_ID must be 12 digits. A shared bucket requires APP_ENV.

**Shared mode takes precedence over old UPLOADS_S3_BUCKET and AI_INGEST_S3_BUCKET settings.** Without S3_BUCKET and AWS_ACCOUNT_ID, the previous explicit/separate-bucket behavior is retained for compatibility. Blank APP_ENV plus no shared settings preserves existing configuration. AI STORAGE_BACKEND=local still selects disk.

## Coverage and compatibility

AI storage prefixes physical S3 keys for source documents, question/option/explanation images, extracted assets, signed PUT/POST uploads, import snapshots, OCR input/output/cache, list/download/copy/delete operations and health probes. Database keys and API media URLs remain logical relative keys. Listing strips the physical prefix before returning keys to callers, so subsequent deletion does not double-prefix them. Admin S3 folder links display the physical path.

Backend uploads include the service folder in the returned image URL. Image readback validates the same folder, and the explicitly invoked local-upload migration script uses the shared layout too. CDN base URLs should point to the bucket root; the code appends the service folder once. Existing backend absolute URLs are not rewritten.

Changing a populated AI deployment from legacy buckets to the shared bucket requires copying its existing objects under the new AI prefix before switching. This code does not migrate objects or fall back to another bucket. No buckets, policies or active `.env` values were changed as part of implementation.

## AWS setup before activation

1. Create the intended regional bucket. Verify the account ID and name are correct.
2. Grant each service only its required prefix: backend uploads folder versus AI folder. Include listing/presigning/copy/delete permissions appropriate to the feature. Scope environment credentials to their own bucket.
3. Configure browser-upload CORS for the exact application origins, encryption and lifecycle rules. Staging lifecycle rules now target `soulmed-<env>-ai-ingest/_staging/`, not root `_staging/`.
4. Keep the AI source prefix private. Do not apply a bucket-wide public-read policy because uploads and private AI sources now share a bucket. If backend images require public delivery, scope that policy/CDN behavior to the uploads prefix only.
5. Set environment-specific Mongo database URLs, vector configuration and public API/CDN URLs separately; APP_ENV does not switch these.
6. Restart backend, AI API and worker; test an upload, readback and deletion in each service, and verify the actual bucket/folder.

No AWS deployment or live shared-bucket verification was performed. Existing public AI image authorization findings remain separate open work.

## Log folders

File logging remains enabled only when LOG_DIR is set:

```text
<LOG_DIR>/dev/backend/server_YYYYMMDD.log
<LOG_DIR>/dev/ai-service/ai-service-<pid>.log
```

The backend uses LOG_FILE_PREFIX (default SOULMED_LOG) and retains its date-at-startup behavior. AI files rotate at UTC midnight, keeping 14 backups per process. Separate process IDs avoid API/worker rotation collisions; host retention tooling should remove old process-ID files after restarts. Both services continue logging to stdout. File logging is skipped on Lambda. Use an absolute LOG_DIR for consistent API/worker paths. These logs include the configured severity and above, not exclusively errors.

Manual setup for the existing `soulmed-dev-uploads` bucket: [AWS configuration files](aws/dev-storage/README.md). The shared backend prefix is now `soulmed-<env>-uploads-question`; existing objects are not moved.
