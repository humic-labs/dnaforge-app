import { beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TextViewerTab } from './TextViewerTab';
import { documentLifecycle } from '../shared/document-lifecycle';
import { ownsNativeFileDocument } from '../features/workspace/public/file-document-client';

const native = vi.hoisted(() => ({
  inspectLayer: vi.fn(),
  fileDocument: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
  write: vi.fn(),
  subscribe: vi.fn(() => () => {}),
}));

vi.mock('../platform', () => ({
  platform: () => ({
    sequenceDataLayers: { run: native.inspectLayer },
    fs: {
      stat: native.stat,
      readFile: native.readFile,
      fileDocument: native.fileDocument,
      writeTextFileAtomic: native.write,
      subscribeFileDocuments: native.subscribe,
    },
  }),
}));

const id = `layer-${'a'.repeat(64)}`;
const root = '/project/Engineering';
const path = `${root}/.dnaforge/sequence-data-layers/${id}.dnalayer.json`;
const savedDocument = {
  id,
  label: 'Measured expression',
  report: { counts: { total: 4, mapped: 3, unmapped: 1, ambiguous: 0, rejected: 0 } },
  source: { kind: 'csv-snapshot', csv: 'locus_tag,expression\nb1007,3.002396262\n' },
};
const published = {
  status: 'published',
  path,
  revision: 'b'.repeat(64),
  document: savedDocument,
  availability: { status: 'current' },
};
const originalElectronApi = Object.getOwnPropertyDescriptor(window, 'electronAPI');

beforeAll(() => {
  if (!Range.prototype.getClientRects)
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  if (!Range.prototype.getBoundingClientRect)
    Range.prototype.getBoundingClientRect = () => new DOMRect();
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {} });
  const bytes = new TextEncoder().encode(JSON.stringify(savedDocument));
  native.readFile.mockResolvedValue(bytes);
  native.stat.mockResolvedValue({ size: bytes.byteLength, isFile: true, isDirectory: false });
  native.fileDocument.mockRejectedValue(
    new Error('INTERNAL_PROJECT_PATH: Native project metadata is not an editable ordinary file.')
  );
  native.inspectLayer.mockResolvedValue(published);
});

afterEach(() => {
  if (originalElectronApi) Object.defineProperty(window, 'electronAPI', originalElectronApi);
  else Reflect.deleteProperty(window, 'electronAPI');
});

it('loads a saved native layer as read-only JSON without enrolling it as an editable file', async () => {
  render(<TextViewerTab filePath={path} />);

  const editor = await screen.findByRole('textbox', {
    name: `Code editor for ${id}.dnalayer.json`,
  });
  expect(editor).toHaveTextContent('Measured expression');
  expect(editor).toHaveTextContent('3.002396262');
  expect(editor).toHaveAttribute('contenteditable', 'false');
  expect(editor).toHaveAttribute('aria-readonly', 'true');
  expect(native.inspectLayer).toHaveBeenCalledWith({ operation: 'inspect', project: root, id });
  expect(native.fileDocument).not.toHaveBeenCalled();
  expect(ownsNativeFileDocument(path)).toBe(false);
  expect(native.readFile).not.toHaveBeenCalled();
  expect(native.stat).not.toHaveBeenCalled();
  fireEvent.keyDown(editor, { key: 's', code: 'KeyS', metaKey: true });
  expect(await documentLifecycle.save({ kind: 'file', filePath: path })).toBe(true);
  expect(native.write).not.toHaveBeenCalled();
  expect(screen.queryByTitle('Save (Cmd+S)')).not.toBeInTheDocument();
});

it('keeps a native layer above the full-editor limit in the bounded preview', async () => {
  native.inspectLayer.mockResolvedValue({
    ...published,
    document: { ...savedDocument, retainedReport: 'x'.repeat(3 * 1024 * 1024) },
  });
  render(<TextViewerTab filePath={path} />);

  expect(await screen.findByTestId('large-text-preview')).toBeInTheDocument();
  expect(screen.getByText(/showing the first/i)).toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(native.fileDocument).not.toHaveBeenCalled();
  expect(native.readFile).not.toHaveBeenCalled();
  expect(native.write).not.toHaveBeenCalled();
});

it.each([
  { status: 'failed', disposition: 'publication-uncertain' },
  { path: '/other-project/layer.dnalayer.json' },
  { document: { ...savedDocument, id: `layer-${'c'.repeat(64)}` } },
])(
  'refuses an unverified native layer response without falling back to ordinary file access: %j',
  async (change) => {
    native.inspectLayer.mockResolvedValue({ ...published, ...change });
    render(<TextViewerTab filePath={path} />);

    await waitFor(() => expect(screen.getAllByText('Failed to load file')).toHaveLength(2));
    expect(native.inspectLayer).toHaveBeenCalledWith({ operation: 'inspect', project: root, id });
    expect(native.fileDocument).not.toHaveBeenCalled();
    expect(native.readFile).not.toHaveBeenCalled();
    expect(native.write).not.toHaveBeenCalled();
  }
);
