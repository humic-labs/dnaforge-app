import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/dnaforge/app',
    getPath: (name: string) => (name === 'home' ? '/Users/scientist' : '/tmp/dnaforge'),
  },
  ipcMain: { handle: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), send: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}));

vi.mock('./ipc/path-allowlist', () => ({
  assertSafePath: vi.fn(async (path: string) => path),
}));

import {
  developmentResourcesRoot,
  extractPdfWithOpenDataLoader,
  extractStructuredPdf,
  parseOpenDataLoaderJson,
  resolveOpenDataLoaderRuntime,
  type StructuredPdfExtractionProvider,
} from './pdf-extraction';

const OPEN_DATA_LOADER_DOCUMENT = {
  'number of pages': 2,
  kids: [
    {
      type: 'heading',
      content: 'Methods',
      'page number': 1,
      'bounding box': [72, 680, 280, 710],
    },
    {
      type: 'paragraph',
      content: 'Grow the culture overnight.',
      'page number': 1,
      'bounding box': [72, 620, 300, 660],
    },
    {
      type: 'list',
      'list items': [
        {
          type: 'list item',
          content: 'Harvest the cells.',
          'page number': 2,
          'bounding box': [80, 660, 300, 690],
        },
      ],
    },
    {
      type: 'table',
      'page number': 2,
      'bounding box': [72, 420, 520, 620],
      rows: [
        {
          cells: [{ content: 'Reagent' }, { content: 'Amount' }],
        },
        {
          cells: [{ content: 'Buffer A' }, { content: '50 | 5 µL' }],
        },
      ],
    },
    {
      type: 'image',
      'page number': 2,
      'bounding box': [72, 200, 300, 400],
    },
  ],
};

describe('parseOpenDataLoaderJson', () => {
  it('preserves semantic reading order and renders a table as one evidence block', () => {
    const result = parseOpenDataLoaderJson(OPEN_DATA_LOADER_DOCUMENT, {
      pages: [1, 2],
      maxCharacters: 10_000,
    });

    expect(result.parser).toEqual({
      name: 'opendataloader-pdf',
      version: '2.5.1',
      mode: 'deterministic-local',
      configuration: 'xycut-cluster-safety-on-images-off',
    });
    expect(result.pages).toEqual([
      {
        page: 1,
        elements: [
          {
            blockId: 'p1-b1',
            page: 1,
            kind: 'heading',
            text: 'Methods',
            boundingBox: [72, 680, 280, 710],
          },
          {
            blockId: 'p1-b2',
            page: 1,
            kind: 'paragraph',
            text: 'Grow the culture overnight.',
            boundingBox: [72, 620, 300, 660],
          },
        ],
      },
      {
        page: 2,
        elements: [
          {
            blockId: 'p2-b1',
            page: 2,
            kind: 'list-item',
            text: 'Harvest the cells.',
            boundingBox: [80, 660, 300, 690],
          },
          {
            blockId: 'p2-b2',
            page: 2,
            kind: 'table',
            text: 'Reagent | Amount\nBuffer A | 50 \\| 5 µL',
            boundingBox: [72, 420, 520, 620],
          },
        ],
      },
    ]);
    expect(result.truncated).toBe(false);
  });

  it('keeps page-local block IDs stable when the caller requests a different page range', () => {
    const pageTwoOnly = parseOpenDataLoaderJson(OPEN_DATA_LOADER_DOCUMENT, {
      pages: [2],
      maxCharacters: 10_000,
    });
    const bothPages = parseOpenDataLoaderJson(OPEN_DATA_LOADER_DOCUMENT, {
      pages: [1, 2],
      maxCharacters: 10_000,
    });

    expect(pageTwoOnly.pages[0].elements.map((element) => element.blockId)).toEqual([
      'p2-b1',
      'p2-b2',
    ]);
    expect(pageTwoOnly.pages[0]).toEqual(bothPages.pages[1]);
  });

  it('treats semantic elements as atomic when the character budget ends', () => {
    const result = parseOpenDataLoaderJson(OPEN_DATA_LOADER_DOCUMENT, {
      pages: [1, 2],
      maxCharacters: 'Methods'.length + 'Grow the culture overnight.'.length,
    });

    expect(result.pages[0].elements).toHaveLength(2);
    expect(result.pages[1].elements).toEqual([]);
    expect(result.truncated).toBe(true);
  });

  it('rejects malformed geometry instead of creating untrustworthy evidence', () => {
    expect(() =>
      parseOpenDataLoaderJson(
        {
          'number of pages': 1,
          kids: [
            {
              type: 'paragraph',
              content: 'Invalid geometry',
              'page number': 1,
              'bounding box': [100, 100, 90, 120],
            },
          ],
        },
        { pages: [1], maxCharacters: 1_000 }
      )
    ).toThrow('reversed or negative bounding box');
  });
});

