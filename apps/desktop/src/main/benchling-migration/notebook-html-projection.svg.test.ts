import { describe, expect, it } from 'vitest';
import { buildNotebookHtmlProjection } from './notebook-html-projection';
import type { SourceObject } from '../../shared/benchling-migration';
import { serializeNotebookMarkdown, parseNotebookMarkdown } from '../../db/notebook-markdown-codec';

const figure = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60" aria-label="Imported figure"><defs><linearGradient id="shade"><stop offset="0" stop-color="#0088ff"/><stop offset="1" stop-color="#00aa66"/></linearGradient><clipPath id="clip"><rect width="120" height="60"/></clipPath></defs><g clip-path="url(#clip)"><rect width="120" height="60" fill="url(#shade)"/><text x="8" y="30">α &amp; β</text></g></svg>`;

function project(html: string) {
  const source: SourceObject = {
    id: 'etr_FidelitySvg',
    stableId: 'etr_FidelitySvg',
    sourceType: 'notebook_entry',
    name: 'Fidelity notebook',
    aliases: [],
    sourceUrl: 'https://benchling.com/example/etr_FidelitySvg',
    attachmentHashes: [],
    memberships: [],
    metadata: {},
    relationships: [],
    content: { html },
  };
  return buildNotebookHtmlProjection(source, {
    capturedAt: '2026-08-30T00:00:00Z',
    converterVersion: 'test',
    attachments: [],
    supportedFormulaNames: [],
  });
}

function images(result: ReturnType<typeof project>) {
  return (
    result.document.content.content?.filter(
      (node) => node.type === 'embed' && node.attrs?.type === 'image'
    ) ?? []
  );
}

describe('imported inline SVG figures', () => {
  it.each([
    '<p>before FIGURE after</p>',
    '<h2>Figure FIGURE</h2>',
    '<table><tr><td>FIGURE</td></tr></table>',
  ])('renders static SVG in %s', (wrapper) => {
    const result = project(wrapper.replace('FIGURE', figure));
    expect(images(result)).toHaveLength(1);
    const data = images(result)[0].attrs?.data;
    expect(data).toMatchObject({
      alt: 'Imported figure',
      mediaType: 'image/svg+xml',
      source: 'upload',
    });
    const svg = Buffer.from(String(data?.src).split(',')[1], 'base64').toString('utf8');
    expect(svg).toContain('viewBox="0 0 120 60"');
    expect(svg).toContain('<linearGradient');
    expect(svg).toContain('<clipPath');
    expect(svg).toContain('α &amp; β');
    expect(result.unsupportedWidgetCount).toBe(0);
  });

  it('still excludes recognized interface icons but preserves a plain figure', () => {
    const result = project(
      `<svg data-test-component="BenchlingIcon" data-testid="benchlingicon-clock" data-icon="clock" aria-hidden="true" class="svg-inline--fa"><path d="M0 0"/></svg>${figure}`
    );
    expect(images(result)).toHaveLength(1);
    expect(result.unsupportedWidgetCount).toBe(0);
  });

  it('gives unsupported SVG dependencies a visible explanation', () => {
    const result = project(
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.invalid/figure.png"/></svg>'
    );
    expect(images(result)).toHaveLength(0);
    expect(JSON.stringify(result.document.content)).toContain('SVG figure unavailable');
    expect(JSON.stringify(result.document.content)).toContain('external');
    expect(result.warnings.some((warning) => warning.includes('SVG'))).toBe(true);
    expect(result.unsupportedWidgetCount).toBe(1);
  });

  it('keeps the actual figure through canonical notebook save and reopen', () => {
    const result = project(figure);
    const saved = serializeNotebookMarkdown({
      identity: { id: result.destinationObjectId, title: 'Fidelity notebook', formatVersion: 2 },
      content: result.document.content,
    });
    const reopened = parseNotebookMarkdown({
      markdown: saved.markdown,
      payloads: new Map(saved.payloads.map((payload) => [payload.relativePath, payload.content])),
    });
    expect(reopened.content).toEqual(result.document.content);
    expect(JSON.stringify(reopened.content)).toContain('data:image/svg+xml;base64,');
  });

  it('keeps an incomplete SVG visibly unavailable instead of silently dropping it', () => {
    const result = project('<p>Before</p><svg><path d="M0 0L10 10"/>');
    expect(images(result)).toHaveLength(0);
    expect(JSON.stringify(result.document.content)).toContain('SVG figure unavailable:');
  });
});
