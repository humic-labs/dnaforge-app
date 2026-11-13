import {
  MAX_PORTABLE_GENOME_VIEW_BYTES,
  PORTABLE_GENOME_VIEW_SCHEMA,
  serializePortableGenomeViewDocument,
  type PortableGenomeViewDocument,
} from '@waypoint/genome-data';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  save: vi.fn(),
  readFileBounded: vi.fn(),
  writeTextFileAtomic: vi.fn(),
}));
const telemetry = vi.hoisted(() => ({
  beginWorkflowAction: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    dialog: { open: mocks.open, save: mocks.save },
    fs: {
      readFileBounded: mocks.readFileBounded,
      writeTextFileAtomic: mocks.writeTextFileAtomic,
    },
  }),
}));

vi.mock('../../lib/workflow-telemetry', () => ({
  beginWorkflowAction: telemetry.beginWorkflowAction,
}));

import {
  PORTABLE_GENOME_VIEW_FILE_SUFFIX,
  PortableGenomeViewFileError,
  choosePortableGenomeViewDocument,
  openPortableGenomeViewDocument,
  portableGenomeViewDefaultFileName,
  savePortableGenomeViewDocument,
} from './portable-genome-view-file';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SOURCE_FINGERPRINT = 'c'.repeat(24);

function documentFixture(): PortableGenomeViewDocument {
  return {
    schema: PORTABLE_GENOME_VIEW_SCHEMA,
    kind: 'indexed-genome-view',
    id: 'view-grch38-review',
    name: 'GRCh38 review locus',
    provenance: {
      createdAt: '2026-09-01T16:00:00.000Z',
      updatedAt: '2026-09-01T16:05:00.000Z',
      createdBy: { kind: 'user', id: 'user-local' },
    },
    reference: {
      kind: 'hosted-reference',
      catalogId: 'hg38',
      assemblyId: 'GRCh38',
      bundleFingerprint: SHA_A,
      sourceFingerprint: SOURCE_FINGERPRINT,
      inventoryFingerprint: SHA_B,
    },
    viewport: { kind: 'locus', chrom: 'chr11', start0: 5_220_000, end0: 5_225_000 },
    annotation: {
      policy: { isoformMode: 'canonical', laneLimit: 2 },
      visibilityByTrackId: {},
      orderedTrackIds: [],
    },
    tracks: [],
  };
}

async function expectFileError(
  operation: Promise<unknown>,
  code: PortableGenomeViewFileError['code']
): Promise<PortableGenomeViewFileError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(PortableGenomeViewFileError);
    if (!(error instanceof PortableGenomeViewFileError)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`Expected ${code}.`);
}

