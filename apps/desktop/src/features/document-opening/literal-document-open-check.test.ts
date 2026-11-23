// @vitest-environment node

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import { beginPdfLoad } from '../pdf/runtime';
import { inspectLiteralDocument, readLiteralDocument } from './literal-document-open-check';
import { stageLiteralOpenSnapshot, takeLiteralOpenSnapshot } from './literal-open-snapshot';

const fs = vi.hoisted(() => ({
  stat: vi.fn(),
  readFile: vi.fn(),
  readFileBounded: vi.fn(),
  readTextFile: vi.fn(),
  readTextFileSlice: vi.fn(),
}));
const pdfWorker = vi.hoisted(() => ({
  transferInput: false,
  transferredBytes: null as Uint8Array | null,
}));

vi.mock('../../platform', () => ({ platform: () => ({ fs }) }));
vi.mock('../../hooks/resolveFilePath', () => ({
  resolveFilePathWithFallback: (path: string) => path,
}));

// Use the same PDF.js parser. Vite's renderer worker wrapper requires the desktop.
vi.mock('../pdf/runtime', async () => {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return {
    beginPdfLoad: vi.fn((bytes: Uint8Array) => {
      let data = bytes;
      if (pdfWorker.transferInput) {
        data = structuredClone(bytes, { transfer: [bytes.buffer as ArrayBuffer] });
        pdfWorker.transferredBytes = bytes;
      }
      const task = getDocument({ data });
      vi.spyOn(task, 'destroy');
      return Object.assign(task, {
        result: task.promise,
        workerFailure: new Promise<unknown>(() => {}),
      });
    }),
  };
});

const fixtureRoot = new URL('../../../../../test-fixtures/', import.meta.url);

function fixtureBytes(path: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(readFileSync(new URL(path, fixtureRoot)));
}

function workbookBytes(bookType: 'biff8' | 'xlsx'): ArrayBuffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ['sample', 'count'],
      ['A1', 2],
    ]),
    'Samples'
  );
  return XLSX.write(workbook, { type: 'array', bookType }) as ArrayBuffer;
}

function expectPdfReaderReleased(): void {
  const result = vi.mocked(beginPdfLoad).mock.results[0];
  if (result?.type !== 'return') throw new Error('Expected a PDF loading task.');
  expect(result.value.destroy).toHaveBeenCalledTimes(1);
}

