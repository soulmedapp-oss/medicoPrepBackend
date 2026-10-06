# Environment-specific S3 buckets and logs

Set `APP_ENV` in the backend `.env` or deployment environment. The AI service inherits it from the backend `.env` when that file is available; on separately deployed services set the same value explicitly in both. Shell values override files. Restart the backend, AI API and AI worker after changing configuration.

| APP_ENV | AI bucket default | Upload bucket default |
| --- | --- | --- |
| local / development / dev | soulmed-dev-ai-ingest | soulmed-dev-uploads-thumbnails |
| uat | soulmed-uat-ai-ingest | soulmed-uat-uploads-thumbnails |
| prod / production | soulmed-production-ai-ingest | soulmed-production-uploads-thumbnails |
| dev 2 / dev2 | soulmed-dev2-ai-ingest | soulmed-dev2-uploads-thumbnails |

Names are lowercased, whitespace removed, and restricted to 1–30 ASCII letters/digits/hyphens with no leading/trailing hyphen. Paths and punctuation are rejected. This setting is separate from `NODE_ENV`; UAT should still use `NODE_ENV=production` for production runtime behavior.

## Configuration

Backend:

```dotenv
APP_ENV=dev2
UPLOADS_S3_BUCKET=soulmed-{env}-uploads-thumbnails-ACCOUNT_ID
LOG_DIR=C:/MedicoPreplogs
```

AI service (APP_ENV and LOG_DIR may be inherited from the backend file):

```dotenv
APP_ENV=dev2
AI_INGEST_S3_BUCKET=soulmed-{env}-ai-ingest-ACCOUNT_ID
STORAGE_BACKEND=s3
LOG_DIR=C:/MedicoPreplogs
```

Replace ACCOUNT_ID with your own lower-case unique suffix. S3 bucket names must be available; these examples do not create buckets. Leave the bucket variables blank to use the defaults in the table. **An explicit existing bucket name wins over APP_ENV.** For automatic switching, remove a fixed override or use `{env}` in it. Setting APP_ENV while leaving the bucket blank enables the derived S3 destination. AI `STORAGE_BACKEND=local` still explicitly selects disk.

With APP_ENV absent, existing explicit buckets and backend local-disk fallback remain unchanged. No `.env` secrets or active deployment values were changed by this implementation.

## Object and log locations

Buckets are separate by environment; existing object keys are unchanged. For example:

```text
s3://soulmed-dev2-ai-ingest/subjects/<subject>__<id>/imports/<import-id>/questions/<question-id>/option-B-<random>.png
s3://soulmed-dev2-ai-ingest/subjects/<subject>__<id>/generated/<batch-id>/questions/<question-id>/explanation-<random>.png
s3://soulmed-dev2-uploads-thumbnails/questions/<year>/<month>/<filename>
```

AI V2 uploads (stem, options and explanations), extraction assets, source documents, staging files and storage checks all use the resolved AI bucket through the existing storage layer. Regular backend uploads and the explicitly invoked upload-migration script use the resolved uploads bucket. No migration script runs automatically.

File logging is enabled only when LOG_DIR is set:

```text
C:/MedicoPreplogs/dev2/backend/server_YYYYMMDD.log
C:/MedicoPreplogs/dev2/ai-service/ai-service-<pid>.log
```

The backend filename prefix uses existing LOG_FILE_PREFIX (default SOULMED_LOG), and its existing date-at-startup behavior is retained. AI files rotate at UTC midnight with 14 backups per process; separate process IDs avoid API/worker rotation collisions. Clean up old process-ID log files with host retention tooling after restarts. Both services continue logging to stdout. AI stdlib messages also reach the file; application structlog events carry environment/service fields. These files include events at the configured LOG_LEVEL, not exclusively errors. File logging is skipped on Lambda. Use an absolute LOG_DIR to make API/worker paths consistent. Without APP_ENV the backend retains its old log directory; newly enabled AI file logging uses LOG_DIR/default/ai-service.

## Activation checklist

1. Provision each environment's two buckets, encryption, lifecycle rules, upload CORS and any CDN delivery configuration.
2. Give each environment's runtime credentials access only to its buckets. A naming convention alone does not enforce isolation.
3. Configure environment-specific Mongo databases and other services separately; APP_ENV does not switch databases or vector indexes.
4. Verify explicit bucket overrides, UPLOADS_PUBLIC_BASE_URL/CDN origin and AI PUBLIC_BASE_URL belong to the selected environment.
5. Restart all services and workers. Run the AI storage health check and upload a disposable test image; verify bucket and log locations.

Existing objects are not moved and bucket creation/IAM changes are not performed by this code. Changing the AI bucket with the same database can make existing key-only media/source references unreadable; migration must copy objects and verify references deliberately before switching. Backend absolute image URLs continue pointing to their old bucket as long as that bucket remains accessible. There is no automatic fallback to another environment's bucket.

No AWS verification or deployment was performed. Public-media authorization findings in the security audit remain separate open work; separating buckets does not resolve them.
