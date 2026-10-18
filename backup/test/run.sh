#!/usr/bin/env bash
# The backups, end to end, on this machine's Docker:
#
#   bash backup/test/run.sh
#
# It starts a Postgres 18 with the install's bootstrap, every migration and a few rows, a
# second Postgres as a new install's empty database, and MinIO as the S3 storage. Then it
# takes a backup, checks the stored dump against its checksum, restores it and compares
# the two databases, and checks retention, failures, the schedule, the health check and
# encryption. Any failure stops the run with a non-zero exit code.
#
# BACKUP_IMAGE  the image to test; without it, the script builds backup/ as crm-backup:test.
# KEEP=1        leaves the containers running for inspection.
set -euo pipefail
shopt -s nullglob
# Git Bash on Windows rewrites arguments that start with a slash; Docker needs them as they are.
export MSYS_NO_PATHCONV=1

# pwd -W: on Git Bash, the path as Windows and Docker write it.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && { pwd -W 2>/dev/null || pwd; })"
db="$root/packages/db"
image="${BACKUP_IMAGE:-}"
postgres_image="${BACKUP_TEST_POSTGRES_IMAGE:-pgvector/pgvector:pg18@sha256:2358fcba361ed2233a5ed81b5fe4ca779ccb304120ce531a3bf51c0ed7e2bc11}"
# MinIO as Chainguard builds it: MinIO's own images left Docker Hub and Quay.
minio_image="${MINIO_IMAGE:-cgr.dev/chainguard/minio@sha256:dc455cdd4db6e390b1b26514f15ff37681a777bf8dab41aac445a0259f751e56}"

network=crm-backup-test
source_db=crm-backup-test-source
target_db=crm-backup-test-target
storage=crm-backup-test-minio
scheduler=crm-backup-test-scheduler
keys=crm-backup-test-keys

# Test-only values, long enough that finding one in a log means it leaked.
owner_password=owner-password-6f1d2c9a7b3e
super_password=super-password-0a9b8c7d6e5f
access_key=backuptestkey4c1e9d
secret_key=backup-test-secret-5e8a1f3b7c2d9e4f
wrong_secret=not-the-right-one
bucket=crm-backups-test

passed=0
ok() {
  passed=$((passed + 1))
  echo "ok $passed - $1"
}
die() {
  echo "NOT OK - $1" >&2
  exit 1
}

cleanup() {
  if [[ "${KEEP:-0}" != "1" ]]; then
    docker rm -f "$source_db" "$target_db" "$storage" "$scheduler" >/dev/null 2>&1 || true
    docker volume rm "$keys" >/dev/null 2>&1 || true
    docker network rm "$network" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ -z "$image" ]]; then
  image=crm-backup:test
  docker build --quiet --tag "$image" "$root/backup" >/dev/null
fi

docker rm -f "$source_db" "$target_db" "$storage" "$scheduler" >/dev/null 2>&1 || true
docker volume rm "$keys" >/dev/null 2>&1 || true
docker network rm "$network" >/dev/null 2>&1 || true
docker network create "$network" >/dev/null

# --- The two databases and the storage --------------------------------------------------

docker run -d --name "$source_db" --network "$network" -p 127.0.0.1::5432 \
  -e POSTGRES_PASSWORD="$super_password" "$postgres_image" >/dev/null
docker run -d --name "$target_db" --network "$network" \
  -e POSTGRES_PASSWORD="$super_password" "$postgres_image" >/dev/null
docker run -d --name "$storage" --network "$network" \
  -e MINIO_ROOT_USER="$access_key" -e MINIO_ROOT_PASSWORD="$secret_key" \
  "$minio_image" server /tmp/data >/dev/null

wait_for_postgres() {
  for _ in $(seq 1 90); do
    if docker exec "$1" pg_isready -h 127.0.0.1 -U postgres -q 2>/dev/null; then return 0; fi
    sleep 1
  done
  die "$1 did not start"
}
wait_for_postgres "$source_db"
wait_for_postgres "$target_db"