describe('portable genome view filesystem boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    telemetry.beginWorkflowAction.mockReturnValue({
      actionId: 'portable-export-action',
      consumed: false,
      complete: telemetry.complete,
      fail: telemetry.fail,
      cancel: telemetry.cancel,
    });
    mocks.open.mockResolvedValue(null);
    mocks.save.mockResolvedValue(null);
    mocks.readFileBounded.mockResolvedValue(new Uint8Array());
    mocks.writeTextFileAtomic.mockResolvedValue(undefined);
  });

  it('builds a conservative cross-platform default filename without duplicating the suffix', () => {
    expect(portableGenomeViewDefaultFileName('  ../GRCh38: review?  ')).toBe(
      `GRCh38- review${PORTABLE_GENOME_VIEW_FILE_SUFFIX}`
    );
    expect(portableGenomeViewDefaultFileName('CON.notes')).toBe(
      `Genome view${PORTABLE_GENOME_VIEW_FILE_SUFFIX}`
    );
    expect(portableGenomeViewDefaultFileName(`review${PORTABLE_GENOME_VIEW_FILE_SUFFIX}`)).toBe(
      `review${PORTABLE_GENOME_VIEW_FILE_SUFFIX}`
    );
    expect(portableGenomeViewDefaultFileName('   ')).toBe(
      `Genome view${PORTABLE_GENOME_VIEW_FILE_SUFFIX}`
    );
  });

  it('treats open-picker cancellation as a non-error without reading', async () => {
    await expect(choosePortableGenomeViewDocument()).resolves.toBeNull();

    expect(mocks.open).toHaveBeenCalledWith({
      title: 'Open DNAForge genome view',
      filters: [{ name: 'DNAForge genome view', extensions: ['dnaforge-genome-view.json'] }],
    });
    expect(mocks.readFileBounded).not.toHaveBeenCalled();
  });

  it('chooses, reads within the document byte limit, and parses canonical content', async () => {
    const document = documentFixture();
    const filePath = `/tmp/review${PORTABLE_GENOME_VIEW_FILE_SUFFIX}`;
    mocks.open.mockResolvedValue(filePath);
    mocks.readFileBounded.mockResolvedValue(
      new TextEncoder().encode(serializePortableGenomeViewDocument(document))
    );

    await expect(choosePortableGenomeViewDocument()).resolves.toEqual({ filePath, document });
    expect(mocks.readFileBounded).toHaveBeenCalledWith(filePath, MAX_PORTABLE_GENOME_VIEW_BYTES);
  });

  it('reports bounded-read failures with a stable code, path, and original cause', async () => {
    const cause = new Error('File exceeds the read limit.');
    mocks.readFileBounded.mockRejectedValue(cause);

    const error = await expectFileError(
      openPortableGenomeViewDocument('/tmp/oversized.json'),
      'read-failed'
    );

    expect(error.filePath).toBe('/tmp/oversized.json');
    expect(error.cause).toBe(cause);
    expect(error.message).toContain('File exceeds the read limit.');
  });

  it('distinguishes malformed UTF-8 and invalid JSON as parse failures', async () => {
    mocks.readFileBounded.mockResolvedValueOnce(new Uint8Array([0xff]));
    const utf8Error = await expectFileError(
      openPortableGenomeViewDocument('/tmp/not-utf8.json'),
      'parse-failed'
    );
    expect(utf8Error.message).toContain('not valid UTF-8');

    mocks.readFileBounded.mockResolvedValueOnce(new TextEncoder().encode('{'));
    const jsonError = await expectFileError(
      openPortableGenomeViewDocument('/tmp/not-json.json'),
      'parse-failed'
    );
    expect(jsonError.message).toContain('invalid JSON');
  });

  it('reports an open-picker failure separately from file read failures', async () => {
    const cause = new Error('native dialog unavailable');
    mocks.open.mockRejectedValue(cause);

    const error = await expectFileError(choosePortableGenomeViewDocument(), 'open-dialog-failed');

    expect(error.filePath).toBeNull();
    expect(error.cause).toBe(cause);
    expect(mocks.readFileBounded).not.toHaveBeenCalled();
  });

  it('treats save-picker cancellation as a non-error without writing', async () => {
    await expect(savePortableGenomeViewDocument(documentFixture())).resolves.toBeNull();

    expect(mocks.save).toHaveBeenCalledWith({
      defaultPath: `GRCh38 review locus${PORTABLE_GENOME_VIEW_FILE_SUFFIX}`,
      filters: [{ name: 'DNAForge genome view', extensions: ['dnaforge-genome-view.json'] }],
    });
    expect(mocks.writeTextFileAtomic).not.toHaveBeenCalled();
    expect(telemetry.beginWorkflowAction).toHaveBeenCalledOnce();
    expect(telemetry.cancel).toHaveBeenCalledWith({ status: 'cancelled' });
    expect(telemetry.complete).not.toHaveBeenCalled();
    expect(telemetry.fail).not.toHaveBeenCalled();
  });

  it('starts one handler operation before the save picker settles', async () => {
    let finish!: (path: string | null) => void;
    mocks.save.mockReturnValue(
      new Promise<string | null>((resolve) => {
        finish = resolve;
      })
    );
    const pending = savePortableGenomeViewDocument(documentFixture());
    const startsBeforePickerCompletion = telemetry.beginWorkflowAction.mock.calls.length;
    finish(null);
    await expect(pending).resolves.toBeNull();
    expect(startsBeforePickerCompletion).toBe(1);
    expect(telemetry.cancel).toHaveBeenCalledTimes(1);
    expect(telemetry.complete).not.toHaveBeenCalled();
  });

  it('writes and independently parses the revision captured before a pending picker', async () => {
    const document = documentFixture();
    const captured = structuredClone(document);
    const files = new Map<string, string>();
    let finish!: (path: string | null) => void;
    mocks.save.mockReturnValue(
      new Promise<string | null>((resolve) => {
        finish = resolve;
      })
    );
    mocks.writeTextFileAtomic.mockImplementation(async ({ path, content }) => {
      files.set(path, content);
    });
    mocks.readFileBounded.mockImplementation(async (path) =>
      new TextEncoder().encode(files.get(path))
    );
    const pending = savePortableGenomeViewDocument(document);
    Object.assign(document, { name: 'PRIVATE_NEWER_REVISION' });
    Object.assign(document.viewport, { start0: 6_000_000, end0: 6_001_000 });
    finish('/tmp/captured');
    const path = await pending;
    expect(path).toBe(`/tmp/captured${PORTABLE_GENOME_VIEW_FILE_SUFFIX}`);
    if (!path) throw new Error('Expected the captured export path');
    const reopened = await openPortableGenomeViewDocument(path);
    expect(reopened.document).toEqual(captured);
    expect(files.get(path)).toBe(serializePortableGenomeViewDocument(captured));
  });

  it('canonically serializes, appends the portable suffix, and writes the selected file', async () => {
    const document = documentFixture();
    const selectedPath = '/tmp/GRCh38 review locus';
    const filePath = `${selectedPath}${PORTABLE_GENOME_VIEW_FILE_SUFFIX}`;
    mocks.save.mockResolvedValue(selectedPath);

    await expect(savePortableGenomeViewDocument(document)).resolves.toBe(filePath);
    expect(mocks.writeTextFileAtomic).toHaveBeenCalledWith({
      path: filePath,
      content: serializePortableGenomeViewDocument(document),
    });
    expect(telemetry.beginWorkflowAction).toHaveBeenCalledWith({
      workflow: 'file',
      action: 'export',
      exportFormat: 'json',
    });
    expect(telemetry.complete).toHaveBeenCalledWith({ status: 'saved' });
    expect(telemetry.fail).not.toHaveBeenCalled();
  });

  it('reports serialization and write failures separately with the destination path', async () => {
    const filePath = `/tmp/review${PORTABLE_GENOME_VIEW_FILE_SUFFIX}`;
    mocks.save.mockResolvedValue(filePath);
    const invalidDocument = { ...documentFixture(), name: '' };

    const serializeError = await expectFileError(
      savePortableGenomeViewDocument(invalidDocument),
      'serialize-failed'
    );
    expect(serializeError.filePath).toBe(filePath);
    expect(serializeError.message).toContain('name must be a non-empty string');
    expect(mocks.writeTextFileAtomic).not.toHaveBeenCalled();
    expect(telemetry.fail).toHaveBeenLastCalledWith('serialize_failed');

    const writeCause = new Error('disk is full');
    mocks.writeTextFileAtomic.mockRejectedValue(writeCause);
    const writeError = await expectFileError(
      savePortableGenomeViewDocument(documentFixture()),
      'write-failed'
    );
    expect(writeError.filePath).toBe(filePath);
    expect(writeError.cause).toBe(writeCause);
    expect(writeError.message).toContain('disk is full');
    expect(telemetry.fail).toHaveBeenLastCalledWith('write_failed');
  });

  it('reports a save-picker failure separately from serialization and writing', async () => {
    const cause = new Error('native dialog unavailable');
    mocks.save.mockRejectedValue(cause);

    const error = await expectFileError(
      savePortableGenomeViewDocument(documentFixture()),
      'save-dialog-failed'
    );

    expect(error.filePath).toBeNull();
    expect(error.cause).toBe(cause);
    expect(mocks.writeTextFileAtomic).not.toHaveBeenCalled();
    expect(telemetry.beginWorkflowAction).toHaveBeenCalledOnce();
    expect(telemetry.fail).toHaveBeenCalledWith('unknown', { outcomeKind: 'export_dialog_failed' });
    expect(telemetry.complete).not.toHaveBeenCalled();
  });

  it('does not report saved until the captured native write acknowledges', async () => {
    let acknowledge!: () => void;
    mocks.save.mockResolvedValue('/tmp/acknowledged');
    mocks.writeTextFileAtomic.mockReturnValue(
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      })
    );
    const pending = savePortableGenomeViewDocument(documentFixture());
    await Promise.resolve();
    expect(mocks.writeTextFileAtomic).toHaveBeenCalledOnce();
    expect(telemetry.complete).not.toHaveBeenCalled();
    acknowledge();
    await expect(pending).resolves.toBe(`/tmp/acknowledged${PORTABLE_GENOME_VIEW_FILE_SUFFIX}`);
    expect(telemetry.complete).toHaveBeenCalledWith({ status: 'saved' });
  });

  it('preserves the original write error even when optional failure observation throws', async () => {
    const cause = new Error('PRIVATE_NATIVE_WRITE_FAILURE');
    mocks.save.mockResolvedValue('/tmp/refused');
    mocks.writeTextFileAtomic.mockRejectedValue(cause);
    telemetry.fail.mockImplementationOnce(() => {
      throw new Error('PRIVATE_OBSERVER_FAILURE');
    });
    const error = await expectFileError(
      savePortableGenomeViewDocument(documentFixture()),
      'write-failed'
    );
    expect(error.cause).toBe(cause);
    expect(error.filePath).toBe(`/tmp/refused${PORTABLE_GENOME_VIEW_FILE_SUFFIX}`);
    expect(telemetry.complete).not.toHaveBeenCalled();
  });
});
