// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TAB_DOCUMENT_LIFECYCLES, TAB_DOCUMENT_OWNER_MODULES } from './tab-kind';

describe('editable tab registration coverage', () => {
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
