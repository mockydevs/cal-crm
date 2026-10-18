#!/usr/bin/env bash
# Builds a throwaway Postgres 18 (with pgvector) in Docker, runs the install bootstrap
# and every migration in order, then runs the SQL test suite. Any failure stops the run
# with a non-zero exit code. Set KEEP=1 to leave the container running for inspection.
set -euo pipefail
shopt -s nullglob

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
container="${CRM_DB_CONTAINER:-crm-db-validate}"
image="${CRM_DB_IMAGE:-pgvector/pgvector:pg18}"

cleanup() {
  if [[ "${KEEP:-0}" != "1" ]]; then
    docker rm -f "$container" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

docker rm -f "$container" >/dev/null 2>&1 || true
docker run -d --name "$container" -p 127.0.0.1::5432 -e POSTGRES_PASSWORD=validate-only "$image" >/dev/null

# The image runs a socket-only server while it initialises, then restarts; waiting on
# TCP skips that window.
for _ in $(seq 1 60); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres -q 2>/dev/null; then break; fi
  sleep 1
done

run_sql() {
  local user="$1" database="$2" file="$3"
  shift 3
  docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U "$user" -d "$database" "$@" < "$file"
}

echo "bootstrap: 0001_roles_and_database.sql"
run_sql postgres postgres "$root/bootstrap/0001_roles_and_database.sql" \
  -v owner_password=validate-only -v app_password=validate-only -v auth_password=validate-only \
  -v worker_password=validate-only

for migration in "$root"/migrations/*.sql; do
  echo "migrate:   $(basename "$migration")"
  run_sql crm_owner crm "$migration"
done

# The production installer runs Graphile Worker's migrations after ours. Event triggers
# enqueue through its real schema; SQL validation must use the same queue, not a stub.
task_worker_address="$(docker port "$container" 5432/tcp)"
task_worker_port="${task_worker_address##*:}"
echo "migrate:   Graphile Worker"
(
  cd "$root"
  pnpm exec graphile-worker --connection "postgres://crm_owner:validate-only@127.0.0.1:$task_worker_port/crm" --schema-only
)

for test in "$root"/tests/*.sql; do
  echo "test:      $(basename "$test")"
  run_sql postgres crm "$test"
done

echo "database validation passed"
