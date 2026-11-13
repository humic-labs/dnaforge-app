// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { toUserMessage } from '@waypoint/user-messages';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { useStructureDrawerStore } from './use-structure-drawer-store';

type StructureDrawerState = ReturnType<typeof useStructureDrawerStore.getState>;

const source = ts.createSourceFile(
  'main.tsx',
  readFileSync(new URL('../../../main.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);
const readers: ts.Expression[] = [];
function visit(node: ts.Node): void {
  if (
    ts.isPropertyAssignment(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === 'getStructureDrawerState'
  ) {
    readers.push(node.initializer);
  }
  ts.forEachChild(node, visit);
}
visit(source);
const [readerExpression] = readers;
if (readers.length !== 1 || !readerExpression) {
  throw new Error('Expected one actual Structure drawer test-state reader');
}
const script = ts.transpileModule(`(${readerExpression.getText(source)});`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function readSnapshot(
  status: StructureDrawerState['status'],
  error: StructureDrawerState['error']
): unknown {
  const reader: unknown = runInNewContext(script, {
    useStructureDrawerStore: {
      getState: () => ({
        requestId: 7,
        status,
        request: null,
        resolved: null,
        cacheHit: false,
        currentStep: null,
        error,
        committedCandidateId: null,
        previewCandidateId: null,
        candidatePickerOpen: false,
        isSlowLoad: false,
      }),
    },
    toUserMessage,
  });
  if (typeof reader !== 'function') throw new Error('Expected an executable test-state reader');
  return reader();
}

describe('actual Structure drawer test-state reader', () => {
  it.each(['ready', 'no_match'] as const)('preserves absent errors for %s', (status) => {
    expect(readSnapshot(status, null)).toMatchObject({ requestId: 7, status, error: null });
  });

  it('still formats a real viewer error through the user-message boundary', () => {
    const error = { code: 'viewer_error', message: 'private renderer diagnostic' };
    expect(readSnapshot('error', error)).toMatchObject({
      requestId: 7,
      status: 'error',
      error: toUserMessage(error, 'operation.failed'),
    });
  });
});
