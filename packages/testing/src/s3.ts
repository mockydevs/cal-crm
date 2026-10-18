// A throwaway S3-compatible server for tests: Garage, one node, one key and one bucket.
// MinIO's open-source repository is archived, and Garage's image is small.
import { randomBytes } from 'node:crypto';

import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

const IMAGE = 'dxflrs/garage:v2.4.1';
const S3_PORT = 3900;

/** Where the server is and how to sign in. Plain data, for Vitest's provide and inject. */
export interface S3Server {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

async function garage(container: StartedTestContainer, ...args: string[]): Promise<string> {
  const { exitCode, output, stdout } = await container.exec(['/garage', ...args]);
  if (exitCode !== 0) {
    throw new Error(`garage ${args.join(' ')} failed:\n${output}`);
  }
  return stdout;
}

/** Starts Garage, ready for S3 requests to one bucket. */
export async function startS3(
  options: { bucket?: string } = {},
): Promise<{ server: S3Server; stop: () => Promise<void> }> {
  const region = 'garage';
  const config = [
    'metadata_dir = "/var/lib/garage/meta"',
    'data_dir = "/var/lib/garage/data"',
    'db_engine = "sqlite"',
    'replication_factor = 1',
    'rpc_bind_addr = "[::]:3901"',
    'rpc_public_addr = "127.0.0.1:3901"',
    `rpc_secret = "${randomBytes(32).toString('hex')}"`,
    '',
    '[s3_api]',
    `s3_region = "${region}"`,
    `api_bind_addr = "[::]:${String(S3_PORT)}"`,
    'root_domain = ".s3.garage.localhost"',
    '',
  ].join('\n');
  const container = await new GenericContainer(IMAGE)
    .withCopyContentToContainer([{ content: config, target: '/etc/garage.toml' }])
    .withExposedPorts(S3_PORT)
    .withWaitStrategy(Wait.forLogMessage(/S3 API server listening/))
    .start();
  try {
    // Garage's key ids are GK and 24 hex digits; its secrets are 64 hex digits.
    const accessKeyId = `GK${randomBytes(12).toString('hex')}`;
    const secretAccessKey = randomBytes(32).toString('hex');
    const bucket = options.bucket ?? 'test';
    // "<node id>@<address>"
    const nodeId = (await garage(container, 'node', 'id', '-q')).trim().split('@', 1).join('');
    await garage(container, 'layout', 'assign', '-z', 'dc1', '-c', '1G', nodeId);
    await garage(container, 'layout', 'apply', '--version', '1');
    await garage(container, 'key', 'import', '--yes', '-n', 'test', accessKeyId, secretAccessKey);
    await garage(container, 'bucket', 'create', bucket);
    await garage(
      container,
      'bucket',
      'allow',
      '--read',
      '--write',
      '--owner',
      bucket,
      '--key',
      'test',
    );
    return {
      server: {
        endpoint: `http://${container.getHost()}:${String(container.getMappedPort(S3_PORT))}`,
        region,
        bucket,
        accessKeyId,
        secretAccessKey,
      },
      stop: async () => {
        await container.stop();
      },
    };
  } catch (error) {
    await container.stop();
    throw error;
  }
}