describe('resolveOpenDataLoaderRuntime', () => {
  it('walks out of electron-vite out/main to the desktop resources directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'dnaforge-pdf-resources-'));
    try {
      mkdirSync(join(root, 'resources'), { recursive: true });
      writeFileSync(join(root, 'resources', 'opendataloader-runtime.json'), '{}');

      expect(developmentResourcesRoot(join(root, 'out', 'main'))).toBe(join(root, 'resources'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses an explicit paired development override', () => {
    expect(
      resolveOpenDataLoaderRuntime({
        environment: {
          DNAFORGE_OPENDATALOADER_JAVA: '/private/java',
          DNAFORGE_OPENDATALOADER_JAR: '/private/parser.jar',
        },
      })
    ).toEqual({ javaPath: '/private/java', jarPath: '/private/parser.jar' });
  });

  it('does not fall back to a Java executable on PATH', () => {
    const runtime = resolveOpenDataLoaderRuntime({
      appPath: '/dnaforge/app',
      environment: { PATH: '/attacker-controlled' },
    });

    expect(runtime.javaPath).toBe(
      join(
        '/dnaforge/app',
        'resources',
        'binaries',
        'opendataloader-pdf',
        `${process.platform}-${process.arch}`,
        'runtime',
        'bin',
        process.platform === 'win32' ? 'java.exe' : 'java'
      )
    );
    expect(runtime.jarPath).toContain('opendataloader-pdf-cli.jar');
  });

  it('rejects a partial development override instead of mixing trusted and ambient assets', () => {
    expect(() =>
      resolveOpenDataLoaderRuntime({
        environment: { DNAFORGE_OPENDATALOADER_JAVA: '/private/java' },
      })
    ).toThrow('require both a Java executable and a parser JAR');
  });
});

describe('extractPdfWithOpenDataLoader', () => {
  it('invokes the private runtime with an argument array and removes successful output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dnaforge-pdf-execution-'));
    const sourcePath = join(root, 'paper.pdf');
    const javaPath = join(root, 'java');
    const jarPath = join(root, 'parser.jar');
    writeFileSync(sourcePath, 'synthetic PDF bytes');
    writeFileSync(javaPath, 'private Java');
    writeFileSync(jarPath, 'pinned parser');
    let outputDirectory: string | undefined;
    try {
      const result = await extractPdfWithOpenDataLoader(
        { path: sourcePath, pages: [1, 2], maxCharacters: 10_000 },
        {
          runtime: { javaPath, jarPath },
          executeParser: async (executable, arguments_, executionOptions) => {
            expect(executable).toBe(javaPath);
            expect(arguments_).toContain('-jar');
            expect(arguments_).toContain(jarPath);
            expect(arguments_).toContain(sourcePath);
            expect(executionOptions).toEqual({
              timeout: 60_000,
              maxBuffer: 1024 * 1024,
              windowsHide: true,
            });
            const outputIndex = arguments_.indexOf('--output-dir');
            outputDirectory = arguments_[outputIndex + 1];
            writeFileSync(
              join(outputDirectory, 'paper.json'),
              JSON.stringify(OPEN_DATA_LOADER_DOCUMENT)
            );
          },
        }
      );

      expect(result.parser.name).toBe('opendataloader-pdf');
      expect(outputDirectory).toBeDefined();
      expect(existsSync(outputDirectory as string)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('normalizes signal-only timeout errors and still removes temporary output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dnaforge-pdf-timeout-'));
    const sourcePath = join(root, 'paper.pdf');
    const javaPath = join(root, 'java');
    const jarPath = join(root, 'parser.jar');
    writeFileSync(sourcePath, 'synthetic PDF bytes');
    writeFileSync(javaPath, 'private Java');
    writeFileSync(jarPath, 'pinned parser');
    let outputDirectory: string | undefined;
    try {
      await expect(
        extractPdfWithOpenDataLoader(
          { path: sourcePath, pages: [1], maxCharacters: 1_000 },
          {
            runtime: { javaPath, jarPath },
            timeoutMs: 25,
            executeParser: async (_executable, arguments_, executionOptions) => {
              expect(executionOptions.timeout).toBe(25);
              const outputIndex = arguments_.indexOf('--output-dir');
              outputDirectory = arguments_[outputIndex + 1];
              throw Object.assign(new Error('Command failed'), {
                killed: true,
                signal: 'SIGTERM',
              });
            },
          }
        )
      ).rejects.toThrow('OpenDataLoader PDF extraction timed out.');
      expect(outputDirectory).toBeDefined();
      expect(existsSync(outputDirectory as string)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('structured PDF provider boundary', () => {
  it('dispatches through an implementation-neutral provider without changing provenance', async () => {
    const identity = {
      name: 'future-structured-parser',
      version: '9.4.1',
      mode: 'managed-local',
      configuration: 'layout-v3',
    } as const;
    const extract = vi.fn<StructuredPdfExtractionProvider['extract']>().mockResolvedValue({
      parser: identity,
      pageCount: 1,
      pages: [{ page: 1, elements: [] }],
      truncated: false,
    });

    const result = await extractStructuredPdf(
      { path: '/workspace/paper.pdf', pages: [1], maxCharacters: 1_000 },
      { provider: { identity, extract } }
    );

    expect(extract).toHaveBeenCalledWith({
      path: '/workspace/paper.pdf',
      pages: [1],
      maxCharacters: 1_000,
    });
    expect(result.parser).toEqual(identity);
  });

  it('rejects provider output whose claimed provenance differs from the provider identity', async () => {
    const provider: StructuredPdfExtractionProvider = {
      identity: {
        name: 'future-structured-parser',
        version: '9.4.1',
        mode: 'managed-local',
        configuration: 'layout-v3',
      },
      extract: async () => ({
        parser: {
          name: 'different-parser',
          version: '1.0.0',
          mode: 'remote',
          configuration: 'unknown',
        },
        pageCount: 1,
        pages: [{ page: 1, elements: [] }],
        truncated: false,
      }),
    };

    await expect(
      extractStructuredPdf(
        { path: '/workspace/paper.pdf', pages: [1], maxCharacters: 1_000 },
        { provider }
      )
    ).rejects.toThrow('Structured PDF provider returned mismatched parser provenance.');
  });
});
