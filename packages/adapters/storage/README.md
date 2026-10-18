# packages/adapters/storage

Where uploaded files' bytes live: local disk or any S3-compatible service, behind one
interface. The files service
records each file's details in `files.files`. This package only stores, reads and deletes
the bytes.

```ts
import { localStorage, s3Storage } from '@repo/storage';

const storage = localStorage({ directory: '/data/files' });
// or, with any S3-compatible service:
const storage = s3Storage({
  endpoint: 'https://s3.eu-central-003.backblazeb2.com',
  region: 'eu-central-003',
  bucket: 'crm-files',
  accessKeyId: '…',
  secretAccessKey: '…',
  pathStyle: true,
  log: (level, message) => logger[level](message),
});

await storage.put(file.id, body, { size, contentType });
const stream = await storage.get(file.id); // undefined when there's nothing under the key
await storage.delete(file.id);
```

## What both backends promise

- **The key is the file's id,** a lower-case UUID. Anything else is refused, so a key can't
  reach outside its place.
- **A body must match its stated size.** A shorter or longer one is refused, and nothing
  is kept. The last chunk waits until the body ends, so a body that runs on, however late,
  never reaches an S3 service in full.
- **`put` owns the body.** It reads the body to its end, or destroys it when the put fails,
  so a file stream passed in is always closed.
- **Reading a missing key gives `undefined`.** Any other failure, such as a request the
  service refuses, is an error.
- **Deleting what isn't there is fine.**

## How each one works

- **`local`** writes to a temporary file in the directory's `.tmp` folder, then renames it
  into place, so a key never holds part of a body. Files are spread over 256 folders by
  the last two digits of their ids. A process killed mid-write can leave a file in `.tmp`;
  nothing refers to it, so it's safe to delete.
- **`s3`** uses the AWS SDK, with two settings:
  - it sends checksums only when an operation requires them, because S3-compatible
    services don't all accept the SDK's default CRC32 checksums;
  - it aborts an upload whose body fails partway, since the SDK would otherwise wait for
    the rest of the body forever.

  The SDK's own warnings go to `log`, not to the console.

## Tests

```bash
pnpm --filter @repo/storage test:integration   # both backends; S3 against Garage in Docker
```

Every test runs against both backends, so they keep the same promises.
