#!/bin/sh
# The install's database backups (docs/BACKUPS.md).
#
#   crm-backup schedule            once a day at BACKUP_AT (UTC); what the container runs
#   crm-backup now                 one backup, now
#   crm-backup status              the newest backup, its size, and how many are kept
#   crm-backup list                every backup kept, oldest first
#   crm-backup verify [NAME]       download a backup and check it against its checksum
#   crm-backup restore [NAME] [--force]
#                                  download, check, and load into an empty database
#   crm-backup healthcheck         for Docker: fails when the last backup is too old
#
# NAME is a backup's file name, such as crm-20261012T021500Z.dump, or "latest".
#
# A backup is one pg_dump of the whole database in custom format, stored as
#   <bucket>/<prefix>/<install>/YYYY/MM/DD/crm-<UTC time>.dump     (.dump.age if encrypted)
# with its SHA-256 beside it in a .sha256 file. The checksum is uploaded last, so a dump
# without one is an upload that did not finish, and is never counted as a backup.
#
# POSIX sh, as busybox runs it in the image. Nothing here prints a password, a key or a
# connection string: Postgres and the storage read theirs from the environment, and what
# the tools write to standard error passes through redact() first.
set -eu
umask 077

STATE_DIR=${BACKUP_STATE_DIR:-/var/lib/crm-backup}
WORK_DIR=${BACKUP_WORK_DIR:-/var/tmp/crm-backup}
# A backup is due every 24 hours; two more are allowed for the dump and the upload.
MAX_AGE=${BACKUP_HEALTH_MAX_AGE_SECONDS:-93600}
RETRY_AFTER=${BACKUP_RETRY_SECONDS:-3600}
NAME_PATTERN='^crm-[0-9]{8}T[0-9]{6}Z\.dump(\.age)?$'

