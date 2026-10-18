# syntax=docker/dockerfile:1
#
# The install's database backups: a daily pg_dump of the CRM's database to
# S3-compatible storage, with a week kept, and the restore. compose.yml's backup service
# runs it. Build it from this directory: docker build --tag crm-backup backup
#
# Alpine 3.24, pinned by digest, with two packages from its own repositories:
#   postgresql18-client  pg_dump, pg_restore and psql of Postgres 18, the database's major
#                        version: pg_dump refuses a server newer than itself.
#   age                  optional encryption before upload (BACKUP_ENCRYPT_TO).
# and rclone, the S3 client: its one static binary, from rclone's own image, pinned by
# digest. Alpine 3.24's rclone package (1.74.1) failed the image scan on 2026-10-12.
FROM rclone/rclone:1.75.2@sha256:2687085f718d3c628f7fdfb77c52a1d344332aed543110bb88088f2c70d43eb5 AS rclone

FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
# tini runs as PID 1: it passes Docker's SIGTERM on to the script and reaps what it leaves.
# apk upgrade takes Alpine's security fixes as they're released, between base image updates.
# The check stops a build whose pg_dump is not Postgres 18.
RUN apk upgrade --no-cache \
    && apk add --no-cache age ca-certificates postgresql18-client tini \
    && pg_dump --version | grep -q '(PostgreSQL) 18\.' \
    && addgroup -S backup \
    && adduser -S -G backup -H -h /var/lib/crm-backup backup \
    && mkdir -p /var/lib/crm-backup /var/tmp/crm-backup \
    && chown backup:backup /var/lib/crm-backup /var/tmp/crm-backup
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
COPY --chmod=0755 crm-backup.sh /usr/local/bin/crm-backup
USER backup
# Reads two small files the script keeps; it never calls the network.
HEALTHCHECK --interval=5m --timeout=10s --start-period=30s --retries=1 \
    CMD ["crm-backup", "healthcheck"]
ENTRYPOINT ["/sbin/tini", "--", "crm-backup"]
CMD ["schedule"]
