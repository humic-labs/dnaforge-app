import { resultTool } from '../../agent-bridge/public/tool-result';
import { runPaperTool } from './paper-tool-result';
import { z } from 'zod';

import { sha256PaperProtocolPayload } from '../../scientific-document/public/paper-protocol-model';

const safeSourceUrl = z
  .string()
  .min(1)
  .max(2_000)
  .refine(isSafeHttpUrl, 'Source URL must be a credential-free HTTP(S) URL.');

export const capturePaperSourceTextSchema = z
  .object({
    originalUrl: safeSourceUrl.describe('URL the user or agent originally opened.'),
    canonicalUrl: safeSourceUrl.describe('Canonical URL reported by the source when known.'),
    mediaType: z
      .enum(['text/html', 'text/plain', 'application/xml', 'text/xml', 'application/jats+xml'])
      .describe('Media type of the captured textual representation.'),
    capturedText: z
      .string()
      .min(1)
      .refine(
        (value) => new TextEncoder().encode(value).byteLength <= 100_000,
        'Captured source text must be at most 100,000 UTF-8 bytes.'
      ),
    capturedAt: z
      .string()
      .refine(isExactUtcTimestamp, 'Capture time must be an ISO-8601 UTC timestamp.'),
    expectedSha256: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .describe('SHA-256 identity computed by the capability that obtained the text.'),
    title: z.string().min(1).max(200),
  })
  .strict();

export type CapturePaperSourceTextInput = z.infer<typeof capturePaperSourceTextSchema>;

export type CapturedPaperTextBlock = {
  blockId: string;
  start: number;
  end: number;
  text: string;
};

export async function capturePaperSourceText(input: CapturePaperSourceTextInput) {
  const parsed = capturePaperSourceTextSchema.parse(input);
  const actualSha256 = await sha256PaperProtocolPayload(parsed.capturedText);
  if (actualSha256 !== parsed.expectedSha256) {
    throw new Error('Captured source text hash does not match the expected identity.');
  }
  const blocks = textBlocks(parsed.capturedText);
  if (blocks.length === 0) throw new Error('Captured source text has no readable blocks.');
  if (blocks.length > 500) throw new Error('Captured source text has more than 500 blocks.');
  return {
    source: {
      sourceId: `text:${actualSha256.slice('sha256:'.length, 'sha256:'.length + 24)}`,
      kind: 'captured_text' as const,
      title: parsed.title,
      mediaType: parsed.mediaType,
      sha256: actualSha256,
      capturedAt: parsed.capturedAt,
      originalUrl: new URL(parsed.originalUrl).href,
      canonicalUrl: new URL(parsed.canonicalUrl).href,
      text: parsed.capturedText,
    },
    blocks,
  };
}

export const capturePaperSourceTool = resultTool({
  description:
    'Validate and pin bounded paper text already obtained through a native web/URL capability. ' +
    'This does not fetch URLs. It returns exact stable blocks for protocol evidence and rejects ' +
    'changed content, unsafe provenance URLs, or oversized captures.',
  inputSchema: capturePaperSourceTextSchema,
  execute: async (input: CapturePaperSourceTextInput) =>
    runPaperTool('CAPTURE_PAPER_SOURCE_FAILED', () => capturePaperSourceText(input)),
});

function textBlocks(text: string): CapturedPaperTextBlock[] {
  const blocks: CapturedPaperTextBlock[] = [];
  const pattern = /\S[\s\S]*?(?=\n[ \t]*\n|$)/gu;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    const blockText = match[0].replace(/[ \t\r\n]+$/u, '');
    if (!blockText) continue;
    blocks.push({
      blockId: `text-b${blocks.length + 1}`,
      start,
      end: start + blockText.length,
      text: blockText,
    });
  }
  return blocks;
}

function isSafeHttpUrl(value: string): boolean {
  if (/[\0\r\n]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

function isExactUtcTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export { capturePaperSourceOutputSchema } from './paper-output-schemas';
