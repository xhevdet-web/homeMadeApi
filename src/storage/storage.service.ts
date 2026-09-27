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
} from '@aws-sdk/client-s3';
import { validateImage } from './image-validation.js';

@Injectable()
export class StorageService implements OnModuleDestroy {
  private client?: S3Client;
  private bucket?: string;

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

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
  ): Promise<{ key: string }> {
    const extension = validateImage(file);
    if (
      folder.length > 200 ||
      !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(folder)
    )
      throw new BadRequestException('Invalid storage folder');
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

  getPublicUrl(key?: string | null): string | null {
    const base = this.config.get<string>('R2_PUBLIC_URL')?.trim();
    if (!key || !base) return null;
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

  onModuleDestroy() {
    this.client?.destroy();
  }
}
