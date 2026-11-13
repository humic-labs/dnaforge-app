import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockBeginPdfLoad = vi.hoisted(() => vi.fn());
const mockPlatform = vi.hoisted(() => vi.fn<() => unknown>());

vi.mock('./runtime', () => ({ beginPdfLoad: mockBeginPdfLoad }));
vi.mock('../../platform', () => ({ platform: () => mockPlatform() }));

import {
  extractCurrentPdfFilePages,
  extractPdfFilePages,
  extractPdfPages,
  normalizeRequestedPdfPages,
} from './extract';

beforeEach(() => {
  vi.clearAllMocks();
  mockPlatform.mockReturnValue({});
});

describe('PDF extraction page selection', () => {
  it('clamps only a trailing page-range overflow when the caller opts in', () => {
    expect(normalizeRequestedPdfPages([1, 2, 3, 4, 5], 2, true)).toEqual([1, 2]);
  });

  it('keeps strict extraction fail-closed and rejects a start beyond the document', () => {
    expect(() => normalizeRequestedPdfPages([1, 2, 3], 2, false)).toThrow(
      'Requested PDF pages must be between 1 and 2.'
    );
    expect(() => normalizeRequestedPdfPages([3, 4], 2, true)).toThrow(
      'Requested PDF pages must be between 1 and 2.'
    );
  });
});

