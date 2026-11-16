import { normalizeNotebookReferences } from '../notebook-reference-normalization';
import { getSchema, type JSONContent } from '@tiptap/core';
import { Fragment, type Schema } from '@tiptap/pm/model';
import { EditorState, Selection, type Transaction } from '@tiptap/pm/state';
import { Step } from '@tiptap/pm/transform';
import { closeHistory, history, undo, redo, undoDepth, redoDepth } from '@tiptap/pm/history';
import { getNotebookBaseExtensions } from './extensions/notebook-model-extensions';
import { NotebookEmbedNode } from './extensions/notebook-embed-model';
import { NotebookMentionNode } from './extensions/notebook-mention-model';
import { canonicalNotebookJson } from '../../db/notebook-markdown-codec';
import { resolveNotebookRichBlockNode } from '../../db/notebook-content-extensions';
import { createConfiguredTableBlock } from './table/configuration';
import { createTableDataMemory, tableDataModel } from './table/table-data-model';
import { executeTableModelCommand } from './table/table-model-commands';
import type { NotebookDocumentOperation } from '../notebook-document';
import type { TableData } from '../table-document-types';

let schema: Schema | undefined;
export function notebookDocumentModelSchema(): Schema {
  return (schema ??= getSchema([
    ...getNotebookBaseExtensions(),
    NotebookEmbedNode,
    NotebookMentionNode,
  ]));
}

