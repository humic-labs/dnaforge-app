import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import {
  tryHandleCopy,
  type SequenceKeyboardHost,
} from '../../../../../packages/core/workspace-editor/src/hooks/keyboard-navigation-handlers';
import type { BoundPrimer } from '../primers/public/types';
import { sequenceEditorSession, useSequenceStore } from '../sequence/public/store';
import { useRichSequenceClipboardStore } from './store';
import {
  useRichSequenceClipboard,
  type SequenceClipboardSelection,
} from './use-rich-sequence-clipboard';

const DOC = 'draft-primer-copy';
const WORKSPACE = '/synthetic/draft-primer-workspace';
const BASES = 'ACGTTGCA';
const writeText = vi.fn<(text: string) => Promise<void>>();
let clipboardDescriptor: PropertyDescriptor | undefined;

type DraftCopy = NonNullable<SequenceKeyboardHost['onCopyDraftSelection']>;

function actualViewerBridge(
  onCopy: (selection: SequenceClipboardSelection) => Promise<void>
): DraftCopy {
  const file = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../sequence/components/WorkspaceViewer.tsx'
  );
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const callbacks: ts.Expression[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(source) === 'onCopyDraftSelection' &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression
    ) {
      callbacks.push(node.initializer.expression);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(callbacks, 'ACTUAL_WORKSPACE_VIEWER_COPY_CALLBACK_REQUIRED').toHaveLength(1);
  expect(ts.isArrowFunction(callbacks[0])).toBe(true);
  const code = ts.transpileModule(`const bridge = ${callbacks[0].getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const bridge: unknown = runInNewContext(`${code}\nbridge`, { onCopy });
  expect(typeof bridge).toBe('function');
  return bridge as DraftCopy;
}

function savedPrimer(): BoundPrimer {
  return {
    id: 'saved-TG',
    catalogNumber: 'synthetic-1',
    name: 'saved TG',
    sequence: 'TG',
    length: 2,
    tm: null,
    gcPercent: 50,
    origin: 'manual',
    originDetails: null,
    status: 'designed',
    vendor: null,
    orderDate: null,
    application: null,
    scale: null,
    purification: null,
    modifications: null,
    stockLocation: null,
    concentration: null,
    notes: null,
    workspaceId: null,
    createdAt: 1,
    updatedAt: 1,
    binding: {
      id: 'synthetic-saved-binding',
      primerId: 'saved-TG',
      sequenceId: 1,
      bindingStart: 4,
      bindingEnd: 6,
      strand: 1,
      source: 'manual',
      createdAt: 1,
      updatedAt: 1,
    },
  };
}

function selectAll(): void {
  useSequenceStore.getState().dispatchEdit(DOC, { type: 'SELECT_ALL' });
}

function deletePrefix(): void {
  const store = useSequenceStore.getState();
  store.dispatchEdit(DOC, { type: 'SET_SELECTION', selection: { start: 0, end: 1 } });
  store.dispatchEdit(DOC, { type: 'DELETE_SELECTION' });
}

async function copyDraft(primerRecords: BoundPrimer[] = [savedPrimer()]) {
  selectAll();
  const before = useSequenceStore.getState();
  const sequence = before.sequences[DOC];
  expect(sequence).toBeDefined();
  const { result } = renderHook(() =>
    useRichSequenceClipboard({
      documentId: DOC,
      displayName: 'synthetic draft primer copy',
      sequence,
      primerRecords,
      workspaceRoot: WORKSPACE,
    })
  );
  let pending: Promise<void> | undefined;
  const bridge = actualViewerBridge((selection) => {
    pending = result.current.copySelection(selection);
    return pending;
  });
  const session = sequenceEditorSession(DOC);
  const host: SequenceKeyboardHost = {
    editable: true,
    editorState: session.getState(),
    editorDispatch: session.dispatch,
    selection: null,
    sequence,
    handleSelectionChange: vi.fn(),
    effectiveCharsPerLine: 40,
    handleCommit: vi.fn(),
    highlightedRange: null,
    currentViewCursor: null,
    capturedViewCursor: null,
    viewModeAnchorRef: { current: null },
    scrollPositionIntoView: vi.fn(),
    onCopyDraftSelection: bridge,
  };
  const key = new KeyboardEvent('keydown', { key: 'c', metaKey: true, cancelable: true });
  await act(async () => {
    expect(tryHandleCopy(key, host)).toBe(true);
    expect(pending, 'REAL_RICH_COPY_CALLBACK_NOT_REACHED').toBeDefined();
    await pending;
  });
  expect(key.defaultPrevented).toBe(true);
  expect(writeText).toHaveBeenCalledExactlyOnceWith(sequence.sequence);
  const fragment = useRichSequenceClipboardStore.getState().copiedRegion;
  expect(fragment, 'REAL_CLIPBOARD_STORE_WAS_NOT_WRITTEN').not.toBeNull();
  expect(fragment!.sequence).toBe(sequence.sequence);
  expect(useSequenceStore.getState(), 'COPY_MUST_NOT_WRITE_DOCUMENT_STATE').toBe(before);
  return { fragment: fragment!, paste: result.current.resolvePasteFragment(sequence.sequence) };
}

beforeEach(() => {
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  window.getSelection()?.removeAllRanges();
  useRichSequenceClipboardStore.getState().clear();
  useSequenceStore.getState().clearAll();
  const sequence: AnnotatedSequence = {
    id: DOC,
    name: 'synthetic draft primer copy',
    sequence: BASES,
    length: BASES.length,
    annotations: [],
    circular: false,
  };
  useSequenceStore.getState().setSequence(DOC, sequence);
});

afterEach(() => {
  cleanup();
  useSequenceStore.getState().clearAll();
  useRichSequenceClipboardStore.getState().clear();
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

describe('real draft-copy primer ownership', () => {
  it('keeps an unedited saved primer attached to its original bases', async () => {
    const { fragment } = await copyDraft();
    expect(fragment.primerBindings).toMatchObject([
      { primerId: 'saved-TG', start: 4, end: 6, strand: 1 },
    ]);
    expect(fragment.primerBindings).toHaveLength(1);
    expect(fragment.sequence.slice(4, 6)).toBe('TG');
  });

  it('projects a saved primer through a deleted prefix into the copied clean sequence', async () => {
    deletePrefix();
    const { fragment } = await copyDraft();
    expect(fragment.sequence).toBe('GTTGCA');
    expect(fragment.primerBindings, 'SAVED_PRIMER_STILL_USES_PRE_DELETE_COORDINATES').toMatchObject(
      [{ primerId: 'saved-TG', start: 2, end: 4, strand: 1 }]
    );
    expect(fragment.primerBindings).toHaveLength(1);
    expect(fragment.sequence.slice(2, 4)).toBe('TG');
  });

  it('projects a saved primer through an insertion before its binding', async () => {
    const store = useSequenceStore.getState();
    store.dispatchEdit(DOC, { type: 'SET_CURSOR', position: 0 });
    store.dispatchEdit(DOC, { type: 'INSERT', text: 'AA' });
    const { fragment } = await copyDraft();
    expect(fragment.sequence).toBe('AAACGTTGCA');
    expect(fragment.primerBindings, 'SAVED_PRIMER_STILL_USES_PRE_INSERT_COORDINATES').toMatchObject(
      [{ primerId: 'saved-TG', start: 6, end: 8, strand: 1 }]
    );
    expect(fragment.primerBindings).toHaveLength(1);
    expect(fragment.sequence.slice(6, 8)).toBe('TG');
  });

  it('uses the saved baseline after the bounded editor history has rolled over', async () => {
    for (let index = 0; index < 105; index += 1) {
      const store = useSequenceStore.getState();
      store.dispatchEdit(DOC, { type: 'SET_CURSOR', position: 0 });
      store.dispatchEdit(DOC, { type: 'INSERT', text: 'A' });
    }
    expect(sequenceEditorSession(DOC).getState().history.length).toBeLessThanOrEqual(100);
    const { fragment } = await copyDraft();
    expect(fragment.sequence).toBe('A'.repeat(105) + BASES);
    expect(
      fragment.primerBindings,
      'SAVED_PRIMER_BASELINE_LOST_AFTER_HISTORY_ROLLOVER'
    ).toMatchObject([{ primerId: 'saved-TG', start: 109, end: 111, strand: 1 }]);
    expect(fragment.primerBindings).toHaveLength(1);
    expect(fragment.sequence.slice(109, 111)).toBe('TG');
  });

  it('cleans an already-shifted pending primer exactly once', async () => {
    const store = useSequenceStore.getState();
    store.dispatchEdit(DOC, { type: 'SET_CURSOR', position: 4 });
    store.dispatchEdit(DOC, {
      type: 'INSERT_FRAGMENT',
      fragment: {
        sequence: 'TT',
        annotations: [],
        primerBindings: [
          { primerId: 'pending-TT', start: 0, end: 2, strand: 1, sourceWorkspaceRoot: WORKSPACE },
        ],
      },
    });
    deletePrefix();
    const { fragment, paste } = await copyDraft([]);
    expect(fragment.sequence).toBe('GTTTTGCA');
    expect(paste?.primerBindings, 'PENDING_PRIMER_WAS_DROPPED_OR_TRANSFORMED_TWICE').toMatchObject([
      { primerId: 'pending-TT', start: 2, end: 4, strand: 1, sourceWorkspaceRoot: WORKSPACE },
    ]);
    expect(paste?.primerBindings).toHaveLength(1);
    expect(fragment.sequence.slice(2, 4)).toBe('TT');
  });

  it('preserves a foreign pending primer owner instead of relabeling it as the current project', async () => {
    const store = useSequenceStore.getState();
    store.dispatchEdit(DOC, { type: 'SET_CURSOR', position: 4 });
    store.dispatchEdit(DOC, {
      type: 'INSERT_FRAGMENT',
      fragment: {
        sequence: 'TT',
        annotations: [],
        primerBindings: [
          {
            primerId: 'foreign-TT',
            start: 0,
            end: 2,
            strand: 1,
            sourceWorkspaceRoot: '/synthetic/foreign-workspace',
          },
        ],
      },
    });
    const { paste } = await copyDraft([]);
    expect(
      paste?.primerBindings,
      'FOREIGN_PENDING_PRIMER_OWNER_WAS_LOST_OR_RELABELED'
    ).toMatchObject([
      {
        primerId: 'foreign-TT',
        start: 4,
        end: 6,
        strand: 1,
        sourceWorkspaceRoot: '/synthetic/foreign-workspace',
      },
    ]);
    expect(paste?.primerBindings).toHaveLength(1);
  });
});
