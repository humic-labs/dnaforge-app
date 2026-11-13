// @vitest-environment node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolvePageReference } from './resolve-page-reference';
import { scopedProjectionId } from '../../../shared/workspace-scoped-identity';

const WORKSPACE = join(
  __dirname,
  '../../../../resources/sample-workspaces/standard-samples/workspace'
);
const NOTEBOOKS = join(WORKSPACE, 'notebooks');

interface Mention {
  id?: string | null;
  entityType?: string;
  entityId?: string | null;
  path?: string | null;
  label?: string;
}

interface CorpusEntry {
  dir: string;
  docId: string;
  title: string;
  mentions: Mention[];
}

function loadCorpus(): CorpusEntry[] {
  return readdirSync(NOTEBOOKS)
    .filter((name) => existsSync(join(NOTEBOOKS, name, '.forge', 'notebook.json')))
    .sort()
    .map((dir) => {
      const raw = readFileSync(join(NOTEBOOKS, dir, '.forge', 'notebook.json'), 'utf8');
      const doc = JSON.parse(raw) as { id: string; title: string; content?: unknown };
      const mentions: Mention[] = [];
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== 'object') return;
        const n = node as { type?: string; attrs?: Mention; content?: unknown[] };
        if (n.type === 'mention' && n.attrs) mentions.push(n.attrs);
        if (n.content) walk(n.content);
      };
      walk(doc.content);
      return { dir, docId: doc.id, title: doc.title, mentions };
    });
}

const corpus = loadCorpus();

describe('shipped notebook corpus — reference integrity (no app required)', () => {
  it('the corpus is actually present, so nothing below can pass vacuously', () => {
    expect(existsSync(NOTEBOOKS), `corpus missing at ${NOTEBOOKS}`).toBe(true);
    expect(corpus.length).toBeGreaterThanOrEqual(15);
    const total = corpus.reduce((n, e) => n + e.mentions.length, 0);
    expect(total, 'the corpus must carry a substantial number of references').toBeGreaterThan(100);
  });

  it('every sequence reference names its managed package, never its internal product file', () => {
    const invalid: string[] = [];
    for (const entry of corpus) {
      for (const m of entry.mentions) {
        if (m.entityType !== 'sequence') continue;
        const packagePath = m.path ?? '';
        if (
          !m.entityId ||
          m.id !== m.entityId ||
          !packagePath ||
          /\.(?:gb|gbk|gbff|genbank)$/i.test(packagePath)
        ) {
          invalid.push(`${entry.dir} -> ${m.entityId ?? '(no package id)'} @ ${packagePath}`);
          continue;
        }
        const metadataPath = join(WORKSPACE, packagePath, '.forge', 'plasmid.json');
        if (!existsSync(metadataPath)) {
          invalid.push(`${entry.dir} -> missing package ${packagePath}`);
          continue;
        }
        const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as { id?: string };
        if (metadata.id !== m.entityId) {
          invalid.push(`${entry.dir} -> ${m.entityId} does not match ${metadata.id ?? '(no id)'}`);
        }
      }
    }
    expect(invalid, `invalid managed sequence references:\n${invalid.join('\n')}`).toEqual([]);
  });

  it('every PAGE reference names a notebook that ships in the corpus', () => {
    const ids = new Set(corpus.map((e) => e.docId));
    const dangling: string[] = [];
    for (const entry of corpus) {
      for (const m of entry.mentions) {
        if (m.entityType !== 'page' || !m.entityId) continue;
        if (!ids.has(m.entityId)) dangling.push(`${entry.dir} -> ${m.entityId}`);
      }
    }
    expect(dangling, `cross-entry links to unknown notebooks:\n${dangling.join('\n')}`).toEqual([]);
  });

  it('🟥 every PAGE reference RESOLVES through the app’s own resolver', () => {
    const scope = 'ws651';
    const pageIds = corpus.map((e) => scopedProjectionId(scope, e.docId));

    const unresolved: string[] = [];
    let checked = 0;
    for (const entry of corpus) {
      for (const m of entry.mentions) {
        if (m.entityType !== 'page' || !m.entityId) continue;
        checked += 1;
        const resolution = resolvePageReference({
          referencedId: m.entityId,
          owningScope: scope,
          pageIds,
        });
        if (resolution.kind !== 'resolved') {
          unresolved.push(`${entry.dir} -> ${m.entityId} (${resolution.kind})`);
        }
      }
    }
    expect(checked, 'the corpus must contain cross-entry links to check').toBeGreaterThan(40);
    expect(
      unresolved,
      `cross-entry references that do not resolve:\n${unresolved.join('\n')}`
    ).toEqual([]);
  });

  it('🟥 resolves references that arrive scoped to a DIFFERENT installation', () => {
    const here = 'ws651';
    const pageIds = corpus.map((e) => scopedProjectionId(here, e.docId));
    const unresolved: string[] = [];
    for (const entry of corpus) {
      for (const m of entry.mentions) {
        if (m.entityType !== 'page' || !m.entityId) continue;
        const asShared = scopedProjectionId('ws999', m.entityId);
        const resolution = resolvePageReference({
          referencedId: asShared,
          owningScope: here,
          pageIds,
        });
        if (resolution.kind !== 'resolved') unresolved.push(`${entry.dir} -> ${asShared}`);
      }
    }
    expect(unresolved, `foreign-scoped references that break:\n${unresolved.join('\n')}`).toEqual(
      []
    );
  });

  it('every reference declares a kind the app knows how to open', () => {
    const OPENABLE = new Set(['sequence', 'page', 'design']);
    const unknown: string[] = [];
    for (const entry of corpus) {
      for (const m of entry.mentions) {
        if (!m.entityType || !OPENABLE.has(m.entityType)) {
          unknown.push(`${entry.dir} -> ${m.label ?? '(no label)'} (${m.entityType})`);
        }
      }
    }
    expect(unknown, `references the app cannot open:\n${unknown.join('\n')}`).toEqual([]);
  });
});
