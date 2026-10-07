import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getRegion } from '@cs/regions';
import type { Env } from '../env.js';

/** Where uploaded files live. Keys look like `<tenantId>/<purpose>/<uuid>`; the bytes never go through the database. */
export interface BlobStore {
  readonly kind: 'memory' | 'local' | 's3';
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

export class MemoryStore implements BlobStore {
  readonly kind = 'memory' as const;
  readonly blobs = new Map<string, { body: Buffer; contentType: string }>();
  async put(key: string, body: Buffer, contentType: string) { this.blobs.set(key, { body, contentType }); }
  async get(key: string) { return this.blobs.get(key)?.body ?? null; }
  async delete(key: string) { this.blobs.delete(key); }
}

/** A folder on this server. Development only: production refuses it (see env.ts). */
export class LocalStore implements BlobStore {
  readonly kind = 'local' as const;
  constructor(private dir: string) {}
  private file(key: string) {
    const p = path.resolve(this.dir, key);
    if (!p.startsWith(path.resolve(this.dir) + path.sep)) throw new Error('bad storage key');
    return p;
  }
  async put(key: string, body: Buffer) { const f = this.file(key); await mkdir(path.dirname(f), { recursive: true }); await writeFile(f, body); }
  async get(key: string) { try { return await readFile(this.file(key)); } catch (e: any) { if (e?.code === 'ENOENT') return null; throw e; } }
  async delete(key: string) { await rm(this.file(key), { force: true }); }
}

export class S3Store implements BlobStore {
  readonly kind = 's3' as const;
  constructor(private bucket: string, private client: Pick<S3Client, 'send'>) {}
  async put(key: string, body: Buffer, contentType: string) {
    // Encrypted at rest by S3 itself; the bucket also enforces this (see infra/terraform).
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: 'AES256' }));
  }
  async get(key: string) {
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return Buffer.from(await out.Body!.transformToByteArray());
    } catch (e: any) {
      if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }
  async delete(key: string) { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })); }
}

export function createStore(env: Env): BlobStore {
  if (env.STORAGE_DRIVER === 's3') {
    // The region is the deployment's own data region unless it was set explicitly (env.ts already checked they agree).
    const region = env.FILES_REGION ?? getRegion(env.DEPLOY_REGION).dataRegion;
    return new S3Store(env.FILES_BUCKET!, new S3Client({ region, ...(env.FILES_ENDPOINT && { endpoint: env.FILES_ENDPOINT, forcePathStyle: true }) }));
  }
  return new LocalStore(env.FILES_LOCAL_DIR);
}
