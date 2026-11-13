// One-off backfill: trims transparent padding from jewelry component images uploaded before
// trimming existed. Never runs automatically.
//   pnpm images:trim-jewelry            dry run: list each image with its before/after size
//   pnpm images:trim-jewelry --apply    upload the trimmed images and update the database
// With --apply, each trimmed image is uploaded under a new key, the old image is copied to
// originals/ when the component has no production original yet, imageKey is updated (only
// if it has not changed meanwhile), and the old object is deleted after the update succeeds.
// Uses the built services in dist/ (run through the package script, which builds first).
// Never prints credentials.
import 'reflect-metadata';
import 'dotenv/config';
import { buffer as readAll } from 'node:stream/consumers';
import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';

type TrimModule = typeof import('../src/storage/trim-transparent.js');
type StorageModule = typeof import('../src/storage/storage.service.js');
type PrismaModule = typeof import('../src/database/prisma.service.js');

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--apply')) {
  console.error('Usage: pnpm images:trim-jewelry [--apply]');
  process.exit(1);
}
const apply = args.includes('--apply');

const built = (path: string) =>
  import(new URL('../dist/' + path, import.meta.url).href);
const { trimTransparent } = (await built(
  'storage/trim-transparent.js',
)) as TrimModule;
const { StorageService } = (await built(
  'storage/storage.service.js',
)) as StorageModule;
const { PrismaService } = (await built(
  'database/prisma.service.js',
)) as PrismaModule;

const storage = new StorageService(new ConfigService(process.env));
const prisma = new PrismaService();

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

async function dimensions(bytes: Buffer) {
  const { width, height } = await sharp(bytes).metadata();
  return `${width}×${height} (${Math.ceil(bytes.length / 1024)} KB)`;
}

/** Best-effort removal of objects this run uploaded but could not reference. */
async function discard(keys: (string | undefined)[]) {
  for (const key of keys)
    if (key)
      await storage.delete(key).catch(() => {
        console.error(`  needs manual cleanup: ${key}`);
      });
}

let failed = 0;
let changed = 0;
try {
  await prisma.$connect();
  const components = await prisma.subCategory.findMany({
    where: { imageKey: { not: null }, category: { builderType: 'JEWELRY' } },
    select: { id: true, name: true, imageKey: true, originalImageKey: true },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
  console.log(
    `${components.length} jewelry component image(s)` +
      (apply ? '' : ' (dry run: nothing is changed; pass --apply to write)'),
  );
  for (const component of components) {
    const oldKey = component.imageKey!;
    const label = `${component.name} [${component.id}] ${oldKey}`;
    try {
      const object = await storage.download(oldKey);
      const bytes = await readAll(object.body);
      const extension = oldKey.slice(oldKey.lastIndexOf('.')).toLowerCase();
      const file = {
        fieldname: 'file',
        originalname: oldKey.slice(oldKey.lastIndexOf('/') + 1),
        mimetype: MIME_TYPES[extension] ?? object.contentType ?? '',
        buffer: bytes,
        size: bytes.length,
      } as Express.Multer.File;
      const trimmed = await trimTransparent(file);
      if (trimmed === file) {
        console.log(`- ${label}: ${await dimensions(bytes)}, already tight`);
        continue;
      }
      console.log(
        `* ${label}: ${await dimensions(bytes)} → ${await dimensions(trimmed.buffer)}`,
      );
      changed++;
      if (!apply) continue;

      let newKey: string | undefined;
      let originalKey: string | undefined;
      try {
        newKey = (await storage.upload(trimmed, 'subcategories')).key;
        if (!component.originalImageKey)
          originalKey = (await storage.copy(oldKey, 'originals')).key;
        // Only if no one replaced the image while this ran.
        const { count } = await prisma.subCategory.updateMany({
          where: { id: component.id, imageKey: oldKey },
          data: {
            imageKey: newKey,
            ...(originalKey ? { originalImageKey: originalKey } : {}),
          },
        });
        if (count !== 1) throw new Error('image changed meanwhile; skipped');
      } catch (error) {
        await discard([newKey, originalKey]);
        throw error;
      }
      console.log(
        `  updated: ${newKey}` +
          (originalKey ? `, original kept as ${originalKey}` : ''),
      );
      await storage.delete(oldKey).catch(() => {
        console.error(
          `  database updated; old object needs cleanup: ${oldKey}`,
        );
      });
    } catch (error) {
      failed++;
      // Service errors are already sanitised; never print SDK internals.
      console.error(
        `! ${label}: ${error instanceof Error ? error.message : 'failed'}`,
      );
    }
  }
  console.log(
    `${changed} image(s) ${apply ? 'trimmed' : 'would be trimmed'}, ${failed} failed.`,
  );
} finally {
  await prisma.$disconnect();
  storage.onModuleDestroy();
}
if (failed) process.exitCode = 1;
