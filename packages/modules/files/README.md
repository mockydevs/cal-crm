# packages/modules/files

The files service: uploads
checked and stored, and signed links to read them. It owns `files.files`. The bytes live in
a storage backend from [`@repo/storage`](../../adapters/storage/), under each file's id.

```ts
const files = createFiles({
  storage, // localStorage(...) or s3Storage(...)
  uploadDirectory: '/tmp/crm-uploads', // where uploads wait while they're checked
  maxBytes: 25 * 1024 * 1024,
  linkSecret, // FILES_LINK_SECRET
});

const file = await files.upload(services, invocation, { body, contentType, filename });
const { path, expiresAt } = await files.link(services, invocation, file.id, { seconds: 3600 });
const opened = await files.open(db, { fileId, query, now: new Date(), correlationId });
```

- **`upload`** reads the body into a temporary file, stopping at `maxBytes` with
  `ContentTooLargeError` (413), then runs **`file.create`**. The command:
  - checks the type from the file's first bytes. PNG, JPEG, GIF, WebP and PDF must start
    with their signature, plain text and CSV are allowed as they are, and everything
    else, SVG and HTML included, is refused;
  - hashes the file;
  - records the row and stores the bytes in one transaction, the bytes last.

  A file belongs to the uploader's business, or to the agency when agency staff have no
  business selected.
- **`link`** signs a link to a file the caller can see, lasting from a second to seven
  days. It's a path under the API's base: `/files/{id}/content?agency=…&business=…&expires=…&signature=…`.
- **`open`** checks a link's signature in constant time, then its expiry. Then it reads
  the file in the scope the link names, so row-level security keeps every link to its own
  agency or business. A deleted file can't be opened. A link that's been altered,
  pointed at another file, or widened to the agency's scope is refused.

**`fileRoutes(files, { apiUrl })`** gives the server its API routes:
- `uploadFile` (`POST /files?filename=…`) refuses a stated `Content-Length` over the limit
  before reading a byte, then streams the rest through `upload`;
- `createFileLink` (`POST /files/{id}/links`) answers with an absolute link under `apiUrl`.

The server serves the link itself (`GET /files/{id}/content`), through `open`, outside the
session check.

`checkBusinessLogo(trx, businessId, fileId)` validates a live raster image belonging to
that exact business inside a caller's tenant transaction. Business Settings uses it
before assigning a logo; agency-shared files, foreign files and non-images are refused.

```bash
pnpm --filter @repo/module-files test               # links, types and receiving
pnpm --filter @repo/module-files test:integration   # the service, against Postgres in Docker
```

## The media library

A business's library is a
view over `files.files`. A file is in it when it was uploaded there
(`upload(…, { library: { folderId } })`, or `POST /files?library=true&folder=…`), which needs
`media.manage` as well as `files.upload`. Nothing here lists the storage backend: the rows
are the truth.

```ts
const media = createMedia({
  storage,
  linkSecret,
  maxBytes,
  businessQuotaBytes, // FILES_BUSINESS_QUOTA_BYTES, or undefined for no limit
  publicUrl, // PUBLIC_URL
  servesPublic, // whether this install answers /m/<key>/<name>
});
```

- **`list`, `read`, `usage`, `folderList`** read under row-level security, in the
  caller's business: a page of files by folder, search, type group and sort, with a cursor;
  one file with where it is used; what the library and the business hold.
- **`commands.update`** renames a file and gives it, or takes away, its public address;
  **`commands.move`** and **`commands.remove`** take up to a hundred files and change all
  of them or none. A delete is refused while the file is used (`files.file_usage`), and
  removes the object from storage as its last step.
- **`folders`** creates, renames, moves and removes folders, under one lock.
- **`findPublic`** and **`findPreview`** find the file a public address or a signed
  preview address names, for the server's `/m` routes; `rangeOf` reads a Range header.

**`mediaRoutes(media)`** gives the server the `/media` and `/media-folders` routes. Types
grew with the library: MP4 and WebM video and MP3, WAV, Ogg and M4A sound are stored too,
each checked against its signature.
