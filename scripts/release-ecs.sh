#!/usr/bin/env bash
set -euo pipefail
if [[ "${DEPLOY_ENVIRONMENT:-}" == prod || "${ECS_CLUSTER:-}" == soulmed-prod-backend ]]; then
  echo 'Production deployments use the reviewed infrastructure release workflow.' >&2
  exit 1
fi
: "${ECS_CLUSTER:?}" "${ECS_SERVICES:?}" "${CONTAINER_NAME:?}" "${RELEASE_IMAGE:?}"
[[ "$RELEASE_IMAGE" =~ @sha256:[a-f0-9]{64}$ ]] || { echo 'An immutable image digest is required'; exit 1; }
read -r -a services <<< "$ECS_SERVICES"
read -r -a containers <<< "${CONTAINER_NAMES:-}"
declare -A old_tasks new_tasks
rollback() {
  for service in "${services[@]}"; do
    if [[ -n "${old_tasks[$service]:-}" ]]; then
      aws ecs update-service --cluster "$ECS_CLUSTER" --service "$service" --task-definition "${old_tasks[$service]}" >/dev/null || true
    fi
  done
}
trap 'rollback' ERR
for index in "${!services[@]}"; do
  service="${services[$index]}"
  container="${containers[$index]:-$CONTAINER_NAME}"
  [[ -n "$service" ]] || continue
  old=$(aws ecs describe-services --cluster "$ECS_CLUSTER" --services "$service" --query 'services[0].taskDefinition' --output text)
  [[ "$old" == arn:* ]] || { echo "Missing service: $service"; false; }
  old_tasks[$service]="$old"
  aws ecs describe-task-definition --task-definition "$old" --query taskDefinition > task.json
  jq --arg image "$RELEASE_IMAGE" --arg container "$container" '
    if ([.containerDefinitions[] | select(.name == $container)] | length) != 1 then error("container not found") else . end |
    .containerDefinitions |= map(if .name == $container then .image = $image else . end) |
    del(.taskDefinitionArn,.revision,.status,.requiresAttributes,.compatibilities,.registeredAt,.registeredBy,.deregisteredAt)
  ' task.json > release-task.json
  new=$(aws ecs register-task-definition --cli-input-json file://release-task.json --query taskDefinition.taskDefinitionArn --output text)
  new_tasks[$service]="$new"
  aws ecs update-service --cluster "$ECS_CLUSTER" --service "$service" --task-definition "$new" >/dev/null
  aws ecs wait services-stable --cluster "$ECS_CLUSTER" --services "$service"
  # A circuit-breaker rollback may also appear stable. Verify the actual revision.
  actual=$(aws ecs describe-services --cluster "$ECS_CLUSTER" --services "$service" --query 'services[0].taskDefinition' --output text)
  [[ "$actual" == "$new" ]] || { echo "Deployment rolled back: $service"; false; }
done
if [[ -n "${HEALTH_URL:-}" ]]; then curl --fail --retry 3 --retry-delay 5 --max-time 15 "$HEALTH_URL" >/dev/null; fi
trap - ERR
echo "Released $RELEASE_IMAGE"
for service in "${services[@]}"; do echo "Previous $service task: ${old_tasks[$service]}"; done
