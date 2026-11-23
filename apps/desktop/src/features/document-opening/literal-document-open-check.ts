import { resolveFilePathWithFallback } from '../../hooks/resolveFilePath';
import { platform } from '../../platform';
import { DocumentReadError } from '../../shared/document-read-failure';
import type { TabularParseResult, TabularPreview } from '../../shared/tabular-file';
import type { PdfLoadTask } from '../pdf/runtime';
import { createImageFileUrl, decodeImageFileUrl, readImageFileBytes } from './image-file-content';
import type { LiteralDocumentKind, LiteralOpenSnapshot } from './literal-open-snapshot';

export type { LiteralDocumentKind, LiteralOpenSnapshot } from './literal-open-snapshot';

export async function inspectLiteralDocument(
  kind: LiteralDocumentKind,
  path: string
): Promise<void> {
  if (kind === 'pdf') return inspectPdfBytes(await platform().fs.readFile(path));
  await readLiteralDocument(kind, path);
}

export async function readLiteralDocument(
  kind: LiteralDocumentKind,
  path: string
): Promise<LiteralOpenSnapshot> {
  switch (kind) {
    case 'pdf': {
      const bytes = await platform().fs.readFile(path);
      // PDF.js owns its input and can transfer the buffer to its worker.
      await inspectPdfBytes(new Uint8Array(bytes));
      return { kind, bytes };
    }
    case 'image':
      return { kind, bytes: await readImage(path) };
    case 'table':
      return readTable(resolveFilePathWithFallback(path));
    case 'html':
      return { kind, text: await platform().fs.readTextFile(resolveFilePathWithFallback(path)) };
  }
}

async function inspectPdfBytes(bytes: Uint8Array): Promise<void> {
  const hasPdfHeader = /%PDF-\d\.\d/.test(new TextDecoder().decode(bytes.subarray(0, 1024)));
  let task: PdfLoadTask;
  try {
    const { beginPdfLoad } = await import('../pdf/runtime');
    task = beginPdfLoad(bytes);
  } catch (cause) {
    throw new DocumentReadError('runtime', hasPdfHeader, { cause });
  }

  const readFirstPage = async () => {
    const document = await task.result;
    if (!Number.isInteger(document.numPages) || document.numPages < 1)
      throw new DocumentReadError('malformed', true);
    const page = await document.getPage(1);
    const { width, height } = page.getViewport({ scale: 1 });
    if (![width, height].every((value) => Number.isFinite(value) && value > 0))
      throw new DocumentReadError('malformed', true);
    await page.getOperatorList();
  };

  try {
    await Promise.race([
      task.workerFailure.then((cause) => {
        throw new DocumentReadError('runtime', hasPdfHeader, { cause });
      }),
      readFirstPage(),
    ]);
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'PasswordException')
      throw new DocumentReadError('password', true, { cause });
    if (cause instanceof Error && cause.name === 'InvalidPDFException')
      throw new DocumentReadError('malformed', hasPdfHeader, { cause });
    throw cause;
  } finally {
    await task.destroy().catch(() => {});
  }
}

async function readImage(path: string): Promise<Uint8Array> {
  const bytes = await readImageFileBytes(path);
  let url: string | undefined;
  let decoded: Awaited<ReturnType<typeof decodeImageFileUrl>>;
  try {
    url = createImageFileUrl(bytes, path);
    decoded = await decodeImageFileUrl(url);
  } catch (cause) {
    throw new DocumentReadError('runtime', false, { cause });
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
  if (decoded === 'decoded') return bytes;
  if (decoded === 'invalid-size') throw new DocumentReadError('malformed', true);
  if (hasTiffDirectory(bytes)) throw new DocumentReadError('unsupported-format', true);
  if (bytes.byteLength < 8) throw new DocumentReadError('malformed');
  throw new DocumentReadError('unknown');
}

function hasTiffDirectory(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 14) return false;
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const byteOrder = data.getUint16(0);
  if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) return false;
  const littleEndian = byteOrder === 0x4949;
  if (data.getUint16(2, littleEndian) !== 42) return false;
  const directory = data.getUint32(4, littleEndian);
  if (directory < 8 || directory + 6 > bytes.byteLength) return false;
  const entries = data.getUint16(directory, littleEndian);
  return entries > 0 && directory + 6 + entries * 12 <= bytes.byteLength;
}

async function readTable(path: string): Promise<Extract<LiteralOpenSnapshot, { kind: 'table' }>> {
  const { delimiterForPath, readDelimitedTablePreview, readWorkbookPreview } =
    await import('./tabular-file-read');
  const { delimiter, isXlsx } = delimiterForPath(path);
  if (isXlsx) {
    const preview = await readWorkbookPreview(path);
    assertReadableTablePreview(preview);
    return { kind: 'table', format: 'workbook', preview };
  }
  if (!delimiter) throw new DocumentReadError('unsupported-format');
  const preview = await readDelimitedTablePreview(path, delimiter);
  assertReadableTablePreview(preview);
  return { kind: 'table', format: 'delimited', delimiter, preview };
}

function assertReadableTablePreview(
  preview: { parsed: TabularParseResult } | null
): asserts preview is { parsed: TabularPreview } {
  if (!preview) throw new DocumentReadError('unsupported-format');
  if (!preview.parsed.ok) {
    const cause = new Error(preview.parsed.error);
    if ('passwordProtected' in preview.parsed && preview.parsed.passwordProtected)
      throw new DocumentReadError('password', true, { cause });
    throw new DocumentReadError('malformed', false, { cause });
  }
}
