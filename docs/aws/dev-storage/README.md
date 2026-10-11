# Existing dev bucket setup

Bucket: `soulmed-dev-uploads` (already created). Region: `ap-south-1`.
No additional bucket or manual folder creation is required.

```text
soulmed-dev-uploads/
  soulmed-dev-uploads-question/    Backend uploads (all categories)
    questions/
    thumbnails/
    profiles/
    doubts/
    plans/
    recordings/
    videos/
    transcripts/
  soulmed-dev-ai-ingest/          AI documents, imports and extracted images
```

## 1. Application settings

Backend `.env` already has these values; retain them:

```dotenv
APP_ENV=dev
S3_BUCKET=soulmed-{env}-uploads
```

Also configure `AWS_REGION=ap-south-1` and `UPLOADS_S3_REGION=ap-south-1`.
AI needs `STORAGE_BACKEND=s3` and `AWS_REGION=ap-south-1`. Locally it inherits
APP_ENV/S3_BUCKET from the backend unless overridden. Separately deployed AI API
and worker processes need the same explicit values and appropriate AWS roles.
Changing APP_ENV requires provisioning that environment's bucket and policies.

## 2. S3 settings

In S3 > soulmed-dev-uploads, retain Block Public Access (all four settings),
Bucket owner enforced / ACLs disabled, and SSE-S3 default encryption.

In Permissions > CORS, paste `cors-console.json`. Add the actual deployed frontend
origin before deploying. CORS permits browser requests; it does not grant object
access. Never put AWS credentials into frontend settings.

Alternatively, from this directory, with AWS CLI authenticated as an operator
allowed to configure this bucket:

```powershell
aws s3api put-bucket-cors --bucket soulmed-dev-uploads --region ap-south-1 --cors-configuration file://cors-cli.json
```

This command replaces existing CORS; merge required existing origins first.
Use `--profile YOUR_PROFILE` when needed. No commands have been executed on AWS.

## 3. Runtime IAM policies

These files go into IAM, not the S3 bucket-policy editor:

- `backend-iam-policy.json`: attach to the backend's IAM user or runtime role.
- `ai-iam-policy.json`: attach to the AI API/worker's IAM user or runtime role.

In IAM > Policies > Create policy > JSON, paste each file, save, then attach it
to the appropriate identity. If both services share an identity, attach both.
Existing Bedrock/Textract permissions remain separate. These policies do not
grant bucket administration or permission to other environments.

## 4. CloudFront image delivery

The backend returns permanent asset URLs. Keep the bucket private and use a
CloudFront S3 origin with Origin Access Control, always sign requests, an empty
origin path, GET/HEAD methods and redirect HTTP to HTTPS.

Replace ACCOUNT_ID and DISTRIBUTION_ID in `cloudfront-bucket-policy.json`.
Merge its statement into S3 > Permissions > Bucket policy, preserving unrelated
required statements. Do not also retain a generated bucket-wide CloudFront Allow.
The supplied policy exposes only thumbnails and plan banners through CloudFront.

Set backend `UPLOADS_PUBLIC_BASE_URL=https://YOUR_DISTRIBUTION.cloudfront.net`
(domain only; the application adds the folder).

If backend question images are intended to be accessible to anyone with their
URL, add this Resource to the CloudFront policy:

```text
arn:aws:s3:::soulmed-dev-uploads/soulmed-dev-uploads-question/questions/*
```

For login/subscription-restricted images, signed URLs or authenticated application
delivery must be implemented instead. OAC authenticates CloudFront to S3, not
viewers to CloudFront. Do not expose AI sources, doubts, profiles or recordings
by granting CloudFront the entire bucket/prefix. The earlier AI media API
authorization finding remains separate and is not fixed by these policies.

## 5. Activate and verify

Restart the backend yourself after policy/config updates. Restart AI API/worker
only if their settings changed. Upload a backend image and check the new
`soulmed-dev-uploads-question/` prefix. Import a document and check
`soulmed-dev-ai-ingest/`. Verify configured public asset delivery and that unsigned
S3 source-document access is denied.

Existing objects/URLs are not migrated. Old prefix URLs may still display with
their old delivery permissions, but backend readback validates the new prefix.
If old uploads exist, plan migration of objects and stored URLs before switching.
Legacy separate-bucket defaults are unchanged; this rename applies to shared
S3_BUCKET mode. No service was started and no cloud resources were modified.

References: [S3 CORS](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ManageCorsUsing.html),
[CloudFront OAC](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html).
