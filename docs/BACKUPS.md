# Backups and restore

How the CRM's database is backed up, what a backup holds, and how to restore one.

## What happens

The `backup` service in [compose.yml](../compose.yml) runs a small image built from
[backup/](../backup/). Once a day, at `BACKUP_AT` (UTC, 02:15 unless you change it), it:

1. dumps the whole `crm` database with `pg_dump` in custom format, as the owner's role;
2. reads the dump's table of contents back, so a broken file is never stored;
3. encrypts it with age, if `BACKUP_ENCRYPT_TO` is set;
4. uploads it to S3-compatible storage, then its SHA-256 beside it;
5. checks that the storage holds the same number of bytes and the same checksum;
6. only then removes backups older than `BACKUP_RETENTION_DAYS` (7).

A backup is two objects:

```text
<bucket>/<prefix>/<install name>/YYYY/MM/DD/crm-<UTC time>.dump         (.dump.age if encrypted)
<bucket>/<prefix>/<install name>/YYYY/MM/DD/crm-<UTC time>.dump.sha256
```

The checksum is uploaded last. A dump without one is an upload that did not finish; it is
never counted as a backup or restored, and it is removed once it is older than the
retention.

If a backup fails, the container says why in its log in a line that starts `FAILED:`,
removes nothing, and tries again every hour. The container turns **unhealthy** when the
last successful backup is more than 26 hours old, or when no backup has succeeded two
hours after the first one was due. A container that starts and finds the newest backup in
the bucket older than a day takes one at once.

## What a backup holds, and what it does not

| | In the backup? | How to protect it |
| --- | --- | --- |
| The database: every agency, business, contact, message, workflow, setting and the job queue | Yes | This page |
| Uploaded files (attachments, logos, imports) | **No** | With `FILES_DIR`, they are in the `files` Docker volume: copy or snapshot it with the server. With `FILES_S3_*`, they are in the files bucket: see below |
| The vault's keys, `SECRETS_KEYS` and `SECRETS_PUBLIC_KEY` | **No** | Keep a copy of `install.env` (or Coolify's environment) somewhere else |
| `AUTH_SECRET`, `FILES_LINK_SECRET`, `PUBLIC_INTAKE_SECRET` and the database roles' passwords | **No** | The same copy |
| Postgres's roles and their passwords | **No** | The install's first start makes them again from `install.env` |

**Without `SECRETS_KEYS`, the sealed secrets in a restored database cannot be opened.**
Mailbox passwords, OAuth tokens, SMS providers' tokens and AI keys are stored sealed, and
only that key opens them. Everything else in the database restores and works; people would
have to enter those credentials again. Keep the key apart from the bucket: whoever holds
both a dump and the key can read every stored credential.

Without `AUTH_SECRET`, everyone signs in again. Without `FILES_LINK_SECRET`, file links
sent earlier stop working.

**The files bucket.** Turn on what the storage offers against deleting or overwriting an
object by mistake:

- Cloudflare R2 has no object versioning (its S3 API page lists `PutBucketVersioning` as
  not implemented). It has bucket locks, which keep every object from being deleted or
  overwritten for a number of days:
  `npx wrangler r2 bucket lock add <files bucket> crm-files "" --retention-days 30`.
- On Amazon S3, MinIO, Backblaze B2 and others that have it, turn on bucket versioning.

## Turn backups on

1. Make a bucket, and an access key that may read, write and delete objects in that
   bucket only. Use a different bucket from the one that holds uploaded files.