beforeEach(() => {
  vi.clearAllMocks();
  pdfWorker.transferInput = false;
  pdfWorker.transferredBytes = null;
  fs.stat.mockResolvedValue({ size: 128 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const read of Object.values(fs)) read.mockReset();
});

describe('PDF open checks', () => {
  const path = '/synthetic/report.pdf';
  const validFixture = 'documents/paper-protocol-synthetic.pdf';

  it('opens a real document with a readable first page and releases its reader', async () => {
    fs.readFile.mockResolvedValueOnce(fixtureBytes(validFixture));
    await expect(inspectLiteralDocument('pdf', path)).resolves.toBeUndefined();
    expectPdfReaderReleased();
  });

  it('retains the validated bytes when the PDF loader transfers its input', async () => {
    fs.readFile.mockResolvedValueOnce(fixtureBytes(validFixture));
    pdfWorker.transferInput = true;

    const opened = await readLiteralDocument('pdf', path);

    expect(pdfWorker.transferredBytes?.byteLength).toBe(0);
    expect(opened).toEqual({ kind: 'pdf', bytes: fixtureBytes(validFixture) });
    expectPdfReaderReleased();
  });

  it.each([0, 8, 300])('rejects a PDF cut to %i bytes', async (length) => {
    fs.readFile.mockResolvedValueOnce(fixtureBytes(validFixture).slice(0, length));
    await expect(inspectLiteralDocument('pdf', path)).rejects.toMatchObject({
      code: 'malformed',
      recognized: length > 0,
    });
    expectPdfReaderReleased();
  });

  it('recognizes a password-protected PDF separately from damaged bytes', async () => {
    fs.readFile.mockResolvedValueOnce(
      fixtureBytes('documents/paper-password-locked-synthetic.pdf')
    );
    await expect(inspectLiteralDocument('pdf', path)).rejects.toMatchObject({
      code: 'password',
      recognized: true,
    });
    expectPdfReaderReleased();
  });

  it('keeps a viewer runtime failure distinct from a bad document', async () => {
    fs.readFile.mockResolvedValueOnce(fixtureBytes(validFixture));
    vi.mocked(beginPdfLoad).mockImplementationOnce(() => {
      throw new Error('Worker unavailable');
    });
    await expect(inspectLiteralDocument('pdf', path)).rejects.toMatchObject({
      code: 'runtime',
      recognized: true,
    });
  });
});

describe('literal snapshot handoff', () => {
  it('hands the latest staged revision to the matching path and kind once', () => {
    const path = '/synthetic/report.html';
    const earlier = stageLiteralOpenSnapshot(path, { kind: 'html', text: '<h1>Earlier</h1>' });
    const latest = stageLiteralOpenSnapshot(path, { kind: 'html', text: '<h1>Latest</h1>' });
    earlier();
    expect(takeLiteralOpenSnapshot(path, 'image')).toBeUndefined();
    expect(takeLiteralOpenSnapshot('/other/report.html', 'html')).toBeUndefined();
    expect(takeLiteralOpenSnapshot(path, 'html')).toEqual({
      kind: 'html',
      text: '<h1>Latest</h1>',
    });
    expect(takeLiteralOpenSnapshot(path, 'html')).toBeUndefined();
    latest();
  });

  it('rolls back failed presentations and retires unused snapshots', () => {
    vi.useFakeTimers();
    try {
      const path = '/synthetic/cancelled.html';
      const release = stageLiteralOpenSnapshot(path, { kind: 'html', text: '<p>Cancelled</p>' });
      release();
      expect(takeLiteralOpenSnapshot(path, 'html')).toBeUndefined();
      stageLiteralOpenSnapshot(path, { kind: 'html', text: '<p>Unused</p>' });
      vi.runOnlyPendingTimers();
      expect(takeLiteralOpenSnapshot(path, 'html')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses excess pending opens without evicting a staged revision', () => {
    const entries = Array.from({ length: 8 }, (_, index) => {
      const path = '/synthetic/pending-' + String(index) + '.html';
      const release = stageLiteralOpenSnapshot(path, { kind: 'html', text: path });
      return { path, release };
    });
    try {
      expect(() =>
        stageLiteralOpenSnapshot('/synthetic/overflow.html', { kind: 'html', text: 'extra' })
      ).toThrow();
      expect(takeLiteralOpenSnapshot(entries[0].path, 'html')).toEqual({
        kind: 'html',
        text: entries[0].path,
      });
      const release = stageLiteralOpenSnapshot('/synthetic/overflow.html', {
        kind: 'html',
        text: 'extra',
      });
      release();
    } finally {
      for (const { release } of entries) release();
    }
  });
});

describe('image open checks', () => {
  function browserImage(size: [number, number] | null) {
    vi.stubGlobal(
      'Image',
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        naturalWidth = size?.[0] ?? 0;
        naturalHeight = size?.[1] ?? 0;

        set src(_url: string) {
          queueMicrotask(() => (size ? this.onload?.() : this.onerror?.()));
        }
      }
    );
    return {
      create: vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local-image'),
      revoke: vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {}),
    };
  }

  it.each([
    ['png', 'png', 'image/png'],
    ['jpg', 'jpg', 'image/jpeg'],
    ['JPEG', 'jpg', 'image/jpeg'],
    ['gif', 'gif', 'image/gif'],
    ['webp', 'webp', 'image/webp'],
    ['svg', 'svg', 'image/svg+xml'],
    ['bmp', 'bmp', 'image/bmp'],
    ['ico', 'ico', 'image/x-icon'],
  ])(
    'passes %s bytes and MIME type to the browser image reader',
    async (extension, fixture, mime) => {
      const bytes = fixtureBytes('images/sample.' + fixture);
      const path = '/synthetic/icon.' + extension;
      fs.readFileBounded.mockResolvedValueOnce(bytes);
      const { create, revoke } = browserImage([24, 24]);
      await expect(inspectLiteralDocument('image', path)).resolves.toBeUndefined();
      expect(fs.readFileBounded).toHaveBeenCalledWith(path, 256 * 1024 * 1024);
      const blob = create.mock.calls[0][0];
      if (!(blob instanceof Blob)) throw new Error('Expected an image blob.');
      expect(blob.type).toBe(mime);
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
      expect(revoke).toHaveBeenCalledWith('blob:local-image');
    }
  );

  it.each(['png', 'jpg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff'])(
    'rejects truncated %s bytes when the browser cannot decode them',
    async (extension) => {
      fs.readFileBounded.mockResolvedValueOnce(
        fixtureBytes('images/sample.' + extension).slice(0, 6)
      );
      const { revoke } = browserImage(null);
      await expect(
        inspectLiteralDocument('image', '/synthetic/truncated.' + extension)
      ).rejects.toMatchObject({ code: 'malformed' });
      expect(revoke).toHaveBeenCalledWith('blob:local-image');
    }
  );

  it.each(['tif', 'tiff'])('preserves the browser decode decision for %s', async (extension) => {
    fs.readFileBounded.mockResolvedValueOnce(fixtureBytes('images/sample.tiff'));
    const { create } = browserImage(null);
    await expect(
      inspectLiteralDocument('image', '/synthetic/image.' + extension)
    ).rejects.toMatchObject({
      code: 'unsupported-format',
      recognized: true,
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ type: 'image/tiff' }));
  });

  it('opens TIFF if the image reader can decode it', async () => {
    fs.readFileBounded.mockResolvedValueOnce(fixtureBytes('images/sample.tiff'));
    browserImage([24, 24]);
    await expect(inspectLiteralDocument('image', '/synthetic/gel.tiff')).resolves.toBeUndefined();
  });

  it('keeps an unexplained decoder failure distinct from proven damage', async () => {
    fs.readFileBounded.mockResolvedValueOnce(fixtureBytes('images/sample.png'));
    browserImage(null);
    await expect(inspectLiteralDocument('image', '/synthetic/chart.png')).rejects.toMatchObject({
      code: 'unknown',
      recognized: false,
    });
  });

  it('rejects a load event with no usable image dimensions', async () => {
    fs.readFileBounded.mockResolvedValueOnce(fixtureBytes('images/sample.png'));
    browserImage([0, 24]);
    await expect(inspectLiteralDocument('image', '/synthetic/chart.png')).rejects.toMatchObject({
      code: 'malformed',
    });
  });
});