log() {
  printf '%s crm-backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

fail() {
  log "FAILED: $*"
  exit 1
}

# Replaces every secret this container was given with [redacted].
redact() {
  awk '
    BEGIN {
      count = split("PGPASSWORD BACKUP_RESTORE_PASSWORD BACKUP_S3_SECRET_ACCESS_KEY BACKUP_S3_ACCESS_KEY_ID", names, " ")
    }
    {
      for (i = 1; i <= count; i++) {
        secret = ENVIRON[names[i]]
        if (length(secret) < 4) continue
        while ((at = index($0, secret)) > 0) {
          $0 = substr($0, 1, at - 1) "[redacted]" substr($0, at + length(secret))
        }
      }
      print
    }'
}

# Runs a command with its standard error redacted. Its standard output is left alone.
run() {
  run_errors=$(mktemp "$WORK_DIR/stderr.XXXXXX")
  run_status=0
  "$@" 2>"$run_errors" || run_status=$?
  redact <"$run_errors" >&2
  rm -f "$run_errors"
  return "$run_status"
}

configured() {
  [ -n "${BACKUP_S3_BUCKET:-}" ]
}

# Stops unless every setting a backup needs is there, naming the ones that are not.
require_settings() {
  missing=''
  for name in BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID \
    BACKUP_S3_SECRET_ACCESS_KEY PGHOST PGUSER PGPASSWORD PGDATABASE; do
    eval "value=\${$name:-}"
    [ -n "$value" ] || missing="$missing $name"
  done
  [ -z "$missing" ] || fail "these settings are not set:$missing"

  retention=${BACKUP_RETENTION_DAYS:-7}
  case "$retention" in
    '' | *[!0-9]*) fail "BACKUP_RETENTION_DAYS must be a whole number of days, 1 or more" ;;
  esac
  [ "$retention" -ge 1 ] || fail "BACKUP_RETENTION_DAYS must be a whole number of days, 1 or more"

  install=${BACKUP_INSTALL_NAME:-}
  if [ -z "$install" ]; then
    # The host of PUBLIC_URL: https://crm.example.com:8443/x becomes crm.example.com.
    install=${PUBLIC_URL:-}
    install=${install#*://}
    install=${install%%/*}
    install=${install%%:*}
  fi
  [ -n "$install" ] || fail "set BACKUP_INSTALL_NAME: the folder this install's backups go in"
  case "$install" in
    *[!A-Za-z0-9._-]* | .*) fail "BACKUP_INSTALL_NAME may hold letters, digits, dots, dashes and underscores only" ;;
  esac

  prefix=${BACKUP_S3_PREFIX:-}
  prefix=${prefix#/}
  prefix=${prefix%/}
  # The storage, as rclone reads it from the environment (its docs: "Config file",
  # RCLONE_CONFIG_<REMOTE>_<OPTION>). no_check_bucket: the bucket exists already, and a key
  # that may only read and write objects, as Cloudflare R2 issues, cannot look for it.
  provider=${BACKUP_S3_PROVIDER:-}
  if [ -z "$provider" ]; then
    case "$BACKUP_S3_ENDPOINT" in
      *.r2.cloudflarestorage.com*) provider=Cloudflare ;;
      *) provider=Other ;;
    esac
  fi
  export RCLONE_CONFIG=/dev/null
  export RCLONE_CONFIG_CRMBACKUP_TYPE=s3
  export RCLONE_CONFIG_CRMBACKUP_PROVIDER="$provider"
  export RCLONE_CONFIG_CRMBACKUP_ENDPOINT="$BACKUP_S3_ENDPOINT"
  export RCLONE_CONFIG_CRMBACKUP_REGION="${BACKUP_S3_REGION:-auto}"
  export RCLONE_CONFIG_CRMBACKUP_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID"
  export RCLONE_CONFIG_CRMBACKUP_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY"
  export RCLONE_CONFIG_CRMBACKUP_NO_CHECK_BUCKET=true
  folder="${prefix:+$prefix/}$install"
  remote="crmbackup:$BACKUP_S3_BUCKET/$folder"
}

# Every object under the install's folder, as "size|path", the path from that folder.
# A folder that does not exist yet (rclone's exit code 3) holds nothing.
list_objects() {
  list_status=0
  run rclone lsf --recursive --files-only --format sp --separator '|' "$remote" || list_status=$?
  case "$list_status" in
    0 | 3) return 0 ;;
    *) return "$list_status" ;;
  esac
}

# The backups among them, oldest first, as "time|size|path": a dump with its checksum.
good_backups() {
  awk -F'|' -v pattern="$NAME_PATTERN" '
    {
      parts = split($2, folders, "/")
      name = folders[parts]
      if (name ~ /\.sha256$/) {
        sums[substr($2, 1, length($2) - 7)] = 1
      } else if (name ~ pattern) {
        sizes[$2] = $1
        times[$2] = substr(name, 5, 16)
      }
    }
    END {
      for (path in sizes) if (path in sums) print times[path] "|" sizes[path] "|" path
    }' | sort
}

# Seconds since 1970 for a backup's time, such as 20261012T021500Z.
epoch_of() {
  date -u -D '%Y%m%dT%H%M%SZ' -d "$1" +%s
}

human_size() {
  awk -v bytes="$1" 'BEGIN {
    split("B KiB MiB GiB TiB", units, " ")
    unit = 1
    while (bytes >= 1024 && unit < 5) { bytes /= 1024; unit++ }
    printf (unit == 1 ? "%d %s" : "%.1f %s"), bytes, units[unit]
  }'
}

record_success() {
  mkdir -p "$STATE_DIR"
  printf '%s %s %s %s\n' "$1" "$2" "$3" "$4" >"$STATE_DIR/last-success.new"
  mv "$STATE_DIR/last-success.new" "$STATE_DIR/last-success"
}

# Deletes what is older than the retention, and only ever after a backup that succeeded.
# It counts the backups that would stay first: with none, it deletes nothing.
prune() {
  cutoff=$(date -u -d "@$(($(date -u +%s) - retention * 86400))" +%Y%m%dT%H%M%SZ)
  listing=$(list_objects) || {
    log "FAILED: the backup is stored, but the bucket could not be listed to remove old backups"
    return 1
  }
  prune_status=0
  doomed=$(printf '%s\n' "$listing" | awk -F'|' -v cutoff="$cutoff" -v pattern="$NAME_PATTERN" '
    {
      parts = split($2, folders, "/")
      name = folders[parts]
      dump = name
      sub(/\.sha256$/, "", dump)
      if (dump !~ pattern) next
      times[$2] = substr(name, 5, 16)
      if (name ~ /\.sha256$/) sums[substr($2, 1, length($2) - 7)] = 1
      else dumps[$2] = 1
    }
    END {
      staying = 0
      for (path in dumps) if ((path in sums) && times[path] >= cutoff) staying++
      if (staying == 0) exit 4
      for (path in times) if (times[path] < cutoff) print path
    }') || prune_status=$?
  if [ "$prune_status" -ne 0 ]; then
    log "FAILED: no backup newer than $retention days would be left, so nothing was removed"
    return 1
  fi
  removed=0
  for path in $doomed; do
    run rclone deletefile "$remote/$path" || {
      log "FAILED: could not remove the old backup $path"
      return 1
    }
    removed=$((removed + 1))
  done
  kept=$(printf '%s\n' "$listing" | good_backups | awk -F'|' -v cutoff="$cutoff" '$1 >= cutoff' | wc -l)
  log "retention: $retention days; removed $removed old objects; $((kept)) backups kept"
}

backup_now() {
  require_settings
  mkdir -p "$WORK_DIR"
  run_dir=$(mktemp -d "$WORK_DIR/run.XXXXXX")
  # shellcheck disable=SC2064  # the folder made now is the one to remove
  trap "rm -rf '$run_dir'" EXIT

  started=$(date -u +%s)
  stamp=$(date -u -d "@$started" +%Y%m%dT%H%M%SZ)
  day=$(date -u -d "@$started" +%Y/%m/%d)
  name="crm-$stamp.dump"
  file="$run_dir/$name"
  log "backup started: database $PGDATABASE on $PGHOST as $PGUSER, to $BACKUP_S3_BUCKET/$folder"

  # Custom format: compressed, and pg_restore reads it. Owners and grants are kept.
  run pg_dump --format=custom --no-password --file="$file" ||
    fail "pg_dump could not dump the database; nothing was uploaded and no backup was removed"
  # Reads the dump's table of contents back, so a file pg_restore cannot open is never stored.
  run pg_restore --list "$file" >/dev/null ||
    fail "the dump cannot be read back; nothing was uploaded and no backup was removed"

  if [ -n "${BACKUP_ENCRYPT_TO:-}" ]; then
    run age --encrypt --recipient "$BACKUP_ENCRYPT_TO" --output "$file.age" "$file" ||
      fail "age could not encrypt the dump to BACKUP_ENCRYPT_TO; nothing was uploaded and no backup was removed"
    rm -f "$file"
    name="$name.age"
    file="$file.age"
  fi

  size=$(wc -c <"$file")
  size=$((size))
  sum=$(sha256sum "$file")
  sum=${sum%% *}
  # The format sha256sum --check reads.
  printf '%s  %s\n' "$sum" "$name" >"$file.sha256"

  # rclone checks what it sent against what the storage says it holds, and fails if they
  # differ. --immutable: a stored backup is never written over.
  run rclone copyto --immutable "$file" "$remote/$day/$name" ||
    fail "the upload did not succeed; no backup was removed"
  stored=$(run rclone lsf --files-only --format s "$remote/$day/$name") ||
    fail "the uploaded dump could not be found in the bucket; no backup was removed"
  [ "$stored" = "$size" ] ||
    fail "the bucket holds ${stored:-nothing} bytes of a $size byte dump; no backup was removed"
  run rclone copyto --immutable "$file.sha256" "$remote/$day/$name.sha256" ||
    fail "the checksum's upload did not succeed; no backup was removed"
  stored_sum=$(run rclone cat "$remote/$day/$name.sha256") ||
    fail "the uploaded checksum could not be read back; no backup was removed"
  [ "${stored_sum%% *}" = "$sum" ] ||
    fail "the checksum in the bucket is not the one uploaded; no backup was removed"

  record_success "$(date -u +%s)" "$stamp" "$size" "$name"
  log "backup succeeded: $day/$name, $(human_size "$size"), sha256 $sum, in $(($(date -u +%s) - started)) s"
  prune
}

# The path of the backup asked for: a file name, a path under the install's folder, or
# "latest".
resolve() {
  wanted=${1:-latest}
  if [ "$wanted" = latest ]; then
    listing=$(list_objects) || fail "the bucket could not be listed"
    newest=$(printf '%s\n' "$listing" | good_backups | tail -n 1)
    [ -n "$newest" ] || fail "there is no backup under $BACKUP_S3_BUCKET/$folder"
    printf '%s\n' "${newest##*|}"
    return 0
  fi
  wanted=${wanted##*/}
  printf '%s\n' "$wanted" | grep -Eq "$NAME_PATTERN" ||
    fail "a backup's name looks like crm-20261012T021500Z.dump"
  stamp=${wanted#crm-}
  printf '%s/%s/%s/%s\n' "$(printf '%s' "$stamp" | cut -c1-4)" \
    "$(printf '%s' "$stamp" | cut -c5-6)" "$(printf '%s' "$stamp" | cut -c7-8)" "$wanted"
}

# Downloads a backup into $run_dir and checks it against its checksum. Sets $file.
fetch() {
  path=$(resolve "${1:-latest}")
  name=${path##*/}
  mkdir -p "$WORK_DIR"
  run_dir=$(mktemp -d "$WORK_DIR/run.XXXXXX")
  # shellcheck disable=SC2064  # the folder made now is the one to remove
  trap "rm -rf '$run_dir'" EXIT
  file="$run_dir/$name"
  log "downloading $path from $BACKUP_S3_BUCKET/$folder"
  run rclone copyto "$remote/$path.sha256" "$file.sha256" ||
    fail "$path has no checksum in the bucket, so it is not a finished backup"
  run rclone copyto "$remote/$path" "$file" || fail "$path could not be downloaded"
  (cd "$run_dir" && run sha256sum -c "$name.sha256" >/dev/null) ||
    fail "$path does not match its checksum; it was not used"
  log "checksum matches: $name, $(human_size "$(($(wc -c <"$file")))")"
}

verify() {
  require_settings
  fetch "${1:-latest}"
  case "$name" in
    *.age) log "verified; it is encrypted, so its contents were not read" ;;
    *)
      run pg_restore --list "$file" >/dev/null || fail "$name is not a dump pg_restore can read"
      log "verified: pg_restore reads its table of contents"
      ;;
  esac
}

restore() {
  wanted=latest
  force=no
  for argument in "$@"; do
    case "$argument" in
      --force) force=yes ;;
      -*) fail "restore takes a backup's name or latest, and --force" ;;
      *) wanted=$argument ;;
    esac
  done
  require_settings
  # Extensions and other roles' objects need a superuser; see docs/BACKUPS.md.
  export PGUSER="${BACKUP_RESTORE_USER:-$PGUSER}"
  export PGPASSWORD="${BACKUP_RESTORE_PASSWORD:-$PGPASSWORD}"
  export PGDATABASE="${BACKUP_RESTORE_DATABASE:-$PGDATABASE}"

  mkdir -p "$WORK_DIR"
  superuser=$(run psql --no-psqlrc --no-password --tuples-only --no-align \
    --command "select rolsuper from pg_roles where rolname = current_user") ||
    fail "could not connect to database $PGDATABASE on $PGHOST as $PGUSER"
  [ "$superuser" = t ] ||
    fail "a restore needs Postgres's superuser, and $PGUSER is not one: set BACKUP_RESTORE_USER=postgres and BACKUP_RESTORE_PASSWORD to its password; nothing was changed"
  # Tables, views, sequences and schemas that no extension brought. A database the
  # install's first start made, before any migration, has none.
  objects=$(run psql --no-psqlrc --no-password --tuples-only --no-align --command "
    select (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
              and n.nspname <> 'information_schema' and n.nspname not like 'pg\\_%'
              and not exists (select 1 from pg_depend d
                              where d.classid = 'pg_class'::regclass and d.objid = c.oid
                                and d.deptype = 'e'))
         + (select count(*) from pg_namespace
            where nspname not in ('public', 'information_schema') and nspname not like 'pg\\_%')") ||
    fail "could not connect to database $PGDATABASE on $PGHOST as $PGUSER"
  if [ "$objects" != 0 ] && [ "$force" != yes ]; then
    fail "database $PGDATABASE on $PGHOST is not empty ($objects tables, views, sequences and schemas); nothing was changed. Restore into an empty database, or pass --force to replace what the backup holds"
  fi

  fetch "$wanted"
  case "$name" in
    *.age)
      [ -n "${BACKUP_DECRYPT_IDENTITY_FILE:-}" ] ||
        fail "$name is encrypted: set BACKUP_DECRYPT_IDENTITY_FILE to the file that holds its age key"
      run age --decrypt --identity "$BACKUP_DECRYPT_IDENTITY_FILE" --output "${file%.age}" "$file" ||
        fail "age could not decrypt $name with the key in BACKUP_DECRYPT_IDENTITY_FILE"
      rm -f "$file"
      file=${file%.age}
      ;;
  esac

  log "restoring $name into database $PGDATABASE on $PGHOST as $PGUSER"
  if [ "$objects" != 0 ]; then
    # Forced: the database is dropped and made again from the backup, with its own
    # grants. pg_restore cannot do that in one transaction, and cannot drop a database
    # that anything is still connected to, which is the last guard: stop app and worker.
    dumped=$(run pg_restore --list "$file" | sed -n 's/^; *dbname: *//p')
    [ "$dumped" = "$PGDATABASE" ] ||
      fail "--force drops and remakes the database the backup was taken from, $dumped, and this is $PGDATABASE; nothing was changed"
    log "--force: dropping database $PGDATABASE and making it again from the backup"
    run pg_restore --no-password --exit-on-error --clean --if-exists --create --dbname=postgres "$file" ||
      fail "pg_restore stopped at an error. If the line above says the database is being accessed by other users, nothing was changed: stop app and worker first. Otherwise database $PGDATABASE is incomplete: fix the cause and restore again"
  else
    # One transaction: the database gets the whole backup or stays as it was.
    run pg_restore --no-password --single-transaction --dbname="$PGDATABASE" "$file" ||
      fail "pg_restore stopped at an error; database $PGDATABASE was left as it was"
  fi
  tables=$(run psql --no-psqlrc --no-password --tuples-only --no-align --command "
    select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and n.nspname <> 'information_schema'
      and n.nspname not like 'pg\\_%'") || fail "the restore finished, but the database could not be read"
  log "restore succeeded: $name is in database $PGDATABASE, $tables tables"
}

