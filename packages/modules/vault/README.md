# packages/modules/vault

The secrets vault: providers'
passwords, tokens and keys, sealed for the worker with HPKE (RFC 9180: X25519,
HKDF-SHA256, AES-256-GCM). It owns `vault.secrets`.

The app seals and can't open; only the worker opens:

```ts
// The app role: SECRETS_PUBLIC_KEY.
const vault = await createSealingVault(parseSecretsPublicKey(env.SECRETS_PUBLIC_KEY));
const id = await vault.store(trx, { agencyId, businessId, purpose: 'mailbox.password' }, password);
await vault.replace(trx, id, newPassword);
await vault.remove(trx, id);

// The worker: SECRETS_KEYS, the current key first.
const vault = await createVault(parseSecretsKeys(env.SECRETS_KEYS));
const password = await vault.read(trx, id, 'mailbox.password'); // the purpose expected
const report = await vault.rotate(db, { batchSize: 100 });
```

- **Each call works in the caller's transaction**, so row-level security keeps it to the
  caller's tenant. A secret another business holds is `NotFoundError`.
- **`read` takes the purpose it expects.** A secret for another purpose is `NotFoundError`,
  so a reference to the wrong kind of secret, such as a mailbox password named as an AI
  key, gets nothing.
- **A sealed secret is bound to its row.** Its id, agency, business and purpose are the
  AEAD's associated data. A changed byte, or a sealed secret moved to another row, business,
  agency or purpose, fails to open with `SecretUnreadableError` (`reason: 'tampered'`), as
  do bytes that aren't text. One sealed under a key the worker no longer holds fails with
  `reason: 'unknown_key_version'`. `crm_app` may rewrite only a row's sealed bytes.
- **`createSealingVault` seals once to check its key**, and the server builds its vault at
  start, so a key that can't be used stops the start rather than the first save.
- **`rotate`** re-seals every secret sealed under an older key with the current one:
  - it refuses to start when secrets are sealed under a newer key than the current one;
  - it lists them across tenants through `private.secrets_to_rotate`, which returns ids only;
  - it re-seals each one in its own transaction and tenant, with the row locked, so a
    secret changed meanwhile keeps its new value;
  - it reports the secrets it couldn't open, which keep their old key, and goes on;
  - it reports how many are still under an older key when it ends (`remaining`), counted
    through `private.secret_key_versions`, such as one an app still on the old public key
    sealed meanwhile.

  The server runs it as `node dist/vault.js rotate`
  ([apps/server](../../../apps/server/README.md)).
- **Keys** are 32 bytes in base64url, each with a version from 1 to 32767 and its kind:
  `SECRETS_KEYS=2:private-<key>,1:private-<key>` and `SECRETS_PUBLIC_KEY=2:public-<key>`.
  `newSecretsKey` makes a pair. A malformed setting, or a key of the other kind, is
  `SecretsKeyError`, whose message never repeats a key.
- **A secret** is 1 to 64 KiB of UTF-8.

```bash
pnpm --filter @repo/module-vault test              # keys, sealing and opening
pnpm --filter @repo/module-vault test:integration  # storing, tampering and rotation, against Postgres
```
