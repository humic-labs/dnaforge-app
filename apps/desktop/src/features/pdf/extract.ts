import { beginPdfLoad } from './runtime';
import { platform } from '../../platform';
import type {
  StructuredPdfElementKind,
  StructuredPdfParserIdentity,
} from '../../shared/pdf-extraction';

export type ExtractedPdfRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ExtractedPdfBlock = {
  blockId: string;
  page: number;
  kind: StructuredPdfElementKind | 'text-item';
  text: string;
  rect: ExtractedPdfRect;
};

export type ExtractedPdfPages = {
  parser: StructuredPdfParserIdentity;
  pageCount: number;
  pages: Array<{ page: number; text: string; blocks: ExtractedPdfBlock[] }>;
  truncated: boolean;
};

export type CurrentExtractedPdfPages = ExtractedPdfPages & {
  sourceSha256: string;
};

type ExtractPdfOptions = {
  pages: number[];
  maxCharacters: number;
  clampTrailingPages?: boolean;
};

type PdfTextItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
};

function normalized(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(6))));
}

function textItem(value: unknown): value is PdfTextItem {
  if (!value || typeof value !== 'object' || !('str' in value)) return false;
  const item = value as Partial<PdfTextItem>;
  return (
    typeof item.str === 'string' &&
    Array.isArray(item.transform) &&
    item.transform.length >= 6 &&
    item.transform.every((entry) => typeof entry === 'number') &&
    typeof item.width === 'number' &&
    typeof item.height === 'number'
  );
}

export function normalizeRequestedPdfPages(
  pages: number[],
  documentPageCount: number,
  clampTrailingPages: boolean
): number[] {
  const requestedPages = [...new Set(pages)].sort((left, right) => left - right);
  const validIntegers = requestedPages.every((page) => Number.isInteger(page) && page >= 1);
  const inDocument = requestedPages.filter((page) => page <= documentPageCount);
  if (
    !Number.isInteger(documentPageCount) ||
    documentPageCount < 1 ||
    requestedPages.length === 0 ||
    !validIntegers ||
    inDocument.length === 0 ||
    (!clampTrailingPages && inDocument.length !== requestedPages.length)
  ) {
    throw new Error(`Requested PDF pages must be between 1 and ${documentPageCount}.`);
  }
  return inDocument;
}

export async function extractPdfPages(
  bytes: Uint8Array,
  options: ExtractPdfOptions
): Promise<ExtractedPdfPages> {
  const loadingTask = beginPdfLoad(bytes);
  const read = async (): Promise<ExtractedPdfPages> => {
    const document = await loadingTask.result;
    const requestedPages = normalizeRequestedPdfPages(
      options.pages,
      document.numPages,
      options.clampTrailingPages === true
    );

    let remainingCharacters = options.maxCharacters;
    let truncated = false;
    const pages: ExtractedPdfPages['pages'] = [];
    for (const pageNumber of requestedPages) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const blocks: ExtractedPdfBlock[] = [];
      for (const value of content.items) {
        if (!textItem(value) || !value.str.trim()) continue;
        if (remainingCharacters <= 0) {
          truncated = true;
          break;
        }
        if (value.str.length > remainingCharacters) {
          truncated = true;
          break;
        }
        const text = value.str;
        remainingCharacters -= text.length;

        const sourceX = value.transform[4];
        const sourceY = value.transform[5];
        const corners = [
          viewport.convertToViewportPoint(sourceX, sourceY),
          viewport.convertToViewportPoint(sourceX + value.width, sourceY + value.height),
        ];
        const left = Math.min(corners[0][0], corners[1][0]);
        const right = Math.max(corners[0][0], corners[1][0]);
        const top = Math.min(corners[0][1], corners[1][1]);
        const bottom = Math.max(corners[0][1], corners[1][1]);
        blocks.push({
          blockId: `p${pageNumber}-b${blocks.length + 1}`,
          page: pageNumber,
          kind: 'text-item',
          text,
          rect: {
            x: normalized(left / viewport.width),
            y: normalized(top / viewport.height),
            width: normalized((right - left) / viewport.width),
            height: normalized((bottom - top) / viewport.height),
          },
        });
      }
      pages.push({
        page: pageNumber,
        text: blocks.map((block) => block.text).join(' '),
        blocks,
      });
      if (truncated) break;
    }
    return {
      parser: {
        name: 'pdfjs-browser-fallback',
        version: '6.1.200',
        mode: 'text-items',
        configuration: 'complete-text-items',
      },
      pageCount: document.numPages,
      pages,
      truncated,
    };
  };
  let result: ExtractedPdfPages;
  try {
    result = await Promise.race([
      read(),
      loadingTask.workerFailure.then((primary) => {
        throw primary;
      }),
    ]);
  } catch (primary) {
    try {
      await loadingTask.destroy();
    } catch {}
    throw primary;
  }
  await loadingTask.destroy();
  return result;
}

