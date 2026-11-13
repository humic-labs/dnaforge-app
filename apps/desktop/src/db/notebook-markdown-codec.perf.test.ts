// @vitest-environment node

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TABLE_NOTEBOOK_BLOCK } from '../shared/table-notebook-contract';
import { isUnknownRecord } from '../shared/notebook-content-extension';
import { parseNotebookMarkdown, serializeNotebookMarkdown } from './notebook-markdown-codec';

const SAMPLE_WORKSPACE_RELATIVE = 'resources/sample-workspaces/standard-samples/workspace';
const SAMPLE_WORKSPACE = [
  join(process.cwd(), SAMPLE_WORKSPACE_RELATIVE),
  join(process.cwd(), 'apps/desktop', SAMPLE_WORKSPACE_RELATIVE),
].find(existsSync);

function shippedNotebookContent(): unknown {
  if (!SAMPLE_WORKSPACE) throw new Error('Standard sample workspace is missing');
  const path = join(
    SAMPLE_WORKSPACE,
    'notebooks/MoClo Golden Gate — red fluorescent transcription unit/.forge/notebook.json'
  );
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isUnknownRecord(parsed) || !('content' in parsed)) {
    throw new Error('Bundled MoClo notebook has no content document');
  }
  return parsed.content;
}

function tableBlock(index: number) {
  return {
    type: 'embed',
    attrs: {
      type: 'table',
      version: 1,
      refId: `table-${index}`,
      data: {
        columnLabels: ['Sample', 'Yield'],
        cells: [
          [
            { value: `sample-${index}`, type: 'text' },
            { value: `=${index}+1`, type: 'formula' },
          ],
        ],
      },
    },
  };
}

function largeNotebookContent() {
  return {
    type: 'doc',
    content: Array.from({ length: 125 }, (_, index) => [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: `Construct ${index} ` },
          { type: 'text', text: 'ready', marks: [{ type: 'bold' }] },
        ],
      },
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: `Step ${index}` }] }],
          },
        ],
      },
      { type: 'codeBlock', content: [{ type: 'text', text: `sample_${index} = true` }] },
      tableBlock(index),
    ]).flat(),
  };
}

function codecDurationMs(content: unknown, id: string): number {
  const startedAt = performance.now();
  const serialized = serializeNotebookMarkdown({
    identity: { id, title: id, formatVersion: 2 },
    content,
  });
  parseNotebookMarkdown({
    markdown: serialized.markdown,
    payloads: new Map(
      serialized.payloads.map((payload) => [payload.relativePath, payload.content])
    ),
    expected: { id, formatVersion: 2 },
  });
  return performance.now() - startedAt;
}

function measuredP95(content: unknown, id: string): number {
  codecDurationMs(content, `${id}-warmup`);
  const samples = Array.from({ length: 5 }, (_, index) =>
    codecDurationMs(content, `${id}-${index}`)
  ).sort((left, right) => left - right);
  return samples[Math.ceil(samples.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

describe('notebook Markdown codec performance contract', () => {
  afterEach(() => vi.restoreAllMocks());

  it.runIf(process.env.DNAFORGE_NOTEBOOK_CODEC_PERF === '1')(
    'keeps the shipped notebook below 200 ms p95',
    () => {
      expect(measuredP95(shippedNotebookContent(), 'moclo')).toBeLessThan(200);
    }
  );

  it.runIf(process.env.DNAFORGE_NOTEBOOK_CODEC_PERF === '1')(
    'keeps a deterministic 500-block rich notebook below 750 ms p95',
    () => {
      expect(largeNotebookContent().content).toHaveLength(500);
      expect(measuredP95(largeNotebookContent(), 'large')).toBeLessThan(750);
    }
  );

  it('validates and projects each rich block exactly once during serialization', () => {
    const parseData = vi.spyOn(TABLE_NOTEBOOK_BLOCK, 'parseData');
    const toMarkdown = vi.spyOn(TABLE_NOTEBOOK_BLOCK, 'toMarkdown');
    const blockCount = 20;

    serializeNotebookMarkdown({
      identity: { id: 'call-count', title: 'Call count', formatVersion: 2 },
      content: {
        type: 'doc',
        content: Array.from({ length: blockCount }, (_, index) => tableBlock(index)),
      },
    });

    expect(parseData).toHaveBeenCalledTimes(blockCount);
    expect(toMarkdown).toHaveBeenCalledTimes(blockCount);
  });
});