describe('PDF extraction character budget', () => {
  it('emits only whole text items so every returned block matches its full rectangle', async () => {
    const destroy = installPdfTextItems(['abc', 'defgh']);

    const extracted = await extractPdfPages(new Uint8Array([1, 2, 3]), {
      pages: [1],
      maxCharacters: 6,
    });

    expect(extracted).toMatchObject({
      pageCount: 1,
      truncated: true,
      pages: [
        {
          page: 1,
          text: 'abc',
          blocks: [{ blockId: 'p1-b1', text: 'abc' }],
        },
      ],
    });
    expect(extracted.pages[0].blocks).toHaveLength(1);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('returns no block when the first complete text item exceeds the budget', async () => {
    const destroy = installPdfTextItems(['long item']);

    const extracted = await extractPdfPages(new Uint8Array([1, 2, 3]), {
      pages: [1],
      maxCharacters: 4,
    });

    expect(extracted).toMatchObject({
      truncated: true,
      pages: [{ page: 1, text: '', blocks: [] }],
    });
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

describe('structured PDF extraction', () => {
  it('rejects when the source bytes change during extraction', async () => {
    const destroy = installPdfTextItems(['source text']);
    const sha256File = vi
      .fn()
      .mockResolvedValueOnce(`sha256:${'a'.repeat(64)}`)
      .mockResolvedValueOnce(`sha256:${'b'.repeat(64)}`);
    mockPlatform.mockReturnValue({
      fs: {
        sha256File,
        readFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
      },
      runtime: { getProfile: () => ({ isElectron: false }) },
    });

    await expect(
      extractCurrentPdfFilePages('/workspace/paper.pdf', {
        pages: [1],
        maxCharacters: 1_000,
      })
    ).rejects.toThrow('PDF changed during extraction');
    expect(sha256File).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('uses structured IPC output and converts PDF-point geometry for viewer navigation', async () => {
    const destroy = installPdfTextItems([]);
    const extractStructured = vi.fn().mockResolvedValue({
      parser: {
        name: 'opendataloader-pdf',
        version: '2.5.1',
        mode: 'deterministic-local',
        configuration: 'xycut-cluster-safety-on-images-off',
      },
      pageCount: 1,
      pages: [
        {
          page: 1,
          elements: [
            {
              blockId: 'p1-b1',
              page: 1,
              kind: 'heading',
              text: 'Methods',
              boundingBox: [10, 20, 50, 60],
            },
          ],
        },
      ],
      truncated: false,
    });
    mockPlatform.mockReturnValue({ pdf: { extractStructured } });

    const extracted = await extractPdfFilePages('/workspace/paper.pdf', new Uint8Array([1, 2, 3]), {
      pages: [1],
      maxCharacters: 1_000,
    });

    expect(extractStructured).toHaveBeenCalledWith({
      path: '/workspace/paper.pdf',
      pages: [1],
      maxCharacters: 1_000,
    });
    expect(extracted).toMatchObject({
      parser: { name: 'opendataloader-pdf', version: '2.5.1' },
      pages: [
        {
          text: 'Methods',
          blocks: [
            {
              blockId: 'p1-b1',
              kind: 'heading',
              rect: { x: 0.1, y: 0.2, width: 0.4, height: 0.4 },
            },
          ],
        },
      ],
    });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('fails closed in Electron when the structured parser bridge is missing', async () => {
    mockPlatform.mockReturnValue({
      runtime: { getProfile: () => ({ isElectron: true }) },
    });

    await expect(
      extractPdfFilePages('/workspace/paper.pdf', new Uint8Array([1, 2, 3]), {
        pages: [1],
        maxCharacters: 1_000,
      })
    ).rejects.toThrow('Structured PDF extraction is unavailable in Electron.');
    expect(mockBeginPdfLoad).not.toHaveBeenCalled();
  });

  it('retains PDF.js text items only for the browser-test runtime', async () => {
    const destroy = installPdfTextItems(['browser fallback']);
    mockPlatform.mockReturnValue({
      runtime: { getProfile: () => ({ isElectron: false }) },
    });

    const extracted = await extractPdfFilePages('/workspace/paper.pdf', new Uint8Array([1, 2, 3]), {
      pages: [1],
      maxCharacters: 1_000,
    });

    expect(extracted.parser).toEqual({
      name: 'pdfjs-browser-fallback',
      version: '6.1.200',
      mode: 'text-items',
      configuration: 'complete-text-items',
    });
    expect(extracted.pages[0].blocks[0]).toMatchObject({
      kind: 'text-item',
      text: 'browser fallback',
    });
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

function installPdfTextItems(values: string[]) {
  const destroy = vi.fn().mockResolvedValue(undefined);
  mockBeginPdfLoad.mockReturnValue({
    result: Promise.resolve({
      numPages: 1,
      getPage: vi.fn().mockResolvedValue({
        getViewport: () => ({
          width: 100,
          height: 100,
          convertToViewportPoint: (x: number, y: number) => [x, y],
        }),
        getTextContent: vi.fn().mockResolvedValue({
          items: values.map((str, index) => ({
            str,
            transform: [1, 0, 0, 1, 10, 10 + index * 10],
            width: 20,
            height: 5,
          })),
        }),
      }),
    }),
    workerFailure: new Promise<unknown>(() => {}),
    destroy,
  });
  return destroy;
}

describe('PDF extraction worker failures', () => {
  it('settles a current extraction when its raw worker fails after the document loads', async () => {
    const primary = new Error('Controlled extraction worker failure');
    let fail!: (reason: unknown) => void;
    const workerFailure = new Promise<unknown>((resolve) => {
      fail = resolve;
    });
    const getPage = vi.fn(() => new Promise<never>(() => {}));
    const destroy = vi.fn().mockRejectedValue(primary);
    mockBeginPdfLoad.mockReturnValue({
      result: Promise.resolve({ numPages: 1, getPage }),
      workerFailure,
      destroy,
    });
    const extraction = extractPdfPages(new Uint8Array([1]), { pages: [1], maxCharacters: 100 });
    await Promise.resolve();
    expect(getPage).toHaveBeenCalledWith(1);
    fail(primary);
    await expect(extraction).rejects.toBe(primary);
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

describe('PDF extraction primary error ownership', () => {
  it.each(['browser', 'structured'] as const)(
    'preserves the first %s read rejection when later worker cleanup also fails',
    async (route) => {
      for (const primary of [new Error('Controlled first read rejection'), undefined]) {
        const later = new Error('Controlled later worker failure');
        let failWorker!: (reason: unknown) => void;
        const workerFailure = new Promise<unknown>((resolve) => {
          failWorker = resolve;
        });
        const destroy = vi.fn(() => {
          failWorker(later);
          return Promise.reject(later);
        });
        mockBeginPdfLoad.mockReturnValue({
          result: Promise.resolve({ numPages: 1, getPage: vi.fn().mockRejectedValue(primary) }),
          workerFailure,
          destroy,
        });
        mockPlatform.mockReturnValue({
          pdf: {
            extractStructured: vi.fn().mockResolvedValue({
              parser: {
                name: 'opendataloader-pdf',
                version: '2.5.1',
                mode: 'deterministic-local',
                configuration: 'controlled',
              },
              pageCount: 1,
              pages: [{ page: 1, elements: [] }],
              truncated: false,
            }),
          },
        });
        const options = { pages: [1], maxCharacters: 100 };
        const extraction =
          route === 'browser'
            ? extractPdfPages(new Uint8Array([1]), options)
            : extractPdfFilePages('/workspace/controlled.pdf', new Uint8Array([1]), options);
        await expect(extraction).rejects.toBe(primary);
        expect(destroy).toHaveBeenCalledTimes(1);
      }
    }
  );

  it('surfaces cleanup failure when the read itself succeeded', async () => {
    const destroy = installPdfTextItems(['controlled successful read']);
    const cleanup = new Error('Controlled shutdown failure');
    destroy.mockRejectedValue(cleanup);
    await expect(
      extractPdfPages(new Uint8Array([1]), { pages: [1], maxCharacters: 100 })
    ).rejects.toBe(cleanup);
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
