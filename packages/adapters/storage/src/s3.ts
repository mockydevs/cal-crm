// Any S3-compatible service, through the AWS SDK.
import { pipeline } from 'node:stream/promises';
import { format } from 'node:util';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { NodeJsClient } from '@smithy/types';

import { checkKey, exactly, type Storage } from './storage.js';

export interface S3StorageOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /**
   * https://endpoint/bucket/key rather than https://bucket.endpoint/key. Most S3-compatible
   * services want it.
   */
  readonly pathStyle: boolean;
  /**
   * Where the SDK's own warnings and errors go, such as the server's logger. Without a
   * logger of its own, the SDK writes some of them straight to the console.
   */
  readonly log: (level: 'warn' | 'error', message: string) => void;
}

export function s3Storage(options: S3StorageOptions): Storage {
  // NodeJsClient is the SDK's own way to say that, on Node, a response body is a stream.
  const client = new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    forcePathStyle: options.pathStyle,
    credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    // S3-compatible services don't all accept the SDK's default CRC32 checksums.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (...content: unknown[]) => {
        options.log('warn', format(...content));
      },
      error: (...content: unknown[]) => {
        options.log('error', format(...content));
      },
    },
  }) as NodeJsClient<S3Client>;
  const Bucket = options.bucket;
  return {
    kind: 's3',
    async put(key, body, { size, contentType }) {
      // A body that fails, or turns out longer or shorter than stated, has to end the
      // request: the SDK would otherwise wait for the rest of it, and never settle.
      const checked = exactly(size);
      const abort = new AbortController();
      let failure: unknown;
      void pipeline(body, checked).catch((error: unknown) => {
        failure = error;
        abort.abort(error);
      });
      try {
        await client.send(
          new PutObjectCommand({
            Bucket,
            Key: checkKey(key),
            Body: checked,
            ContentLength: size,
            ContentType: contentType,
          }),
          { abortSignal: abort.signal },
        );
      } catch (error) {
        // The service can refuse a request before it reads the body, which would otherwise
        // stay open.
        body.destroy();
        checked.destroy();
        throw failure ?? error;
      }
    },
    async get(key, range) {
      try {
        const { Body } = await client.send(
          new GetObjectCommand({
            Bucket,
            Key: checkKey(key),
            // One range a request, first and last byte included (S3 API, GetObject).
            ...(range === undefined
              ? {}
              : { Range: `bytes=${String(range.start)}-${String(range.end)}` }),
          }),
        );
        return Body;
      } catch (error) {
        if (error instanceof NoSuchKey) {
          return undefined;
        }
        throw error;
      }
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: checkKey(key) }));
    },
    close() {
      client.destroy();
      return Promise.resolve();
    },
  };
}
