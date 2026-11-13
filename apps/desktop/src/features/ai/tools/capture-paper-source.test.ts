import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import { execTool } from './test-helpers';
import { describe, expect, it } from 'vitest';

import {
  capturePaperSourceTool,
  capturePaperSourceOutputSchema,
  capturePaperSourceText,
  capturePaperSourceTextSchema,
} from './capture-paper-source';

describe('capture_paper_source tool', () => {
  it('pins bounded web text to exact hashes and stable source spans', async () => {
    const text = 'Cell lysis\nAdd buffer and incubate.\n\nWash\nWash the pellet twice.';
    const expectedSha256 = await sha256(text);
    const result = await execTool<{ source: { text: string }; blocks: unknown[] }>(
      capturePaperSourceTool,
      {
        originalUrl: 'https://example.org/paper?article=1',
        canonicalUrl: 'https://example.org/paper',
        mediaType: 'text/html',
        capturedText: text,
        capturedAt: '2026-08-19T03:00:00.000Z',
        expectedSha256,
        title: 'Publisher methods',
      }
    );

    assertMcpOutput(capturePaperSourceOutputSchema, result);
    expect(result.source).toMatchObject({
      kind: 'captured_text',
      sha256: expectedSha256,
      originalUrl: 'https://example.org/paper?article=1',
      canonicalUrl: 'https://example.org/paper',
      text,
    });
    expect(result.blocks).toEqual([
      {
        blockId: 'text-b1',
        start: 0,
        end: 35,
        text: 'Cell lysis\nAdd buffer and incubate.',
      },
      { blockId: 'text-b2', start: 37, end: 64, text: 'Wash\nWash the pellet twice.' },
    ]);
  });

  it('rejects changed text instead of trusting a caller-supplied hash', async () => {
    await expect(
      capturePaperSourceText({
        originalUrl: 'https://example.org/paper',
        canonicalUrl: 'https://example.org/paper',
        mediaType: 'text/html',
        capturedText: 'Changed text',
        capturedAt: '2026-08-19T03:00:00.000Z',
        expectedSha256: `sha256:${'a'.repeat(64)}`,
        title: 'Publisher methods',
      })
    ).rejects.toThrow(/hash does not match/i);
  });

  it('rejects unsafe provenance URLs and captures larger than 100,000 UTF-8 bytes', () => {
    expect(
      capturePaperSourceTextSchema.safeParse({
        originalUrl: 'https://user:password@example.org/paper',
        canonicalUrl: 'https://example.org/paper',
        mediaType: 'text/html',
        capturedText: 'Methods',
        capturedAt: '2026-08-19T03:00:00.000Z',
        expectedSha256: `sha256:${'a'.repeat(64)}`,
        title: 'Publisher methods',
      }).success
    ).toBe(false);
    expect(
      capturePaperSourceTextSchema.safeParse({
        originalUrl: 'https://example.org/paper',
        canonicalUrl: 'https://example.org/paper',
        mediaType: 'text/html',
        capturedText: 'x'.repeat(100_001),
        capturedAt: '2026-08-19T03:00:00.000Z',
        expectedSha256: `sha256:${'a'.repeat(64)}`,
        title: 'Publisher methods',
      }).success
    ).toBe(false);
  });
});

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')}`;
}
