/**
 * Turns whatever the user dropped into a flat list of images, then uploads them.
 * ZIP and PDF files are unpacked here in the browser, so the server only ever
 * receives images, one per request, and a failed upload can be retried alone.
 */
import JSZip from 'jszip';
import * as pdfjs from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import { api } from './api.ts';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif', 'tif', 'tiff', 'dng']);
const PDF_RENDER_DPI = 600;
const UPLOAD_CONCURRENCY = 4;
const UPLOAD_ATTEMPTS = 3;

export interface UploadItem {
  name: string;
  blob: Blob;
}

export interface ExpandResult {
  items: UploadItem[];
  /** Files we could not use, listed for the user rather than silently dropped. */
  skipped: Array<{ name: string; reason: string }>;
}

const extensionOf = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';
const baseName = (path: string) => path.split('/').pop() ?? path;
const isJunk = (path: string) => baseName(path).startsWith('.') || path.includes('__MACOSX/');

async function renderPdf(name: string, blob: Blob): Promise<UploadItem[]> {
  const task = pdfjs.getDocument({ data: await blob.arrayBuffer() });
  const pdf = await task.promise;
  const items: UploadItem[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: PDF_RENDER_DPI / 72 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport }).promise;
    const image = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('Could not render a PDF page.'))), 'image/jpeg', 0.95);
    });
    items.push({ name: `${name} page ${pageNumber}.jpg`, blob: image });
    page.cleanup();
  }
  await task.destroy();
  return items;
}

async function expandOne(name: string, blob: Blob, result: ExpandResult): Promise<void> {
  if (isJunk(name)) return;
  const extension = extensionOf(name);
  try {
    if (IMAGE_EXTENSIONS.has(extension)) {
      result.items.push({ name: baseName(name), blob });
    } else if (extension === 'pdf') {
      result.items.push(...(await renderPdf(baseName(name), blob)));
    } else if (extension === 'zip') {
      const zip = await JSZip.loadAsync(blob);
      for (const entry of Object.values(zip.files)) {
        if (!entry.dir) await expandOne(entry.name, await entry.async('blob'), result);
      }
    } else {
      result.skipped.push({ name: baseName(name), reason: 'Not a supported file type' });
    }
  } catch (error) {
    result.skipped.push({ name: baseName(name), reason: error instanceof Error ? error.message : 'Could not be read' });
  }
}

/** Numbers sort naturally, so card2 comes before card10. This keeps front/back pairs in order. */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export async function expandFiles(files: File[]): Promise<ExpandResult> {
  const result: ExpandResult = { items: [], skipped: [] };
  for (const file of files) await expandOne(file.webkitRelativePath || file.name, file, result);
  result.items.sort((a, b) => byName.compare(a.name, b.name));
  return result;
}

/** Reads a dropped folder recursively. Plain files pass straight through. */
export async function filesFromDrop(items: DataTransferItemList): Promise<File[]> {
  const entries = Array.from(items)
    .map((item) => item.webkitGetAsEntry())
    .filter((entry): entry is FileSystemEntry => entry !== null);

  const walk = async (entry: FileSystemEntry): Promise<File[]> => {
    if (entry.isFile) {
      return [await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))];
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const children: FileSystemEntry[] = [];
    // readEntries returns results in batches, so keep reading until it comes back empty.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (batch.length === 0) break;
      children.push(...batch);
    }
    return (await Promise.all(children.map(walk))).flat();
  };

  return (await Promise.all(entries.map(walk))).flat();
}

export async function uploadAll(
  jobId: string,
  items: UploadItem[],
  onProgress: (done: number, total: number) => void,
): Promise<Array<{ name: string; reason: string }>> {
  const failed: Array<{ name: string; reason: string }> = [];
  let next = 0;
  let done = 0;

  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      for (let attempt = 1; ; attempt += 1) {
        try {
          await api.uploadFile(jobId, item.name, item.blob);
          break;
        } catch (error) {
          if (attempt >= UPLOAD_ATTEMPTS) {
            failed.push({ name: item.name, reason: error instanceof Error ? error.message : 'Upload failed' });
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        }
      }
      done += 1;
      onProgress(done, items.length);
    }
  };

  await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, worker));
  return failed;
}
