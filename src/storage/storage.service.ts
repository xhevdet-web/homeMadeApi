import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { validateImage } from './image-validation.js';
import { BackgroundRemovalService } from './background-removal.service.js';

// Only entity display images can opt in to background removal.
const BACKGROUND_REMOVAL_FOLDERS = ['categories', 'subcategories', 'products'];

@Injectable()
export class StorageService implements OnModuleDestroy {
  private client?: S3Client;
  private bucket?: string;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(BackgroundRemovalService)
    private readonly backgroundRemoval: BackgroundRemovalService = new BackgroundRemovalService(
      config,
    ),
  ) {}

  /** True only for an explicit `removeBackground: true` while BACKGROUND_REMOVAL_ENABLED is on. */
  removesBackground(requested: unknown): boolean {
    return this.backgroundRemoval.shouldRemove(requested);
  }

  private connection() {
    if (!this.client) {
      const endpoint = this.config.get<string>('R2_ENDPOINT')?.trim();
      const accessKeyId = this.config.get<string>('R2_ACCESS_KEY_ID')?.trim();
      const secretAccessKey = this.config
        .get<string>('R2_SECRET_ACCESS_KEY')
        ?.trim();
      const bucket = this.config.get<string>('R2_BUCKET_NAME')?.trim();
      if (!endpoint || !accessKeyId || !secretAccessKey || !bucket)
        throw new ServiceUnavailableException(
          'Image storage is not configured',
        );
      try {
        const url = new URL(endpoint);
        if (
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error('Invalid endpoint');
        this.client = new S3Client({
          region: 'auto',
          endpoint,
          credentials: { accessKeyId, secretAccessKey },
          maxAttempts: 2,
        });
        this.bucket = bucket;
      } catch {
        throw new ServiceUnavailableException(
          'Image storage is not configured correctly',
        );
      }
    }
    return { client: this.client, bucket: this.bucket! };
  }

  async upload(
    file: Express.Multer.File,
    folder = 'uploads',
    // Opt-in: only true sends the image to the background-removal worker. When the feature
    // is disabled the upload is stored unchanged and no model is ever involved.
    removeBackground = false,
  ): Promise<{ key: string }> {
    validateImage(file);
    if (
      folder.length > 200 ||
      !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(folder)
    )
      throw new BadRequestException('Invalid storage folder');
    // Runs before any R2 write, so a failed or timed-out job leaves nothing to clean up.
    if (removeBackground && BACKGROUND_REMOVAL_FOLDERS.includes(folder))
      file = await this.backgroundRemoval.remove(file);
    const extension = validateImage(file);
    const key = folder + '/' + randomUUID() + extension;
    const { client, bucket } = this.connection();
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype,
        }),
        { abortSignal: AbortSignal.timeout(15000) },
      );
    } catch {
      // Never return or log SDK errors: they may include request/configuration details.
      throw new ServiceUnavailableException(
        'Image upload failed; please try again',
      );
    }
    return { key };
  }

  async delete(key: string): Promise<void> {
    if (
      typeof key !== 'string' ||
      key.length > 512 ||
      !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.(?:png|jpe?g|webp)$/.test(key)
    )
      throw new BadRequestException('Invalid image object key');
    const { client, bucket } = this.connection();
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), {
        abortSignal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new ServiceUnavailableException(
        'Image deletion failed; please try again',
      );
    }
  }

  async copy(key: string, folder: string): Promise<{ key: string }> {
    if (
      typeof key !== 'string' ||
      key.length > 512 ||
      !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.(?:png|jpe?g|webp)$/.test(key) ||
      folder.length > 200 ||
      !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(folder)
    )
      throw new BadRequestException('Invalid image object key or folder');
    const extension = key.slice(key.lastIndexOf('.'));
    const destination = folder + '/' + randomUUID() + extension;
    const { client, bucket } = this.connection();
    try {
      await client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          Key: destination,
          CopySource:
            encodeURIComponent(bucket) +
            '/' +
            key.split('/').map(encodeURIComponent).join('/'),
        }),
        { abortSignal: AbortSignal.timeout(15000) },
      );
    } catch {
      throw new ServiceUnavailableException(
        'Image copy failed; please try again',
      );
    }
    return { key: destination };
  }

  async download(key: string): Promise<{
    body: Readable;
    contentType?: string;
    contentLength?: number;
  }> {
    if (
      typeof key !== 'string' ||
      key.length > 512 ||
      !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.(?:png|jpe?g|webp)$/.test(key)
    )
      throw new BadRequestException('Invalid image object key');
    const { client, bucket } = this.connection();
    try {
      const object = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(15000) },
      );
      if (!object.Body || typeof (object.Body as Readable).pipe !== 'function')
        throw new Error('Image body unavailable');
      return {
        body: object.Body as Readable,
        contentType: object.ContentType,
        contentLength: object.ContentLength,
      };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new ServiceUnavailableException(
        'Image retrieval failed; please try again',
      );
    }
  }

  /**
   * Public images are delivered straight from R2 (or the CDN in front of it) whenever
   * R2_PUBLIC_URL is configured. IMAGE_PROXY_URL is an optional fallback for deployments
   * without a public bucket URL; it routes images through the API's /images endpoint.
   */
  getPublicUrl(key?: string | null): string | null {
    if (!key) return null;
    return this.directUrl(key) ?? this.proxyUrl(key);
  }

  private directUrl(key: string): string | null {
    const base = this.config.get<string>('R2_PUBLIC_URL')?.trim();
    if (!base) return null;
    try {
      const url = new URL(base);
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        return null;
      return (
        base.replace(/\/+$/, '') +
        '/' +
        key.split('/').map(encodeURIComponent).join('/')
      );
    } catch {
      return null;
    }
  }

  private proxyUrl(key: string): string | null {
    const proxy = this.config.get<string>('IMAGE_PROXY_URL')?.trim();
    if (!proxy) return null;
    try {
      const url = new URL(proxy);
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.username ||
        url.password
      )
        return null;
      url.searchParams.set('key', key);
      return url.toString();
    } catch {
      return null;
    }
  }

  onModuleDestroy() {
    this.client?.destroy();
  }
}
