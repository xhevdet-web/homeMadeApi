import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { StorageService } from './storage.service.js';
import { ImageWriteService } from './image-write.service.js';

describe('Image write failure handling', () => {
  const storage = new StorageService(new ConfigService());
  const images = new ImageWriteService(storage);
  const file = {} as Express.Multer.File;
  const upload = vi.spyOn(storage, 'upload');
  const remove = vi.spyOn(storage, 'delete');
  const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  beforeEach(() => {
    upload.mockReset().mockResolvedValue({ key: 'products/new.png' });
    remove.mockReset().mockResolvedValue();
    log.mockClear();
  });
  it('does not write to DB when upload fails', async () => {
    upload.mockRejectedValue(new Error('upload failed'));
    const write = vi.fn();
    await expect(images.save(file, 'products', write)).rejects.toThrow(
      'upload failed',
    );
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
  it('retains original DB error and logs failed compensating cleanup without leaking SDK errors', async () => {
    remove.mockRejectedValue(new Error('secret-sdk-detail'));
    await expect(
      images.save(file, 'products', () =>
        Promise.reject(new Error('DB error')),
      ),
    ).rejects.toThrow('DB error');
    expect(remove).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.flat().join(' ')).toContain('products/new.png');
    expect(log.mock.calls.flat().join(' ')).not.toContain('secret-sdk-detail');
  });
  it('retries transient old image cleanup and keeps the new image', async () => {
    remove.mockRejectedValueOnce(new Error('transient'));
    const result = await images.save(file, 'products', async () => ({
      result: 'saved',
      oldKeys: ['products/old.png'],
    }));
    expect(result).toBe('saved');
    expect(remove.mock.calls).toEqual([
      ['products/old.png'],
      ['products/old.png'],
    ]);
  });
  it('reports committed DB operation if postcommit cleanup fails and tries every object', async () => {
    remove.mockRejectedValue(new Error('private-sdk-detail'));
    try {
      await images.save(file, 'products', async () => ({
        result: 'saved',
        oldKeys: ['products/old.png', 'products/other.png'],
      }));
      expect.fail('Expected cleanup error');
    } catch (error) {
      expect(error).toMatchObject({ response: { databaseCommitted: true } });
    }
    expect(remove).toHaveBeenCalledTimes(4);
    expect(remove).not.toHaveBeenCalledWith('products/new.png');
  });
  it('deduplicates keys and ignores missing keys', async () => {
    await images.cleanup([
      null,
      undefined,
      '',
      'products/a.png',
      'products/a.png',
    ]);
    expect(remove).toHaveBeenCalledExactlyOnceWith('products/a.png');
  });

  it('cleans the first upload when the second upload fails', async () => {
    upload
      .mockResolvedValueOnce({ key: 'products/new.png' })
      .mockRejectedValueOnce(new Error('preview upload failed'));
    const write = vi.fn();
    await expect(
      images.saveMany(
        [
          { file, folder: 'products' },
          { file, folder: 'designs' },
        ],
        write,
      ),
    ).rejects.toThrow('preview upload failed');
    expect(write).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledExactlyOnceWith('products/new.png');
  });

  it('cleans both uploads when the database write fails', async () => {
    upload.mockResolvedValueOnce({ key: 'products/new.png' });
    upload.mockResolvedValueOnce({ key: 'designs/new.png' });
    await expect(
      images.saveMany(
        [
          { file, folder: 'products' },
          { file, folder: 'designs' },
        ],
        () => Promise.reject(new Error('database failed')),
      ),
    ).rejects.toThrow('database failed');
    expect(remove.mock.calls).toEqual([
      ['products/new.png'],
      ['designs/new.png'],
    ]);
  });

  it('does not delete newly referenced images when old-image cleanup fails', async () => {
    upload.mockResolvedValueOnce({ key: 'products/new.png' });
    upload.mockResolvedValueOnce({ key: 'designs/new.png' });
    remove.mockRejectedValue(new Error('old object unavailable'));
    await expect(
      images.saveMany(
        [
          { file, folder: 'products' },
          { file, folder: 'designs' },
        ],
        async () => ({
          result: 'saved',
          oldKeys: ['products/old.png', 'designs/old.png'],
        }),
      ),
    ).rejects.toMatchObject({ response: { databaseCommitted: true } });
    expect(remove).not.toHaveBeenCalledWith('products/new.png');
    expect(remove).not.toHaveBeenCalledWith('designs/new.png');
  });
});
