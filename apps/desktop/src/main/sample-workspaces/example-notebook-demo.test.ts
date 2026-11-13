import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseNotebookPackageDocument, isNotebookPackageMetaPath } from '../../db/notebook-package';
import { evaluateAllFormulas } from '../../shared/notebook-model/table/utils/formulas';
import type { Cell } from '../../shared/table-document-types';

const REL = 'resources/sample-workspaces/standard-samples/workspace';
const WS = [join(process.cwd(), REL), join(process.cwd(), 'apps/desktop', REL)].find(
  existsSync
) as string;
const TITLE = 'MoClo Golden Gate — red fluorescent transcription unit';
const PKG = join(WS, 'notebooks', TITLE);
const META = join(PKG, '.forge/notebook.json');

function collect(node: unknown, type: string, out: Record<string, unknown>[] = []) {
  if (!node || typeof node !== 'object') return out;
  const n = node as Record<string, unknown>;
  if (n.type === type && n.attrs && typeof n.attrs === 'object')
    out.push(n.attrs as Record<string, unknown>);
  if (Array.isArray(n.content)) for (const c of n.content) collect(c, type, out);
  return out;
}
function embedsOfType(doc: unknown, embedType: string) {
  return collect(doc, 'embed')
    .filter((a) => a.type === embedType)
    .map((a) => a.data as any);
}

describe('example workspace — MoClo Golden Gate notebook is a valid, self-registering page', () => {
  it('the notebook package files exist', () => {
    expect(existsSync(META), META).toBe(true);
    expect(existsSync(join(PKG, `${TITLE}.md`))).toBe(true);
    expect(isNotebookPackageMetaPath(META)).toBe(true);
  });

  it('parses as a waypoint.notebook.v1 package (self-registers on open)', () => {
    const doc = parseNotebookPackageDocument(readFileSync(META, 'utf8'));
    expect(doc.schema).toBe('waypoint.notebook.v1');
    expect(doc.kind).toBe('notebook');
    expect(doc.id).toBe('example-moclo-golden-gate');
    expect(doc.title).toBe(TITLE);
    expect(doc.storage).toEqual({
      type: 'database',
      table: 'pages',
      id: 'example-moclo-golden-gate',
    });
  });

  it('content is a TipTap doc with headings, checklists, and embeds', () => {
    const doc = parseNotebookPackageDocument(readFileSync(META, 'utf8'));
    const content = doc.content as { type: string; content: { type: string }[] };
    expect(content.type).toBe('doc');
    expect(content.content.some((n) => n.type === 'heading')).toBe(true);
    expect(content.content.some((n) => n.type === 'taskList')).toBe(true);
    expect(content.content.some((n) => n.type === 'embed')).toBe(true);
  });

  it('every sequence @-mention resolves to a shipped kit-part file, and all five parts are linked', () => {
    const doc = parseNotebookPackageDocument(readFileSync(META, 'utf8'));
    const seqMentions = collect(doc.content, 'mention').filter((m) => m.entityType === 'sequence');
    expect(seqMentions.length).toBeGreaterThanOrEqual(5);
    for (const m of seqMentions) {
      const rel = String(m.path ?? '');
      expect(rel, 'mention needs a portable package path').toBeTruthy();
      expect(m.entityId, 'mention needs a catalog identity').toBeTruthy();
      expect(existsSync(join(WS, rel)), `mention target missing: ${rel}`).toBe(true);
      const stem = rel.split('/').pop();
      expect(existsSync(join(WS, rel, `${stem}.gb`)), `package member missing: ${rel}`).toBe(true);
      expect(m.label, 'mention needs a display label').toBeTruthy();
    }
    const distinctParts = new Set(seqMentions.map((m) => String(m.path)));
    expect(distinctParts).toEqual(
      new Set([
        'sequences/kits/moclo-cidar/J23106_AB',
        'sequences/kits/moclo-cidar/B0034m_BC',
        'sequences/kits/moclo-cidar/E1010m_CD',
        'sequences/kits/moclo-cidar/B0015_DE',
        'sequences/kits/moclo-cidar/DVA_AE',
      ])
    );
  });

  it('embeds a 3D protein structure by PDB id', () => {
    const doc = parseNotebookPackageDocument(readFileSync(META, 'utf8'));
    const structs = embedsOfType(doc.content, 'structure3d');
    expect(structs.length).toBeGreaterThan(0);
    for (const s of structs) {
      expect(s.source).toBe('pdb');
      expect(String(s.sourceId)).toMatch(/^[0-9A-Za-z]{4}$/);
    }
  });

  it('every table is rectangular and every formula cell computes (no #VALUE!)', () => {
    const doc = parseNotebookPackageDocument(readFileSync(META, 'utf8'));
    const tables = embedsOfType(doc.content, 'table');
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) {
      for (const row of t.cells) expect(row.length).toBe(t.cols);
      const computed = evaluateAllFormulas(t.cells as Cell[][]);
      for (const row of computed)
        for (const c of row) {
          if (c.type !== 'formula') continue;
          const out = String(c.computed ?? c.value);
          expect(
            /#(REF|ERROR|DIV|NAME|VALUE)|^=/.test(out),
            `bad formula ${c.value} -> ${out}`
          ).toBe(false);
        }
    }
  });

  it('embeds an image as a data URI (self-contained; no external file dependency)', () => {
    const doc = parseNotebookPackageDocument(readFileSync(META, 'utf8'));
    const images = embedsOfType(doc.content, 'image');
    expect(images.length).toBeGreaterThan(0);
    for (const im of images) expect(String(im.src)).toMatch(/^data:image\//);
  });
});