export class NotebookDocumentModel {
  state: EditorState;
  private cachedContent: JSONContent | undefined;
  private readonly tables = new Map<string, ReturnType<typeof createTableDataMemory>>();
  private titleUndo: Array<{ title: string; depth: number }> = [];
  private titleRedo: Array<{ title: string; depth: number }> = [];
  constructor(
    content: JSONContent,
    public title: string
  ) {
    const document = notebookDocumentModelSchema().nodeFromJSON(content);
    document.check();
    this.state = EditorState.create({
      schema: notebookDocumentModelSchema(),
      doc: document,
      plugins: [history()],
    });
  }
  get content(): JSONContent {
    return (this.cachedContent ??= this.state.doc.toJSON());
  }
  get canUndo(): boolean {
    return undoDepth(this.state) > 0 || this.titleUndo.length > 0;
  }
  get canRedo(): boolean {
    return redoDepth(this.state) > 0 || this.titleRedo.length > 0;
  }
  get fingerprint(): string {
    return canonicalNotebookJson({ content: this.content, title: this.title });
  }
  apply(transaction: Transaction, traversing = false): void {
    if (transaction.docChanged && !traversing) this.titleRedo = [];
    this.state = this.state.apply(transaction);
    if (transaction.docChanged) this.cachedContent = undefined;
  }
  private canonicalizeTransaction(transaction: Transaction, content?: JSONContent): void {
    if (!content) return;
    const canonical = this.state.schema.nodeFromJSON(content);
    canonical.check();
    const start = transaction.doc.content.findDiffStart(canonical.content);
    const end = transaction.doc.content.findDiffEnd(canonical.content);
    if (start !== null && end) {
      const overlap = Math.max(0, start - Math.min(end.a, end.b));
      transaction.replace(start, end.a + overlap, canonical.slice(start, end.b + overlap));
    }
  }
  applySteps(
    steps: readonly unknown[],
    selection?: unknown,
    separateHistory = false,
    time?: number,
    addToHistory?: boolean,
    canonicalContent?: JSONContent
  ): void {
    let transaction = this.state.tr;
    if (separateHistory) transaction = closeHistory(transaction);
    if (time !== undefined) transaction.setTime(time);
    if (addToHistory === false) transaction.setMeta('addToHistory', false);
    for (const step of steps) transaction.step(Step.fromJSON(this.state.schema, step));
    if (selection) transaction.setSelection(Selection.fromJSON(transaction.doc, selection));
    this.canonicalizeTransaction(transaction, canonicalContent);
    transaction.doc.check();
    this.apply(transaction);
  }
  execute(
    operation: Exclude<
      NotebookDocumentOperation,
      {
        kind:
          | 'schema'
          | 'search'
          | 'list'
          | 'inspect'
          | 'create'
          | 'insert'
          | 'insert-reference'
          | 'save'
          | 'keep-local';
      }
    >
  ): unknown {
    if (operation.kind === 'undo' || operation.kind === 'redo') {
      const source = operation.kind === 'undo' ? this.titleUndo : this.titleRedo,
        destination = operation.kind === 'undo' ? this.titleRedo : this.titleUndo;
      const title = source[source.length - 1];
      if (title && title.depth === undoDepth(this.state)) {
        source.pop();
        destination.push({ title: this.title, depth: undoDepth(this.state) });
        this.title = title.title;
        return { changed: true };
      }
      const command = operation.kind === 'undo' ? undo : redo;
      return { changed: command(this.state, (transaction) => this.apply(transaction, true)) };
    }
    if (operation.kind === 'rename') {
      if (operation.title === this.title) return { changed: false };
      this.apply(closeHistory(this.state.tr));
      this.titleUndo.push({ title: this.title, depth: undoDepth(this.state) });
      if (this.titleUndo.length > 100) this.titleUndo.shift();
      this.titleRedo = [];
      this.title = operation.title;
      return { changed: true };
    }
    if (operation.kind === 'table') return this.table(operation);
    const blocks =
      operation.kind === 'insert-table'
        ? [
            createConfiguredTableBlock(crypto.randomUUID(), {
              rows: operation.rows,
              columns: operation.columns,
            }),
          ]
        : operation.blocks;
    this.splice(
      operation.index,
      operation.kind === 'splice-blocks' ? operation.deleteCount : 0,
      blocks
    );
    return {
      changed: true,
      ...(operation.kind === 'insert-table' ? { tableId: blocks[0].attrs?.refId } : {}),
    };
  }
  splice(
    index: number,
    deleteCount: number,
    blocks: JSONContent[],
    canonicalContent?: JSONContent
  ): void {
    blocks = blocks.map(normalizeNotebookReferences);
    const document = this.state.doc;
    if (index > document.childCount || index + deleteCount > document.childCount)
      throw new Error('The block range is outside this notebook.');
    const validate = (block: JSONContent): void => {
      if (block.type === 'embed' || block.type === 'rawMarkdown')
        resolveNotebookRichBlockNode(block);
      for (const child of block.content ?? []) validate(child);
    };
    blocks.forEach(validate);
    const nodes = blocks.map((block) => document.type.schema.nodeFromJSON(block));
    nodes.forEach((node) => node.check());
    let from = 0,
      to = 0;
    for (let i = 0; i < index + deleteCount; i++) {
      if (i < index) from += document.child(i).nodeSize;
      to += document.child(i).nodeSize;
    }
    const transaction = closeHistory(this.state.tr).replaceWith(
      from,
      to,
      Fragment.fromArray(nodes)
    );
    this.canonicalizeTransaction(transaction, canonicalContent);
    transaction.doc.check();
    this.apply(transaction);
  }
  get tableViews(): Record<
    string,
    { sort: import('../table-document-types').ColumnSort | null; filters: Record<number, string> }
  > {
    return Object.fromEntries(
      [...this.tables].map(([id, memory]) => [id, { sort: memory.sort, filters: memory.filters }])
    );
  }
  setTableView(
    tableId: string,
    view: {
      sort: import('../table-document-types').ColumnSort | null;
      filters: Record<number, string>;
    }
  ): void {
    let matches = 0,
      canonicalId = tableId;
    this.state.doc.descendants((node) => {
      if (
        node.type.name === 'embed' &&
        node.attrs.type === 'table' &&
        (node.attrs.refId === tableId || node.attrs.data?.id === tableId)
      ) {
        matches += 1;
        canonicalId = node.attrs.refId;
      }
    });
    if (matches !== 1) throw new Error('This notebook has no unique table with that identity.');
    let memory = this.tables.get(canonicalId);
    if (!memory) {
      memory = createTableDataMemory();
      this.tables.set(canonicalId, memory);
    }
    memory.sort = view.sort;
    memory.filters = view.filters;
  }
  private table(operation: Extract<NotebookDocumentOperation, { kind: 'table' }>): unknown {
    const matches: Array<{ position: number; data: TableData }> = [];
    this.state.doc.descendants((node, position) => {
      if (
        node.type.name === 'embed' &&
        node.attrs.type === 'table' &&
        (node.attrs.refId === operation.tableId || node.attrs.data?.id === operation.tableId)
      )
        matches.push({ position, data: node.attrs.data as TableData });
    });
    if (matches.length !== 1)
      throw new Error('This notebook has no unique table with that identity.');
    if (operation.command.kind === 'undo' || operation.command.kind === 'redo')
      return this.execute({ kind: operation.command.kind });
    const { position, data } = matches[0];
    let current = data;
    const canonicalId = this.state.doc.nodeAt(position)!.attrs.refId as string;
    let memory = this.tables.get(canonicalId);
    if (!memory) {
      memory = createTableDataMemory(data);
      this.tables.set(canonicalId, memory);
    }
    const table = tableDataModel({
      data: current,
      onUpdateAttrs: (patch) => {
        current = { ...current, ...patch };
      },
      memory,
      changed() {},
    });
    const result = executeTableModelCommand(table, operation.command);
    if (
      operation.command.kind !== 'inspect' &&
      canonicalNotebookJson(current) !== canonicalNotebookJson(data)
    ) {
      const node = this.state.doc.nodeAt(position)!;
      this.apply(
        closeHistory(this.state.tr).setNodeMarkup(position, undefined, {
          ...node.attrs,
          data: current,
        })
      );
    }
    return result;
  }
}
