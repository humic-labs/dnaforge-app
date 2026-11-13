// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  TOAST_DEFINITIONS,
  TOAST_REVIEW_ENTRIES,
  TOAST_TIMING_POLICIES,
  resolveToastDefinition,
} from './toast-definitions';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__' || entry.name === 'generated') return [];
    const file = join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(file)
      : /\.(ts|tsx)$/.test(file) && !/\.test\./.test(file)
        ? [file]
        : [];
  });
}

describe('toast catalog coverage', () => {
  it('normalizes every lifetime through a named timing policy, including variants', () => {
    expect(
      Object.fromEntries(
        Object.entries(TOAST_TIMING_POLICIES).map(([name, policy]) => [name, policy.duration])
      )
    ).toEqual({
      confirmation: 4000,
      notice: 8000,
      announcement: 10000,
      persistent: 0,
    });
    for (const entry of TOAST_REVIEW_ENTRIES) {
      expect(entry.duration).toBe(TOAST_TIMING_POLICIES[entry.timing].duration);
    }
    expect(resolveToastDefinition({ definition: 'post-update' })).toMatchObject({
      timing: 'announcement',
      duration: 10000,
    });
    expect(
      resolveToastDefinition({ definition: 'file-import-result', variant: 'success' })
    ).toMatchObject({ timing: 'confirmation', duration: 4000 });
    expect(
      resolveToastDefinition({ definition: 'file-import-result', variant: 'warning' })
    ).toMatchObject({ timing: 'notice', duration: 8000 });
    expect(resolveToastDefinition({ definition: 'update-ready' })).toMatchObject({
      timing: 'persistent',
      duration: 0,
    });
  });

  it('requires every production creation call to select a known definition and central policy', () => {
    const failures: string[] = [];
    const used = new Set<string>();
    for (const file of sourceFiles(dirname(dirname(__filename)))) {
      if (
        file.endsWith('/stores/toast-store.ts') ||
        file.endsWith('/components/ToastReviewPanel.tsx')
      )
        continue;
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true
      );
      function visit(node: ts.Node): void {
        if (
          ts.isCallExpression(node) &&
          /(?:^|\.)(addToast|addRichToast)$/.test(node.expression.getText(source))
        ) {
          const rich = /addRichToast$/.test(node.expression.getText(source));
          const selection = node.arguments[rich ? 0 : 1];
          const properties =
            selection && ts.isObjectLiteralExpression(selection) ? selection.properties : [];
          const definition = properties.find(
            (p) => ts.isPropertyAssignment(p) && p.name.getText(source) === 'definition'
          );
          const id =
            definition &&
            ts.isPropertyAssignment(definition) &&
            ts.isStringLiteral(definition.initializer)
              ? definition.initializer.text
              : '';
          const overrides = properties.some(
            (p) =>
              p.name &&
              [
                'duration',
                'timing',
                'type',
                'dismissOn',
                'closeButton',
                'pauseOnInteraction',
                'actionDismisses',
                'group',
                'groupExit',
                'oncePerKey',
                'keyScope',
                'clearsGroups',
                'clearsKeys',
              ].includes(p.name.getText(source))
          );
          if (
            !id ||
            !(id in TOAST_DEFINITIONS) ||
            overrides ||
            (!rich && node.arguments.length > 2)
          ) {
            failures.push(
              file + ':' + (source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1)
            );
          }
          if (id in TOAST_DEFINITIONS) {
            const policy = TOAST_DEFINITIONS[id as keyof typeof TOAST_DEFINITIONS];
            const variant = properties.find((p) => p.name?.getText(source) === 'variant');
            if (policy.requiresVariant && !variant) failures.push(file + ': missing variant');
            if (
              variant &&
              ts.isPropertyAssignment(variant) &&
              ts.isStringLiteral(variant.initializer)
            ) {
              try {
                resolveToastDefinition({
                  definition: id as keyof typeof TOAST_DEFINITIONS,
                  variant: variant.initializer.text,
                });
              } catch {
                failures.push(file + ': unknown variant');
              }
            }
          }
          if (id) used.add(id);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    expect(failures).toEqual([]);
    expect(Object.keys(TOAST_DEFINITIONS).filter((id) => !used.has(id))).toEqual([]);
  }, 30_000);

  it('has a review example for every definition and declared behavior variant', () => {
    expect(new Set(TOAST_REVIEW_ENTRIES.map((entry) => entry.id)).size).toBe(
      TOAST_REVIEW_ENTRIES.length
    );
    for (const entry of TOAST_REVIEW_ENTRIES) {
      expect(entry.message.trim()).not.toBe('');
      expect(Number.isFinite(entry.duration) && entry.duration >= 0).toBe(true);
      expect(resolveToastDefinition(entry).type).toBe(entry.type);
    }
  });

  it('rejects unknown variants instead of silently using a different policy', () => {
    expect(() => resolveToastDefinition({ definition: 'post-update', variant: 'missing' })).toThrow(
      'Unknown toast variant'
    );
    expect(() => resolveToastDefinition({ definition: 'update-error' })).toThrow(
      'Toast requires a declared variant'
    );
  });
});
