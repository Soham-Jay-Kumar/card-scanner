import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

/**
 * Write to a temp file, flush, then rename into place, so a crash mid-write can
 * never leave a half image at `target`, and re-running simply replaces it.
 */
export async function writeFileAtomic(target: string, data: Buffer): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

/** File name without folder or extension. Derived names build on it, so they stay deterministic. */
export function stemOf(filePath: string): string {
  return path.parse(filePath).name;
}