sql_file() {
  local container="$1" user="$2" database="$3" file="$4"
  shift 4
  docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U "$user" -d "$database" "$@" <"$file"
}
sql() {
  local container="$1" database="$2"
  shift 2
  docker exec "$container" psql -X -q -At -v ON_ERROR_STOP=1 -U postgres -d "$database" "$@"
}
# What the install's first start does: the roles, the database and its extensions.
bootstrap() {
  sql_file "$1" postgres postgres "$db/bootstrap/0001_roles_and_database.sql" \
    -v owner_password="$owner_password" -v app_password=app-only -v auth_password=auth-only \
    -v worker_password=worker-only
}
bootstrap "$source_db"
bootstrap "$target_db"

# The source is a migrated install with Graphile Worker's schema, as migrate leaves it.
for migration in "$db"/migrations/*.sql; do
  sql_file "$source_db" crm_owner crm "$migration"
done
source_address="$(docker port "$source_db" 5432/tcp)"
(
  cd "$db"
  pnpm exec graphile-worker --schema-only \
    --connection "postgres://crm_owner:$owner_password@127.0.0.1:${source_address##*:}/crm" >/dev/null
)
sql "$source_db" crm -c "
  insert into tenancy.agencies (id, name, slug) values
    ('018f0000-0000-7000-8000-0000000000a1', 'Bluebird Digital', 'bluebird'),
    ('018f0000-0000-7000-8000-0000000000a2', 'Another Agency', 'another');
  insert into tenancy.businesses (agency_id, name, slug, currency) values
    ('018f0000-0000-7000-8000-0000000000a1', 'Harbor Lights Events', 'harbor-lights', 'USD'),
    ('018f0000-0000-7000-8000-0000000000a1', 'Second Business', 'second', 'USD'),
    ('018f0000-0000-7000-8000-0000000000a2', 'Third Business', 'third', 'KES');"
ok "a migrated database with rows: $(sql "$source_db" crm -c "select count(*) from pg_tables where schemaname not in ('pg_catalog', 'information_schema')") tables"

# --- Helpers ----------------------------------------------------------------------------

settings=(
  -e PGHOST="$source_db" -e PGPORT=5432 -e PGUSER=crm_owner -e PGPASSWORD="$owner_password"
  -e PGDATABASE=crm
  -e BACKUP_S3_ENDPOINT="http://$storage:9000" -e BACKUP_S3_REGION=us-east-1
  -e BACKUP_S3_BUCKET="$bucket" -e BACKUP_S3_ACCESS_KEY_ID="$access_key"
  -e BACKUP_S3_SECRET_ACCESS_KEY="$secret_key" -e BACKUP_S3_PREFIX=database
  -e BACKUP_INSTALL_NAME=crm.example.com -e BACKUP_RETENTION_DAYS=7
)
# crm-backup, with the settings above and any others given before "--".
backup() {
  local extra=()
  while [[ $# -gt 0 && "$1" != "--" ]]; do
    extra+=("$1")
    shift
  done
  shift
  docker run --rm --network "$network" "${settings[@]}" "${extra[@]}" "$image" "$@"
}
# A shell in the image, for rclone and the image's own date.
tool() {
  docker run --rm -i --network "$network" --entrypoint sh \
    -e RCLONE_CONFIG=/dev/null -e RCLONE_CONFIG_T_TYPE=s3 -e RCLONE_CONFIG_T_PROVIDER=Other \
    -e RCLONE_CONFIG_T_ENDPOINT="http://$storage:9000" -e RCLONE_CONFIG_T_REGION=us-east-1 \
    -e RCLONE_CONFIG_T_ACCESS_KEY_ID="$access_key" \
    -e RCLONE_CONFIG_T_SECRET_ACCESS_KEY="$secret_key" "$image" -c "$1"
}
objects() {
  tool "rclone lsf --recursive --files-only t:$bucket/${1:-}" | sort
}
# Whether captured output holds any secret the containers were given.
leaks() {
  grep -qF -e "$owner_password" -e "$super_password" -e "$secret_key" -e "$access_key" \
    -e "$wrong_secret" <<<"$1"
}
# Every table's row count, and the schema as pg_dump writes it. Left out: its \restrict
# lines, which carry a random key, and every bracket, because a check written with BETWEEN
# comes back from a restore as ((a AND b) AND c) flattened to (a AND b AND c): the same rule.
row_counts() {
  sql "$1" "$2" -c "
    select table_schema || '.' || table_name || ' ' ||
      (xpath('/row/n/text()', query_to_xml(
        format('select count(*) as n from %I.%I', table_schema, table_name), false, true, '')))[1]::text
    from information_schema.tables
    where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema')
    order by 1"
}
schema_fingerprint() {
  docker exec "$1" sh -c "pg_dump -U postgres --schema-only '$2' | grep -Ev '^.(un)?restrict ' | tr -d '()' | sha256sum"
}

for _ in $(seq 1 60); do
  if tool "rclone mkdir t:$bucket" 2>/dev/null; then break; fi
  sleep 1
done
tool "rclone lsf t:" | grep -q "^$bucket/$" || die "the test bucket was not made"

# --- 1. A backup, on demand ---------------------------------------------------------------

output="$(backup -- now 2>&1)" || die "backup now failed: $output"
echo "$output"
grep -q 'backup succeeded' <<<"$output" || die "backup now did not say it succeeded"
if leaks "$output"; then die "backup now printed a secret"; fi
ok "backup now succeeds and prints no secret"

mapfile -t stored < <(objects)
[[ ${#stored[@]} -eq 2 ]] || die "expected a dump and its checksum, found: ${stored[*]}"
dump="${stored[0]}"
[[ "$dump" =~ ^database/crm\.example\.com/[0-9]{4}/[0-9]{2}/[0-9]{2}/crm-[0-9]{8}T[0-9]{6}Z\.dump$ ]] ||
  die "the dump is not where it should be: $dump"
[[ "${stored[1]}" == "$dump.sha256" ]] || die "the checksum is not beside the dump: ${stored[1]}"
ok "the dump and its checksum are at $dump"

recorded="$(tool "rclone cat t:$bucket/$dump.sha256" | cut -d' ' -f1)"
actual="$(tool "rclone cat t:$bucket/$dump | sha256sum" | cut -d' ' -f1)"
[[ ${#recorded} -eq 64 && "$recorded" == "$actual" ]] ||
  die "the stored dump's SHA-256 ($actual) is not the recorded one ($recorded)"
ok "the stored dump matches its checksum: $actual"

output="$(backup -- status 2>&1)"
echo "$output"
grep -q '^Last successful backup: 20' <<<"$output" || die "status does not say when the last backup was"
grep -Eq '^Size: .+ \([0-9]+ bytes\)$' <<<"$output" || die "status does not give the size"
grep -q '^Backups kept: 1$' <<<"$output" || die "status does not count one backup"
ok "status gives the time, the size and the count"

backup -- verify latest 2>&1 | grep -q 'verified: pg_restore reads' || die "verify did not pass"
ok "verify downloads the backup and checks it"

# --- 2. Restore into a new install's empty database --------------------------------------

# The owner's role, which takes the backups, cannot restore one: extensions and their
# comments are the superuser's. The restore says so before it downloads anything.
if output="$(backup -e PGHOST="$target_db" -- restore latest 2>&1)"; then
  die "a restore as crm_owner was not refused"
fi
grep -q "a restore needs Postgres's superuser, and crm_owner is not one" <<<"$output" ||
  die "the refusal does not name the superuser: $output"
ok "restore as crm_owner is refused, naming the settings it needs"

restoring=(-e PGHOST="$target_db" -e BACKUP_RESTORE_USER=postgres -e BACKUP_RESTORE_PASSWORD="$super_password")
output="$(backup "${restoring[@]}" -- restore latest 2>&1)" || die "restore failed: $output"
echo "$output"
if leaks "$output"; then die "restore printed a secret"; fi
before="$(row_counts "$source_db" crm)"
after="$(row_counts "$target_db" crm)"
[[ -n "$before" && "$before" == "$after" ]] ||
  die "row counts differ: $(diff <(echo "$before") <(echo "$after") | head -20)"
grep -q '^tenancy.agencies 2$' <<<"$after" || die "the restored database lacks the two agencies"
grep -q '^tenancy.businesses 3$' <<<"$after" || die "the restored database lacks the three businesses"
ok "restore: every table has the same row count ($(wc -l <<<"$after" | tr -d ' ') tables)"

[[ "$(schema_fingerprint "$source_db" crm)" == "$(schema_fingerprint "$target_db" crm)" ]] ||
  die "the restored schema differs from the source's"
ok "restore: the schema is the same, owners and grants included: $(schema_fingerprint "$target_db" crm | cut -c1-16)"

# The app's role works in the restored database, under row-level security as before.
[[ "$(docker exec -e PGPASSWORD=app-only "$target_db" psql -X -At -h 127.0.0.1 -U crm_app -d crm -c 'select count(*) from tenancy.businesses')" == 0 ]] ||
  die "crm_app reads businesses without a tenant in the restored database"
ok "restore: crm_app connects and is still under row-level security"

if output="$(backup "${restoring[@]}" -- restore latest 2>&1)"; then
  die "restore into a database that is not empty was not refused"
fi
grep -q 'is not empty' <<<"$output" || die "the refusal does not say the database is not empty: $output"
[[ "$(row_counts "$target_db" crm)" == "$after" ]] || die "a refused restore changed the database"
ok "restore refuses a database that is not empty, and changes nothing"

sql "$target_db" crm -c "delete from tenancy.businesses where slug = 'third'"
damaged="$(row_counts "$target_db" crm)"
# While anything is connected, as a running app would be, --force changes nothing.
docker exec -d "$target_db" psql -X -U postgres -d crm -c 'select pg_sleep(12)'
sleep 1
if output="$(backup "${restoring[@]}" -- restore latest --force 2>&1)"; then
  die "restore --force dropped a database that was in use"
fi
grep -q 'is being accessed by other users' <<<"$output" || die "the refusal does not say why: $output"
[[ "$(row_counts "$target_db" crm)" == "$damaged" ]] || die "a refused restore --force changed the database"
ok "restore --force refuses while the database is in use, and changes nothing"

for _ in $(seq 1 30); do
  [[ "$(sql "$target_db" postgres -c "select count(*) from pg_stat_activity where datname = 'crm'")" == 0 ]] && break
  sleep 1
done
output="$(backup "${restoring[@]}" -- restore latest --force 2>&1)" || die "restore --force failed: $output"
echo "$output"
[[ "$(row_counts "$target_db" crm)" == "$before" ]] || die "restore --force did not bring the rows back"
[[ "$(schema_fingerprint "$source_db" crm)" == "$(schema_fingerprint "$target_db" crm)" ]] ||
  die "the schema after restore --force differs from the source's"
database_grants="select datacl::text from pg_database where datname = 'crm'"
[[ "$(sql "$target_db" postgres -c "$database_grants")" == "$(sql "$source_db" postgres -c "$database_grants")" ]] ||
  die "the database's own grants differ after restore --force"
ok "restore --force drops the database and makes it again: rows, schema and the database's grants match"

# The restore drill of docs/BACKUPS.md: a scratch database beside the live one.
sql "$source_db" postgres -c 'create database crm_restore_test owner crm_owner template template0'
output="$(backup -e BACKUP_RESTORE_USER=postgres -e BACKUP_RESTORE_PASSWORD="$super_password" \
  -e BACKUP_RESTORE_DATABASE=crm_restore_test -- restore latest 2>&1)" || die "the drill failed: $output"
[[ "$(row_counts "$source_db" crm_restore_test)" == "$before" ]] || die "the drill's row counts differ"
[[ "$(row_counts "$source_db" crm)" == "$before" ]] || die "the drill changed the live database"
sql "$source_db" postgres -c 'drop database crm_restore_test'
ok "the restore drill: a scratch database on the same server gets every row"

# --- 3. Retention ----------------------------------------------------------------------

# Backups as earlier days would have left them: a dump named for its time, and a checksum.
tool "
  set -eu
  put() { printf 'not a real dump' | rclone rcat \"t:$bucket/\$1\"; }
  dated() { # days ago, folder: prints the object's path
    at=\$((\$(date -u +%s) - \$1 * 86400 + 3600))
    echo \"\$2/\$(date -u -d @\$at +%Y/%m/%d)/crm-\$(date -u -d @\$at +%Y%m%dT%H%M%SZ).dump\"
  }
  for days in 1 2 3 4 5 6 7 9 10 30; do
    path=\$(dated \$days database/crm.example.com); put \$path; put \$path.sha256
  done
  # A dump whose upload never finished, long ago; and what is not a backup at all.
  put \$(dated 12 database/crm.example.com)
  put database/crm.example.com/notes.txt
  # Another install in the same bucket, and a second install with one old backup only.
  path=\$(dated 30 database/other.example.com); put \$path; put \$path.sha256
  path=\$(dated 30 database/lonely.example.com); put \$path; put \$path.sha256
"
before_run="$(objects)"
[[ "$(wc -l <<<"$before_run" | tr -d ' ')" == 28 ]] || die "expected 28 objects before the run, found: $before_run"

# A run that fails removes nothing: a wrong storage secret, then a wrong database password.
if output="$(backup -e BACKUP_S3_SECRET_ACCESS_KEY="$wrong_secret" -- now 2>&1)"; then
  die "a backup with a wrong storage secret did not fail"
fi
echo "$output"
grep -q 'FAILED: the upload did not succeed; no backup was removed' <<<"$output" ||
  die "the failure is not said clearly: $output"
if leaks "$output"; then die "the failed backup printed a secret"; fi
[[ "$(objects)" == "$before_run" ]] || die "a failed backup changed the bucket"
ok "a wrong storage secret: non-zero exit, a clear line, no secret printed, nothing removed"

if output="$(backup -e PGPASSWORD="$wrong_secret" -- now 2>&1)"; then
  die "a backup with a wrong database password did not fail"
fi
echo "$output"
grep -q 'FAILED: pg_dump could not dump the database' <<<"$output" || die "the failure is not said clearly: $output"
if leaks "$output"; then die "the failed backup printed a secret"; fi
[[ "$(objects)" == "$before_run" ]] || die "a failed backup changed the bucket"
ok "a wrong database password: non-zero exit, a clear line, no secret printed, nothing removed"

if backup -e BACKUP_INSTALL_NAME=lonely.example.com -e PGPASSWORD="$wrong_secret" -- now >/dev/null 2>&1; then
  die "the lonely install's backup did not fail"
fi
[[ "$(objects database/lonely.example.com | wc -l | tr -d ' ')" == 2 ]] ||
  die "a failed backup removed an install's only backup, 30 days old"
ok "a failed backup leaves an install's only backup, however old"

# The app's role cannot stand in for the owner: row-level security would hide the rows,
# so pg_dump refuses rather than store a partial dump.
if output="$(backup -e PGUSER=crm_app -e PGPASSWORD=app-only -- now 2>&1)"; then
  die "a backup as crm_app did not fail"
fi
[[ "$(objects)" == "$before_run" ]] || die "the refused backup changed the bucket"
ok "a backup as crm_app is refused: $(grep -m1 -o 'pg_dump: error: .*' <<<"$output")"

output="$(backup -- now 2>&1)" || die "the backup before pruning failed: $output"
echo "$output"
after_run="$(objects)"
old_left="$(tool "
  cutoff=\$(date -u -d @\$((\$(date -u +%s) - 7 * 86400)) +%Y%m%dT%H%M%SZ)
  rclone lsf --recursive --files-only t:$bucket/database/crm.example.com |
    awk -F/ -v cutoff=\$cutoff '\$NF ~ /^crm-/ && substr(\$NF, 5, 16) < cutoff'")"
[[ -z "$old_left" ]] || die "objects older than 7 days were kept: $old_left"
# Kept: today's two, and days 1 to 7 (each an hour inside its day): 9 dumps, 9 checksums,
# and the notes. Removed: days 9, 10 and 30 with their checksums, and the unfinished dump.
[[ "$(objects database/crm.example.com | wc -l | tr -d ' ')" == 19 ]] ||
  die "expected 19 objects for the install after pruning, found: $(objects database/crm.example.com)"
grep -q '^database/crm.example.com/notes.txt$' <<<"$after_run" || die "pruning removed a file that is not a backup"
grep -q "^$dump$" <<<"$after_run" || die "pruning removed today's first backup"
[[ "$(objects database/other.example.com | wc -l | tr -d ' ')" == 2 ]] || die "pruning touched another install"
grep -q 'removed 7 old objects; 9 backups kept' <<<"$output" || die "the run does not report what it removed: $output"
ok "retention: 7 old objects removed after a successful backup; 7 days, the notes and other installs kept"

output="$(backup -- list)"
echo "$output"
[[ "$(wc -l <<<"$output" | tr -d ' ')" == 9 ]] || die "list does not show nine backups"
ok "list shows the nine backups kept"

# --- 4. The schedule and the health check ------------------------------------------------

health() {
  docker exec "$scheduler" crm-backup healthcheck
}
docker_health() {
  for _ in $(seq 1 30); do
    [[ "$(docker inspect --format '{{.State.Health.Status}}' "$scheduler")" == "$1" ]] && return 0
    sleep 1
  done
  return 1
}

# Without a bucket: off, said plainly, running and healthy.
docker run -d --name "$scheduler" --network "$network" --health-interval 2s \
  -e PGHOST="$source_db" -e PGUSER=crm_owner -e PGPASSWORD="$owner_password" -e PGDATABASE=crm \
  "$image" >/dev/null
sleep 3
docker logs "$scheduler" 2>&1 | grep -q 'backups are OFF: BACKUP_S3_BUCKET is not set' ||
  die "a container without a bucket does not say backups are off"
[[ "$(docker inspect --format '{{.State.Running}}' "$scheduler")" == true ]] || die "it stopped"
health | grep -q 'backups are off' || die "the health check does not say backups are off"
docker run --rm "$image" status | grep -q 'Backups are off' || die "status does not say backups are off"
ok "without BACKUP_S3_BUCKET: the log says backups are off, and the container stays up"
docker rm -f "$scheduler" >/dev/null

# With half the settings: it stops, naming what is missing.
if output="$(docker run --rm -e BACKUP_S3_BUCKET="$bucket" "$image" 2>&1)"; then
  die "a container with a bucket and nothing else did not stop"
fi
grep -q 'these settings are not set: BACKUP_S3_ENDPOINT BACKUP_S3_ACCESS_KEY_ID' <<<"$output" ||
  die "the missing settings are not named: $output"
ok "with settings missing: it stops and names them"

# A new install's folder, and a time one minute from now: the schedule takes the backup.
# shellcheck disable=SC2016  # the shell in the image works the time out
at="$(tool 'date -u -d @$(($(date -u +%s) + 70)) +%H:%M')"
docker run -d --name "$scheduler" --network "$network" --health-interval 2s "${settings[@]}" \
  -e BACKUP_INSTALL_NAME=scheduled.example.com -e BACKUP_AT="$at" "$image" >/dev/null
sleep 3
health | grep -q 'healthy: the first backup is due' || die "before the first backup: $(health || true)"
docker_health healthy || die "Docker does not report the waiting container healthy"
# No backup yet, and one was due long enough ago: unhealthy.
docker exec "$scheduler" sh -c 'echo $(($(date -u +%s) - 7300)) > /var/lib/crm-backup/first-due'
if health; then die "no backup two hours after one was due, and still healthy"; fi
docker_health unhealthy || die "Docker does not report the overdue container unhealthy"
ok "health: healthy while the first backup is not due; unhealthy two hours after it was"

for _ in $(seq 1 150); do
  if docker logs "$scheduler" 2>&1 | grep -q 'backup succeeded'; then break; fi
  sleep 1
done
docker logs "$scheduler" 2>&1
docker logs "$scheduler" 2>&1 | grep -q 'backup succeeded' || die "the scheduled backup did not run at $at"
[[ "$(objects database/scheduled.example.com | wc -l | tr -d ' ')" == 2 ]] || die "the scheduled backup is not in the bucket"
health | grep -q 'healthy: the last successful backup was 0 hours ago' || die "after the backup: $(health || true)"
docker_health healthy || die "Docker does not report the container healthy after its backup"
ok "the schedule takes the backup at BACKUP_AT ($at UTC), and the container is healthy again"

# The last success 27 hours ago: unhealthy. 25 hours ago: still healthy.
docker exec "$scheduler" sh -c 'echo "$(($(date -u +%s) - 27 * 3600)) x 1 x" > /var/lib/crm-backup/last-success'
if health; then die "a backup 27 hours old, and still healthy"; fi
docker_health unhealthy || die "Docker does not report the stale container unhealthy"
docker exec "$scheduler" sh -c 'echo "$(($(date -u +%s) - 25 * 3600)) x 1 x" > /var/lib/crm-backup/last-success'
health >/dev/null || die "a backup 25 hours old is reported unhealthy"
ok "health: unhealthy when the last backup is 27 hours old, healthy at 25"
docker rm -f "$scheduler" >/dev/null

# A scheduled backup that fails is tried again, the container stays up and unhealthy, and
# the install's one backup, 30 days old, is left alone.
docker run -d --name "$scheduler" --network "$network" "${settings[@]}" \
  -e BACKUP_INSTALL_NAME=lonely.example.com -e BACKUP_AT="$at" -e PGPASSWORD="$wrong_secret" \
  -e BACKUP_RETRY_SECONDS=2 "$image" >/dev/null
for _ in $(seq 1 60); do
  [[ "$(docker logs "$scheduler" 2>&1 | grep -c 'the backup will be tried again in 2 s')" -ge 2 ]] && break
  sleep 1
done
output="$(docker logs "$scheduler" 2>&1)"
[[ "$(grep -c 'FAILED: pg_dump could not dump the database' <<<"$output")" -ge 2 ]] ||
  die "the failing schedule did not try again: $output"
if leaks "$output"; then die "the failing schedule printed a secret"; fi
[[ "$(docker inspect --format '{{.State.Running}}' "$scheduler")" == true ]] || die "the failing schedule stopped"
if health; then die "a schedule whose backups fail, the last one 30 days old, is healthy"; fi
[[ "$(objects database/lonely.example.com | wc -l | tr -d ' ')" == 2 ]] ||
  die "a failing schedule removed the install's only backup"
ok "a scheduled backup that fails is tried again; the container is unhealthy and removes nothing"
docker rm -f "$scheduler" >/dev/null

# A container that was away when a backup was due: it reads the bucket (the lonely
# install's one backup is 30 days old) and takes one at once.
docker run -d --name "$scheduler" --network "$network" "${settings[@]}" \
  -e BACKUP_INSTALL_NAME=lonely.example.com -e BACKUP_AT="$at" "$image" >/dev/null
for _ in $(seq 1 60); do
  if docker logs "$scheduler" 2>&1 | grep -q 'backup succeeded'; then break; fi
  sleep 1
done
docker logs "$scheduler" 2>&1 | grep -q 'backup succeeded' || die "the overdue backup was not taken at start"
[[ "$(objects database/lonely.example.com | wc -l | tr -d ' ')" == 2 ]] ||
  die "expected the new backup alone, the 30 day old one pruned: $(objects database/lonely.example.com)"
ok "a container started with the last backup 30 days old takes one at once, then prunes"
docker rm -f "$scheduler" >/dev/null

# --- 5. Encryption (optional) -----------------------------------------------------------

docker volume create "$keys" >/dev/null
recipient="$(docker run --rm --user 0 --entrypoint sh -v "$keys:/keys" "$image" -c \
  'age-keygen -o /keys/key.txt 2>/dev/null && chmod 644 /keys/key.txt && age-keygen -y /keys/key.txt')"
[[ "$recipient" == age1* ]] || die "no age key was made"
encrypted=(-e BACKUP_INSTALL_NAME=encrypted.example.com)
output="$(backup "${encrypted[@]}" -e BACKUP_ENCRYPT_TO="$recipient" -- now 2>&1)" || die "the encrypted backup failed: $output"
mapfile -t stored < <(objects database/encrypted.example.com)
[[ ${#stored[@]} -eq 2 && "${stored[0]}" == *.dump.age && "${stored[1]}" == *.dump.age.sha256 ]] ||
  die "expected an encrypted dump and its checksum: ${stored[*]}"
tool "rclone cat t:$bucket/database/encrypted.example.com/${stored[0]} | head -c 21" | grep -q '^age-encryption.org/v1' ||
  die "the stored file is not age's format"
ok "with BACKUP_ENCRYPT_TO: the stored dump is age-encrypted"

sql "$target_db" postgres -c 'create database crm_encrypted owner crm_owner template template0'
into=("${restoring[@]}" -e BACKUP_RESTORE_DATABASE=crm_encrypted)
if output="$(backup "${encrypted[@]}" "${into[@]}" -- restore latest 2>&1)"; then
  die "an encrypted backup was restored without its key"
fi
grep -q 'is encrypted: set BACKUP_DECRYPT_IDENTITY_FILE' <<<"$output" || die "the missing key is not named: $output"
output="$(backup "${encrypted[@]}" "${into[@]}" -v "$keys:/keys:ro" \
  -e BACKUP_DECRYPT_IDENTITY_FILE=/keys/key.txt -- restore latest 2>&1)" || die "the encrypted restore failed: $output"
[[ "$(row_counts "$target_db" crm_encrypted)" == "$before" ]] || die "the decrypted restore's row counts differ"
ok "an encrypted backup restores with its key, and not without it"

echo "backup tests passed: $passed checks"
