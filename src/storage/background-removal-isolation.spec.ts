import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('..', import.meta.url));

async function sources(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!['background-worker', 'generated'].includes(entry.name))
        files.push(...(await sources(path)));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts'))
      files.push(path);
  }
  return files;
}

// The OOM incident came from running ONNX inference inside the API. Keep it out for good.
describe('API process isolation from background-removal inference', () => {
  it('no API source imports onnxruntime-node or the worker', async () => {
    const offenders: string[] = [];
    for (const file of await sources(src)) {
      const text = await readFile(file, 'utf8');
      if (
        /from\s+['"]onnxruntime-node['"]|import\(\s*['"]onnxruntime-node/.test(
          text,
        ) ||
        /from\s+['"][./]*background-worker\//.test(text)
      )
        offenders.push(relative(src, file).split(sep).join('/'));
    }
    expect(offenders).toEqual([]);
  });
});
