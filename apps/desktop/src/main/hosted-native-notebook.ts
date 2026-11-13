import { randomUUID } from 'node:crypto';
import { chmod, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';

const MAX_NOTEBOOK_BYTES = 4 * 1024 * 1024;
const MAX_NOTEBOOK_CELLS = 2_000;
const MAX_CELL_SOURCE_LENGTH = 256 * 1024;

type NotebookCellType = 'code' | 'markdown';
type NotebookEditMode = 'replace' | 'insert' | 'delete';

interface NotebookCell extends Record<string, unknown> {
  id?: string;
  cell_type: string;
  source: string | string[];
}

interface NotebookDocument extends Record<string, unknown> {
  cells: NotebookCell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function sourceText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
    return value.join('');
  }
  throw new Error('The notebook contains an invalid cell source.');
}

function parseNotebook(content: string): NotebookDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('The requested notebook is not valid JSON.');
  }
  if (
    !isRecord(parsed) ||
    !Array.isArray(parsed.cells) ||
    parsed.cells.length > MAX_NOTEBOOK_CELLS ||
    !isRecord(parsed.metadata) ||
    !Number.isSafeInteger(parsed.nbformat) ||
    !Number.isSafeInteger(parsed.nbformat_minor)
  ) {
    throw new Error('The requested notebook has an invalid Jupyter structure.');
  }
  const cells = parsed.cells.map((value) => {
    if (!isRecord(value) || typeof value.cell_type !== 'string') {
      throw new Error('The notebook contains an invalid cell.');
    }
    sourceText(value.source);
    if (value.id !== undefined && (typeof value.id !== 'string' || value.id.length > 128)) {
      throw new Error('The notebook contains an invalid cell ID.');
    }
    return value as NotebookCell;
  });
  return { ...parsed, cells } as NotebookDocument;
}

async function readNotebookFile(path: string): Promise<{
  notebook: NotebookDocument;
}> {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_NOTEBOOK_BYTES) {
    throw new Error('The requested notebook is too large.');
  }
  const content = await readFile(path, 'utf8');
  return { notebook: parseNotebook(content) };
}

function notebookLanguage(notebook: NotebookDocument): string {
  const languageInfo = notebook.metadata.language_info;
  if (isRecord(languageInfo) && typeof languageInfo.name === 'string') {
    return languageInfo.name;
  }
  const kernelspec = notebook.metadata.kernelspec;
  if (isRecord(kernelspec)) {
    if (typeof kernelspec.language === 'string') return kernelspec.language;
    if (typeof kernelspec.name === 'string') return kernelspec.name;
  }
  return 'unknown';
}

function validateSource(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_CELL_SOURCE_LENGTH) {
    throw new Error('Native tool input new_source is invalid.');
  }
  return value;
}

function optionalCellId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new Error('Native tool input cell_id is invalid.');
  }
  return value;
}

function editMode(value: unknown): NotebookEditMode {
  if (value === undefined || value === null) return 'replace';
  if (value === 'replace' || value === 'insert' || value === 'delete') return value;
  throw new Error('Native tool input edit_mode is invalid.');
}

function optionalCellType(value: unknown): NotebookCellType | null {
  if (value === undefined || value === null) return null;
  if (value === 'code' || value === 'markdown') return value;
  throw new Error('Native tool input cell_type is invalid.');
}

function generatedCellId(existing: Set<string>, generateId: () => string): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = generateId();
    const safe = /^[A-Za-z0-9_-]{1,64}$/.test(candidate)
      ? candidate
      : `cell-${randomUUID().replaceAll('-', '').slice(0, 24)}`;
    if (!existing.has(safe)) return safe;
  }
  throw new Error('Could not allocate a unique notebook cell ID.');
}

async function atomicWriteNotebook(path: string, content: string): Promise<void> {
  if (Buffer.byteLength(content) > MAX_NOTEBOOK_BYTES) {
    throw new Error('The updated notebook is too large.');
  }
  const existingMode = (await stat(path)).mode & 0o7777;
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmod(temporaryPath, existingMode);
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function readHostedNotebook(path: string): Promise<Record<string, unknown>> {
  const { notebook } = await readNotebookFile(path);
  return {
    path,
    notebook: true,
    nbformat: notebook.nbformat,
    nbformat_minor: notebook.nbformat_minor,
    language: notebookLanguage(notebook),
    cells: notebook.cells.map((cell, index) => ({
      index,
      ...(cell.id ? { id: cell.id } : {}),
      cell_type: cell.cell_type,
      source: sourceText(cell.source),
    })),
  };
}

export async function editHostedNotebook(input: {
  readonly path: string;
  readonly cellId: unknown;
  readonly newSource: unknown;
  readonly cellType: unknown;
  readonly editMode: unknown;
  readonly generateId: () => string;
  readonly signal: AbortSignal;
  readonly assertNotStopped: (signal: AbortSignal) => void;
}): Promise<Record<string, unknown>> {
  const { notebook } = await readNotebookFile(input.path);
  const mode = editMode(input.editMode);
  const requestedCellId = optionalCellId(input.cellId);
  const requestedCellType = optionalCellType(input.cellType);
  const newSource = validateSource(input.newSource);
  const existingIds = new Set(
    notebook.cells.flatMap((cell) => (typeof cell.id === 'string' ? [cell.id] : []))
  );
  let affectedCellId = requestedCellId;
  let affectedCellType: NotebookCellType;

  if (mode === 'insert') {
    if (!requestedCellType) {
      throw new Error('NotebookEdit cell_type is required when inserting a cell.');
    }
    const insertionIndex = requestedCellId
      ? notebook.cells.findIndex((cell) => cell.id === requestedCellId) + 1
      : 0;
    if (requestedCellId && insertionIndex === 0) {
      throw new Error('The requested notebook cell was not found.');
    }
    affectedCellId = generatedCellId(existingIds, input.generateId);
    affectedCellType = requestedCellType;
    const cell: NotebookCell = {
      id: affectedCellId,
      cell_type: requestedCellType,
      metadata: {},
      source: newSource,
      ...(requestedCellType === 'code' ? { execution_count: null, outputs: [] } : {}),
    };
    notebook.cells.splice(insertionIndex, 0, cell);
  } else {
    if (!requestedCellId) {
      throw new Error('NotebookEdit cell_id is required for replace and delete operations.');
    }
    const cellIndex = notebook.cells.findIndex((cell) => cell.id === requestedCellId);
    if (cellIndex < 0) throw new Error('The requested notebook cell was not found.');
    const current = notebook.cells[cellIndex];
    if (mode === 'delete') {
      affectedCellType = current.cell_type === 'markdown' ? 'markdown' : 'code';
      notebook.cells.splice(cellIndex, 1);
    } else {
      const nextType = requestedCellType ?? current.cell_type;
      if (nextType !== 'code' && nextType !== 'markdown') {
        throw new Error('NotebookEdit can replace only code or markdown cells.');
      }
      affectedCellType = nextType;
      current.source = newSource;
      if (current.cell_type !== nextType) {
        current.cell_type = nextType;
        if (nextType === 'code') {
          current.execution_count = null;
          current.outputs = [];
        } else {
          delete current.execution_count;
          delete current.outputs;
        }
      }
    }
  }

  input.assertNotStopped(input.signal);
  const updatedFile = `${JSON.stringify(notebook, null, 1)}\n`;
  await atomicWriteNotebook(input.path, updatedFile);
  return {
    path: input.path,
    notebook_path: input.path,
    cell_id: affectedCellId,
    cell_type: affectedCellType,
    edit_mode: mode,
    new_source: newSource,
    language: notebookLanguage(notebook),
  };
}
