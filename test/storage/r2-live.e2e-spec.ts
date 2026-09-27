import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { StorageService } from '../../src/storage/storage.service.js';

// Explicit opt-in: creates UUID test objects and deletes only those objects.
describe.skipIf(process.env.RUN_R2_LIVE_TESTS !== '1')(
  'Live R2 connection',
  () => {
    it('uploads and copies a PNG, verifies the copy survives source deletion, then cleans both', async () => {
      const config = new ConfigService();
      const storage = new StorageService(config);
      let key: string | undefined;
      let copyKey: string | undefined;
      let verifier: S3Client | undefined;
      try {
        const buffer = Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMioAAAAASUVORK5CYII=',
          'base64',
        );
        ({ key } = await storage.upload(
          {
            buffer,
            size: buffer.length,
            mimetype: 'image/png',
            originalname: 'connection-test.png',
          } as Express.Multer.File,
          'test',
        ));
        verifier = new S3Client({
          region: 'auto',
          endpoint: config.getOrThrow<string>('R2_ENDPOINT'),
          credentials: {
            accessKeyId: config.getOrThrow<string>('R2_ACCESS_KEY_ID'),
            secretAccessKey: config.getOrThrow<string>('R2_SECRET_ACCESS_KEY'),
          },
          maxAttempts: 1,
        });
        const command = new HeadObjectCommand({
          Bucket: config.getOrThrow<string>('R2_BUCKET_NAME'),
          Key: key,
        });
        let metadata;
        try {
          metadata = await verifier.send(command, {
            abortSignal: AbortSignal.timeout(15000),
          });
        } catch {
          throw new Error(
            'R2 upload verification failed (upstream details withheld)',
          );
        }
        expect(metadata.ContentLength).toBe(buffer.length);
        expect(metadata.ContentType).toBe('image/png');
        ({ key: copyKey } = await storage.copy(key, 'test'));
        await storage.delete(key);
        try {
          const copiedMetadata = await verifier.send(
            new HeadObjectCommand({
              Bucket: config.getOrThrow<string>('R2_BUCKET_NAME'),
              Key: copyKey,
            }),
            { abortSignal: AbortSignal.timeout(15000) },
          );
          expect(copiedMetadata.ContentLength).toBe(buffer.length);
          expect(copiedMetadata.ContentType).toBe('image/png');
        } catch {
          throw new Error(
            'R2 copy verification failed (upstream details withheld)',
          );
        }
        let missing = false;
        try {
          await verifier.send(command, {
            abortSignal: AbortSignal.timeout(15000),
          });
        } catch (error) {
          missing =
            (error as { $metadata?: { httpStatusCode?: number } }).$metadata
              ?.httpStatusCode === 404;
        }
        expect(missing).toBe(true);
        key = undefined;
      } finally {
        try {
          if (key) await storage.delete(key);
          if (copyKey) await storage.delete(copyKey);
        } finally {
          storage.onModuleDestroy();
          verifier?.destroy();
        }
      }
    }, 60000);
  },
);