export async function extractPdfFilePages(
  path: string,
  bytes: Uint8Array,
  options: ExtractPdfOptions
): Promise<ExtractedPdfPages> {
  const currentPlatform = platform();
  const structuredExtractor = currentPlatform.pdf?.extractStructured;
  if (!structuredExtractor) {
    if (currentPlatform.runtime.getProfile().isElectron) {
      throw new Error('Structured PDF extraction is unavailable in Electron.');
    }
    return extractPdfPages(bytes, options);
  }

  const structured = await structuredExtractor({ path, ...options });
  const loadingTask = beginPdfLoad(bytes);
  const read = async (): Promise<ExtractedPdfPages> => {
    const document = await loadingTask.result;
    if (document.numPages !== structured.pageCount) {
      throw new Error('The structured PDF parser and PDF.js disagree about the page count.');
    }
    const pages: ExtractedPdfPages['pages'] = [];
    for (const pageResult of structured.pages) {
      const page = await document.getPage(pageResult.page);
      const viewport = page.getViewport({ scale: 1 });
      const blocks = pageResult.elements.map((element) => {
        const [left, bottom, right, top] = element.boundingBox;
        const corners = [
          viewport.convertToViewportPoint(left, bottom),
          viewport.convertToViewportPoint(right, top),
        ];
        const x1 = Math.min(corners[0][0], corners[1][0]);
        const x2 = Math.max(corners[0][0], corners[1][0]);
        const y1 = Math.min(corners[0][1], corners[1][1]);
        const y2 = Math.max(corners[0][1], corners[1][1]);
        const normalizedLeft = normalized(x1 / viewport.width);
        const normalizedRight = normalized(x2 / viewport.width);
        const normalizedTop = normalized(y1 / viewport.height);
        const normalizedBottom = normalized(y2 / viewport.height);
        if (
          !Number.isFinite(viewport.width) ||
          !Number.isFinite(viewport.height) ||
          viewport.width <= 0 ||
          viewport.height <= 0 ||
          normalizedRight <= normalizedLeft ||
          normalizedBottom <= normalizedTop
        ) {
          throw new Error(
            `Structured PDF parser returned invalid geometry for ${element.blockId}.`
          );
        }
        return {
          blockId: element.blockId,
          page: element.page,
          kind: element.kind,
          text: element.text,
          rect: {
            x: normalizedLeft,
            y: normalizedTop,
            width: normalized(normalizedRight - normalizedLeft),
            height: normalized(normalizedBottom - normalizedTop),
          },
        };
      });
      pages.push({
        page: pageResult.page,
        text: blocks.map((block) => block.text).join('\n\n'),
        blocks,
      });
    }
    return { ...structured, pages };
  };
  let result: ExtractedPdfPages;
  try {
    result = await Promise.race([
      read(),
      loadingTask.workerFailure.then((primary) => {
        throw primary;
      }),
    ]);
  } catch (primary) {
    try {
      await loadingTask.destroy();
    } catch {}
    throw primary;
  }
  await loadingTask.destroy();
  return result;
}

export async function extractCurrentPdfFilePages(
  path: string,
  options: ExtractPdfOptions
): Promise<CurrentExtractedPdfPages> {
  const currentPlatform = platform();
  const before = normalizedSha256(await currentPlatform.fs.sha256File(path));
  const bytes = await currentPlatform.fs.readFile(path);
  const extracted = await extractPdfFilePages(path, bytes, options);
  const after = normalizedSha256(await currentPlatform.fs.sha256File(path));
  if (before !== after) {
    throw new Error('The PDF changed during extraction. Read the current file and try again.');
  }
  return { ...extracted, sourceSha256: `sha256:${before}` };
}

function normalizedSha256(value: string): string {
  const digest = value.replace(/^sha256:/iu, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error('PDF content hash is invalid.');
  return digest;
}