2. In `install.env` (or Coolify's environment variables), set:

   ```sh
   COMPOSE_PROFILES=backup
   BACKUP_S3_ENDPOINT=https://<account id>.r2.cloudflarestorage.com
   BACKUP_S3_REGION=auto
   BACKUP_S3_BUCKET=<bucket>
   BACKUP_S3_ACCESS_KEY_ID=<access key id>
   BACKUP_S3_SECRET_ACCESS_KEY=<secret access key>
   ```

   [install.env.example](../install.env.example) lists the rest: the prefix, the install's
   name, the time, the retention and encryption.
3. Start it, take one backup now, and look at it:

   ```sh
   docker compose --env-file install.env up -d
   docker compose --env-file install.env run --rm backup now
   docker compose --env-file install.env run --rm backup status
   ```

The service is in a Compose profile, so an install that has not set
`COMPOSE_PROFILES=backup` starts nothing. `docker compose run --rm backup …` works either
way. If the profile is on and `BACKUP_S3_BUCKET` is empty, the container stays up and its
log says `backups are OFF`. If the bucket is set and another setting is missing, it stops
and names what is missing.

**On Coolify:** set the same variables on the resource. Whether Coolify passes
`COMPOSE_PROFILES` to Compose has not been checked on a Coolify server; if the `backup`
container does not appear, set the resource's Custom Start Command to
`docker compose --profile backup up -d`. [HOSTING.md](HOSTING.md), 3.6, has what
Coolify's documentation does and does not say about it.

### A second guard in the bucket

The CRM removes old backups itself, and only after a new one is safely stored. A lifecycle
rule in the bucket is a second guard against the bucket growing without end, for example
if the access key loses its right to delete. Set it **well above** the retention, because
a lifecycle rule deletes by age alone: if backups stopped for longer than its days, it
would delete the last good one.

```sh
# Cloudflare R2: delete what is under database/ after 35 days
npx wrangler r2 bucket lifecycle add <bucket> crm-backups-expire database/ --expire-days 35
npx wrangler r2 bucket lifecycle list <bucket>
```

R2 removes an expired object within about a day, and already aborts unfinished multipart
uploads after seven days by default. A bucket lock on the backups bucket must be shorter
than `BACKUP_RETENTION_DAYS`, or the CRM's own removal of old backups will be refused.

### Encryption

R2 encrypts every object at rest with AES-256, with keys Cloudflare manages, and the
upload travels over TLS. That protects against a stolen disk, not against someone who gets
into the bucket.

To encrypt before upload, make an age key pair on another machine, set the public key, and
keep the private key off the server:

```sh
age-keygen -o crm-backup-key.txt      # prints the public key, age1...
BACKUP_ENCRYPT_TO=age1...             # in install.env
```

Dumps are then stored as `.dump.age`. **Lose the private key and those backups cannot be
restored.**

## Commands

```sh
docker compose --env-file install.env run --rm backup now       # one backup, now
docker compose --env-file install.env run --rm backup status    # newest, its size, how many
docker compose --env-file install.env run --rm backup list      # every backup kept
docker compose --env-file install.env run --rm backup verify    # download the newest and check it
```

`status` prints, for example:

```text
Backups of install crm.example.com in crm-backups/database/crm.example.com
Last successful backup: 2026-10-12 02:15:04 UTC (7 h 12 min ago)
File: 2026/10/12/crm-20261012T021504Z.dump
Size: 48.3 MiB (50646221 bytes)
Backups kept: 7
Oldest kept: 2026-10-06 02:15:03 UTC
Retention: 7 days; daily at 02:15 UTC
```

Each command exits with a non-zero status when it fails. Nothing prints a password, a key
or a connection string.

## Restore

A restore needs Postgres's superuser, because the dump makes extensions and gives objects
to their roles; the daily backup does not have that password. Pass it for the restore
alone. In the commands below, `$POSTGRES_SUPERUSER_PASSWORD` is your Postgres server's
superuser password (on Coolify, the one the database resource shows).

A named backup can replace `latest`: `restore crm-20261012T021504Z.dump`. The restore
downloads the dump, checks it against its checksum, and loads it in one transaction, so
the database gets the whole backup or stays as it was. It refuses a database that is not
empty.

### Onto a new server

1. Put back `install.env` from your copy: the same passwords, `SECRETS_KEYS`,
   `SECRETS_PUBLIC_KEY`, `AUTH_SECRET` and `FILES_LINK_SECRET` as before.
2. Start the database alone. Its first start makes the roles and an empty `crm` database:

   ```sh
   docker compose --env-file install.env up -d postgres
   ```

3. Restore:

   ```sh
   docker compose --env-file install.env run --rm \
     -e BACKUP_RESTORE_USER=postgres -e BACKUP_RESTORE_PASSWORD="$POSTGRES_SUPERUSER_PASSWORD" \
     backup restore latest
   ```

4. Put the uploaded files back (the `files` volume, or point `FILES_S3_*` at the bucket).
5. Start the rest. `migrate` applies any migration newer than the backup:

   ```sh
   docker compose --env-file install.env up -d
   ```

### Over the database of a running install

To go back to a backup on the same server, stop what uses the database, then restore with
`--force`. It drops the `crm` database and makes it again from the backup, with its
grants. It refuses while anything is still connected, and changes nothing then.

```sh
docker compose --env-file install.env stop app worker
docker compose --env-file install.env run --rm \
  -e BACKUP_RESTORE_USER=postgres -e BACKUP_RESTORE_PASSWORD="$POSTGRES_SUPERUSER_PASSWORD" \
  backup restore latest --force
docker compose --env-file install.env up -d
```

Unlike the restore into an empty database, this one is not a single transaction: if it
stops part way, the database is incomplete, and you run it again. Everything written since
the backup was taken is lost.

### An encrypted backup

Mount the private key and name it:

```sh
docker compose --env-file install.env run --rm \
  -v /path/to/crm-backup-key.txt:/keys/key.txt:ro -e BACKUP_DECRYPT_IDENTITY_FILE=/keys/key.txt \
  -e BACKUP_RESTORE_USER=postgres -e BACKUP_RESTORE_PASSWORD="$POSTGRES_SUPERUSER_PASSWORD" \
  backup restore latest
```

## Test a restore

A backup that has never been restored is a hope. Once a month, and after any Postgres
upgrade, restore the newest backup into a scratch database beside the live one, look at
it, and drop it. The live database is not touched.

```sh
docker compose --env-file install.env exec postgres \
  psql -U postgres -c 'create database crm_restore_test owner crm_owner template template0'

docker compose --env-file install.env run --rm \
  -e BACKUP_RESTORE_USER=postgres -e BACKUP_RESTORE_PASSWORD="$POSTGRES_SUPERUSER_PASSWORD" \
  -e BACKUP_RESTORE_DATABASE=crm_restore_test backup restore latest

# Compare with the live database: the same numbers are expected, give or take the day's work.
docker compose --env-file install.env exec postgres \
  psql -U postgres -d crm_restore_test -c 'select count(*) from crm.contacts'

docker compose --env-file install.env exec postgres \
  psql -U postgres -c 'drop database crm_restore_test'
```

## How it is tested

`bash backup/test/run.sh` runs the whole thing on Docker: a Postgres 18 with the install's
bootstrap, every migration and a few rows; MinIO as the storage; a backup; the stored
dump against its checksum; a restore into a second, empty database with every table's row
count and the schema compared; the refusals; retention; a wrong storage secret and a wrong
database password; the schedule; the health check; and encryption.

## Limits

- A dump is written to the container's disk before it is uploaded, so the server needs
  free space of about the dump's size (a dump is compressed).
- One dump a day means up to a day's work can be lost. Larger installs can add continuous
  WAL archiving later.
- A backup taken on Postgres 18 restores into Postgres 18 or newer, not older.
