// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TAB_DOCUMENT_LIFECYCLES, TAB_DOCUMENT_OWNER_MODULES } from './tab-kind';

describe('editable tab registration coverage', () => {
  it('includes every production module that registers an editor in the quit journey inventory', () => {
    const root = new URL('../', import.meta.url);
    const modules = readdirSync(fileURLToPath(root), { recursive: true, encoding: 'utf8' })
      .map((path) => path.replaceAll('\\', '/'))
      .filter(
        (path) =>
          /\.tsx?$/.test(path) &&
          !/\.(test|spec)\./.test(path) &&
          path !== 'shared/use-document-lifecycle.ts'
      )
      .filter((path) =>
        /\b(?:useDocumentLifecycle|documentLifecycle\.register)\s*\(/.test(
          readFileSync(new URL(path, root), 'utf8')
        )
      );
    expect([...new Set(Object.values(TAB_DOCUMENT_OWNER_MODULES).flat())].sort()).toEqual(
      modules.sort()
    );
  });

  it('links every editable tab kind to its maintained domain adapters', () => {
    expect(Object.keys(TAB_DOCUMENT_OWNER_MODULES).sort()).toEqual(
      Object.entries(TAB_DOCUMENT_LIFECYCLES)
        .filter(([, mode]) => mode === 'editable')
        .map(([kind]) => kind)
        .sort()
    );
    for (const modules of Object.values(TAB_DOCUMENT_OWNER_MODULES)) {
      for (const module of modules) {
        const source = readFileSync(new URL(`../${module}`, import.meta.url), 'utf8');
        if (/documentLifecycle\.register\(/.test(source)) {
          const registration = source.match(
            /\b((?:this\.)?\w+)\s*=\s*documentLifecycle\.register\(/
          )?.[1];
          expect(registration, module).toBeDefined();
          expect(source, module).toContain(`${registration}.release()`);
        } else {
          expect(source, module).toMatch(/useDocumentLifecycle\(/);
        }
        expect(source, module).not.toMatch(
          /(?:addEventListener|removeEventListener)\(['"](?:save-document-request|discard-document-request|save-document-complete)['"]/
        );
      }
    }
  });
});