status() {
  if ! configured; then
    echo "Backups are off: BACKUP_S3_BUCKET is not set."
    return 0
  fi
  require_settings
  mkdir -p "$WORK_DIR"
  listing=$(list_objects) || fail "the bucket could not be listed"
  backups=$(printf '%s\n' "$listing" | good_backups)
  echo "Backups of install $install in $BACKUP_S3_BUCKET/$folder"
  if [ -z "$backups" ]; then
    echo "Last successful backup: none yet"
    echo "Backups kept: 0"
    return 0
  fi
  newest=$(printf '%s\n' "$backups" | tail -n 1)
  oldest=$(printf '%s\n' "$backups" | head -n 1)
  newest_time=${newest%%|*}
  newest_rest=${newest#*|}
  age=$(($(date -u +%s) - $(epoch_of "$newest_time")))
  echo "Last successful backup: $(date -u -d "@$(epoch_of "$newest_time")" '+%Y-%m-%d %H:%M:%S UTC') ($((age / 3600)) h $((age % 3600 / 60)) min ago)"
  echo "File: ${newest_rest#*|}"
  echo "Size: $(human_size "${newest_rest%%|*}") (${newest_rest%%|*} bytes)"
  echo "Backups kept: $(($(printf '%s\n' "$backups" | wc -l)))"
  echo "Oldest kept: $(date -u -d "@$(epoch_of "${oldest%%|*}")" '+%Y-%m-%d %H:%M:%S UTC')"
  echo "Retention: ${retention} days; daily at ${BACKUP_AT:-02:15} UTC"
}

list() {
  require_settings
  mkdir -p "$WORK_DIR"
  listing=$(list_objects) || fail "the bucket could not be listed"
  printf '%s\n' "$listing" | good_backups | awk -F'|' '{ printf "%s  %12d bytes  %s\n", $1, $2, $3 }'
}

# The next time the clock reads BACKUP_AT, in seconds since 1970.
next_run() {
  now=$(date -u +%s)
  at=$((now - now % 86400 + at_hours * 3600 + at_minutes * 60))
  [ "$at" -gt "$now" ] || at=$((at + 86400))
  echo "$at"
}

schedule() {
  mkdir -p "$STATE_DIR" "$WORK_DIR"
  rm -rf "$WORK_DIR"/run.* "$WORK_DIR"/stderr.* "$STATE_DIR/disabled" "$STATE_DIR/first-due"
  if ! configured; then
    : >"$STATE_DIR/disabled"
    log "backups are OFF: BACKUP_S3_BUCKET is not set, so this database is not being backed up. Set the BACKUP_S3_ settings to turn them on (install.env.example, docs/BACKUPS.md)."
    # Stays up, so Compose does not restart it in a loop.
    while :; do sleep 86400; done
  fi
  require_settings

  at=${BACKUP_AT:-02:15}
  printf '%s\n' "$at" | grep -Eq '^([01][0-9]|2[0-3]):[0-5][0-9]$' ||
    fail "BACKUP_AT must be a UTC time as HH:MM, such as 02:15"
  at_hours=${at%:*}
  at_minutes=${at#*:}
  at_hours=${at_hours#0}
  at_minutes=${at_minutes#0}

  # A new container knows nothing of earlier backups: the bucket does.
  if [ ! -f "$STATE_DIR/last-success" ]; then
    if listing=$(list_objects); then
      newest=$(printf '%s\n' "$listing" | good_backups | tail -n 1)
      if [ -n "$newest" ]; then
        rest=${newest#*|}
        record_success "$(epoch_of "${newest%%|*}")" "${newest%%|*}" "${rest%%|*}" "${rest##*/}"
      fi
    else
      log "FAILED: the bucket could not be listed at start; the next backup will say why"
    fi
  fi

  while :; do
    due=$(next_run)
    if [ -f "$STATE_DIR/last-success" ]; then
      read -r last _ <"$STATE_DIR/last-success"
      # The container was away when a backup was due: take it now.
      [ $(($(date -u +%s) - last)) -lt 86400 ] || due=$(date -u +%s)
    fi
    [ -f "$STATE_DIR/first-due" ] || echo "$due" >"$STATE_DIR/first-due"
    log "next backup at $(date -u -d "@$due" '+%Y-%m-%d %H:%M UTC'); $retention days kept"
    # In short sleeps, so a changed clock is noticed.
    while [ "$(date -u +%s)" -lt "$due" ]; do
      left=$((due - $(date -u +%s)))
      [ "$left" -le 300 ] || left=300
      sleep "$left"
    done
    # In a subshell: a failed backup ends the attempt, not the schedule.
    until (backup_now); do
      log "the backup will be tried again in $RETRY_AFTER s"
      sleep "$RETRY_AFTER"
    done
  done
}

healthcheck() {
  if [ -f "$STATE_DIR/disabled" ]; then
    echo "backups are off: BACKUP_S3_BUCKET is not set"
    return 0
  fi
  now=$(date -u +%s)
  if [ -f "$STATE_DIR/last-success" ]; then
    read -r last _ <"$STATE_DIR/last-success"
    if [ $((now - last)) -gt "$MAX_AGE" ]; then
      echo "unhealthy: the last successful backup was $(((now - last) / 3600)) hours ago"
      return 1
    fi
    echo "healthy: the last successful backup was $(((now - last) / 3600)) hours ago"
    return 0
  fi
  if [ -f "$STATE_DIR/first-due" ]; then
    read -r first <"$STATE_DIR/first-due"
    grace=$((MAX_AGE - 86400))
    [ "$grace" -ge 0 ] || grace=0
    if [ "$now" -gt $((first + grace)) ]; then
      echo "unhealthy: no backup has succeeded, and one was due at $(date -u -d "@$first" '+%Y-%m-%d %H:%M UTC')"
      return 1
    fi
    echo "healthy: the first backup is due at $(date -u -d "@$first" '+%Y-%m-%d %H:%M UTC')"
    return 0
  fi
  echo "healthy: no schedule runs in this container"
}

usage() {
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
}

command=${1:-schedule}
[ $# -eq 0 ] || shift
case "$command" in
  schedule) schedule ;;
  now) backup_now ;;
  status) status ;;
  list) list ;;
  verify) verify "$@" ;;
  restore) restore "$@" ;;
  healthcheck) healthcheck ;;
  help | --help | -h) usage ;;
  *)
    usage >&2
    exit 2
    ;;
esac