describe('tables and HTML', () => {
  it.each([
    ['csv', 'sample,note\nA1,"note, quoted"\n'],
    ['tsv', 'sample\tnote\nA1\t"note\tquoted"\n'],
  ])('opens valid %s with quoted fields', async (extension, text) => {
    fs.readTextFile.mockResolvedValueOnce(text);
    await expect(
      inspectLiteralDocument('table', '/synthetic/data.' + extension)
    ).resolves.toBeUndefined();
  });

  it.each([
    ['csv', ''],
    ['csv', 'sample,note\nA1,"missing close'],
    ['tsv', 'sample\tnote\nA1\t"missing close'],
    ['tsv', 'sample,note\nA1,wrong delimiter'],
  ])('rejects %s that does not yield a readable table', async (extension, text) => {
    fs.readTextFile.mockResolvedValueOnce(text);
    await expect(
      inspectLiteralDocument('table', '/synthetic/data.' + extension)
    ).rejects.toMatchObject({
      code: 'malformed',
    });
  });

  it.each([
    ['xls', 'biff8'],
    ['xlsx', 'xlsx'],
  ] as const)(
    'opens an actual %s workbook and rejects its truncated bytes',
    async (extension, bookType) => {
      const path = '/synthetic/workbook.' + extension;
      const bytes = workbookBytes(bookType);
      fs.readFile.mockResolvedValueOnce(bytes).mockResolvedValueOnce(bytes.slice(0, 8));
      await expect(inspectLiteralDocument('table', path)).resolves.toBeUndefined();
      await expect(inspectLiteralDocument('table', path)).rejects.toMatchObject({
        code: 'malformed',
      });
    }
  );

  it('keeps the XLS password marker distinct from a broken workbook', async () => {
    const cfb = XLSX.CFB.read(new Uint8Array(workbookBytes('biff8')), { type: 'buffer' });
    XLSX.CFB.utils.cfb_add(cfb, 'encryption', new Uint8Array([1]));
    fs.readFile.mockResolvedValueOnce(new Uint8Array(XLSX.CFB.write(cfb, { type: 'buffer' })));
    await expect(inspectLiteralDocument('table', '/synthetic/locked.xls')).rejects.toMatchObject({
      code: 'password',
      recognized: true,
    });
  });

  it('preserves the password requirement reported by the encrypted XLSX reader', async () => {
    const cfb = XLSX.CFB.utils.cfb_new();
    XLSX.CFB.utils.cfb_add(cfb, 'EncryptedPackage', new Uint8Array([1]));
    XLSX.CFB.utils.cfb_add(cfb, 'EncryptionInfo', new Uint8Array([3, 0, 3, 0]));
    fs.readFile.mockResolvedValueOnce(new Uint8Array(XLSX.CFB.write(cfb, { type: 'buffer' })));
    await expect(inspectLiteralDocument('table', '/synthetic/locked.xlsx')).rejects.toMatchObject({
      code: 'password',
      recognized: true,
    });
  });

  it('uses the viewer slice for a large delimited table', async () => {
    const path = '/synthetic/large.csv';
    fs.stat.mockResolvedValueOnce({ size: 20 * 1024 * 1024 + 1 });
    fs.readTextFileSlice.mockResolvedValueOnce({
      text: 'name,data\nfirst,1\nunfinished',
      bytesRead: 28,
    });
    await expect(inspectLiteralDocument('table', path)).resolves.toBeUndefined();
    expect(fs.readTextFileSlice).toHaveBeenCalledWith(path, 5 * 1024 * 1024);
    expect(fs.readTextFile).not.toHaveBeenCalled();
  });

  it.each(['', '<main><p>No closing tags', '<!-- an unclosed comment'])(
    'lets the HTML viewer read text it can display or show as source',
    async (html) => {
      fs.readTextFile.mockResolvedValueOnce(html);
      await expect(
        inspectLiteralDocument('html', '/synthetic/report.htm')
      ).resolves.toBeUndefined();
    }
  );

  it('passes through underlying access failures for the coordinator', async () => {
    const denied = Object.assign(new Error('File access denied'), { code: 'EACCES' });
    fs.readTextFile.mockRejectedValueOnce(denied);
    await expect(inspectLiteralDocument('html', '/synthetic/report.html')).rejects.toBe(denied);
  });
});
