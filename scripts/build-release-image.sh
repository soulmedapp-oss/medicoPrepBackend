#!/usr/bin/env bash
set -Eeuo pipefail
: "${REGISTRY:?}" "${ECR_REPOSITORY:?}" "${GITHUB_SHA:?}" "${GITHUB_ENV:?}"
[[ "$GITHUB_SHA" =~ ^[a-f0-9]{40}$ ]] || { echo 'Expected a full source commit SHA'; exit 1; }
private_dir=$(mktemp -d)
trap 'rm -rf -- "$private_dir"' EXIT
if digest=$(aws ecr describe-images --repository-name "$ECR_REPOSITORY" --image-ids "imageTag=$GITHUB_SHA" --query 'imageDetails[0].imageDigest' --output text 2>"$private_dir/error"); then
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'ECR returned an invalid digest'; exit 1; }
else
  if ! grep -q 'ImageNotFoundException' "$private_dir/error"; then
    echo 'ECR lookup failed. Check repository, permissions and region.'; exit 1
  fi
  image="$REGISTRY/$ECR_REPOSITORY:$GITHUB_SHA"
  docker build -t "$image" .
  docker push "$image"
  digest=$(aws ecr describe-images --repository-name "$ECR_REPOSITORY" --image-ids "imageTag=$GITHUB_SHA" --query 'imageDetails[0].imageDigest' --output text)
fi
[[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Invalid pushed image digest'; exit 1; }
if [[ "${DEPLOY_ENVIRONMENT:-}" == prod ]]; then
  verified_image="$REGISTRY/$ECR_REPOSITORY@$digest"
  docker run --rm --network none --entrypoint node "$verified_image" -e 'const fs=require("node:fs"); for(const p of ["src/server.js","scripts/aiDispatcher.js","src/services/aiJobDispatcher.js","scripts/maintenanceWorker.js","scripts/tutorWorker.js"]) fs.accessSync(p); require.resolve("@aws-sdk/client-sfn"); console.log("Production API and consumer files verified; no database or model calls");'
fi
printf 'RELEASE_IMAGE=%s/%s@%s\n' "$REGISTRY" "$ECR_REPOSITORY" "$digest" >> "$GITHUB_ENV"
printf 'Backend image: `%s/%s@%s`\n' "$REGISTRY" "$ECR_REPOSITORY" "$digest" >> "$GITHUB_STEP_SUMMARY"
