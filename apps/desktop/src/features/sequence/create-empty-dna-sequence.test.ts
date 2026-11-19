import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { decodeSequenceDocument, serializeGenBank } from '@waypoint/sequence-utils';
import { useCanvasStore } from '../canvas/store';
import { useSequenceStore } from './store';

const mocks = vi.hoisted(() => ({
  importFileFromContent: vi.fn(),
  importSequenceFromContent: vi.fn(),
  openSequenceFile: vi.fn(),
  namespace: vi.fn(),
  publish: vi.fn(),
  exists: vi.fn(),
  select: vi.fn(),
  gitStatus: vi.fn(),
  gitCommit: vi.fn(),
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    workspace: {
      importFileFromContent: mocks.importFileFromContent,
      importSequenceFromContent: mocks.importSequenceFromContent,
    },
    fs: { exists: mocks.exists },
    db: { select: mocks.select },
  }),
}));
vi.mock('../../db/workspace-catalog', () => ({
  findWorkspaceRootForPath: () => '/managed/project',
}));
vi.mock('../../services/read-scientific-namespace', () => ({
  readScientificNamespace: mocks.namespace,
}));
vi.mock('../../services/workspace-mutation-transaction', () => ({
  withRendererWorkspaceMutation: (_root: string, operation: (token: string) => unknown) =>
    operation('creation-token'),
}));
vi.mock('../workspace/public/git', () => ({
  isGitRepo: async () => true,
  gitStatus: mocks.gitStatus,
  gitCommitPaths: mocks.gitCommit,
}));
vi.mock('../../services/publish-native-artifact', () => ({
  publishNativeArtifact: mocks.publish,
  NativeArtifactPublicationPendingError: class extends Error {
    constructor(
      readonly accepted: unknown,
      message: string
    ) {
      super(message);
    }
  },
}));

vi.mock('../document-opening/compat', () => ({
  openSequenceFile: mocks.openSequenceFile,
}));

import { NativeArtifactPublicationPendingError } from '../../services/publish-native-artifact';
import {
  createEmptyDnaSequence,
  createDnaSequencePackage,
  normalizeEmptyDnaSequenceName,
  SequenceCreationPendingError,
} from './create-empty-dna-sequence';
import {
  parseSequencePackageDocument,
  SEQUENCE_PACKAGE_FORMAT_VERSION,
} from '../../db/sequence-package';
import type { ScientificAcceptedDocumentRevision } from '@waypoint/domain-services';
import { scientificIdentityPath } from '@waypoint/scientific-objects';

const accepted: ScientificAcceptedDocumentRevision = {
  kind: 'accepted-object',
  resourceId: 'new-sequence',
  resourceRevisionId: `rr_${'b'.repeat(64)}`,
  workspaceVersionId: `wv_${'c'.repeat(64)}`,
  contentSha256: 'd'.repeat(64),
  sequenceEditParentEventId: null,
};
const namespace = () => ({ workspace: 'workspace:1', head: `wv_${'a'.repeat(64)}`, entries: [] });
const enrolledRequest = () => ({
  destinationPath: '/managed/project',
  name: 'Named sequence',
  creationId: accepted.resourceId,
});

describe('createEmptyDnaSequence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.importFileFromContent.mockReset();
    mocks.openSequenceFile.mockReset();
    mocks.openSequenceFile.mockResolvedValue('new-tab');
    useCanvasStore.getState().reset();
    useSequenceStore.getState().clearAll();
    mocks.namespace.mockResolvedValue(null);
    mocks.exists.mockResolvedValue(false);
    mocks.publish.mockResolvedValue(accepted);
    mocks.select.mockResolvedValue([{ entity_id: accepted.resourceId }]);
    mocks.gitStatus.mockResolvedValue(new Map());
    mocks.gitCommit.mockResolvedValue('commit');
  });

  it('requires the exact chosen package path in historical projects and refuses collisions inside the writer', async () => {
    mocks.namespace.mockResolvedValue(null);
    const filePath = '/managed/project/nested/Copy.v2/Copy.v2.gb';
    const content = serializeGenBank({
      id: 's',
      name: 'Annotated',
      sequence: 'ACGT',
      length: 4,
      annotations: [],
    });
    const input = {
      destinationPath: '/managed/project/nested',
      name: 'Copy.v2',
      content,
      exactPackageName: true,
      open: false,
    };
    mocks.importSequenceFromContent.mockResolvedValueOnce({
      kind: 'imported',
      packageProductPaths: [filePath],
      committed: true,
    });
    expect(await createDnaSequencePackage(input)).toMatchObject({ filePath });
    expect(mocks.importSequenceFromContent).toHaveBeenCalledWith({
      targetRoot: '/managed/project',
      relativePath: 'nested/Copy.v2.gb',
      content,
      collisionPolicy: 'refuse',
    });
    mocks.importSequenceFromContent.mockResolvedValueOnce({
      kind: 'refused',
      error: 'target already exists',
    });
    await expect(createDnaSequencePackage(input)).rejects.toThrow('target already exists');
    expect(mocks.importFileFromContent).not.toHaveBeenCalled();
  });
  it('accepts the exact package with a stable identity before catalog verification, owned Git history and normal opening', async () => {
    mocks.namespace.mockResolvedValue(namespace());
    mocks.gitStatus
      .mockResolvedValueOnce(
        new Map([
          ['unrelated.txt', 'M'],
          ['.waypoint/lims/preexisting.json', 'M'],
        ])
      )
      .mockResolvedValueOnce(
        new Map([
          ['unrelated.txt', 'M'],
          ['.waypoint/lims/preexisting.json', 'M'],
          ['Named sequence/Named sequence.gb', 'A'],
          ['Named sequence/.forge/plasmid.json', 'A'],
          [scientificIdentityPath, 'M'],
          ['.waypoint/lims/new.json', 'A'],
        ])
      );
    await createEmptyDnaSequence(enrolledRequest());
    const publication = mocks.publish.mock.calls[0][0];
    expect(publication).toMatchObject({
      resourceId: accepted.resourceId,
      prior: null,
      expectedHead: namespace().head,
      mutationToken: 'creation-token',
      representation: { format: 'genbank-v1' },
    });
    expect(parseSequencePackageDocument(publication.sequencePackageText)).toMatchObject({
      id: accepted.resourceId,
      formatVersion: SEQUENCE_PACKAGE_FORMAT_VERSION,
      name: 'Named sequence',
    });
    expect(
      decodeSequenceDocument(publication.representation.text, { filename: 'Named sequence.gb' })
        .sequence.length
    ).toBe(0);
    expect(mocks.importFileFromContent).not.toHaveBeenCalled();
    expect(mocks.gitCommit.mock.calls[0][2]).toEqual([
      'Named sequence/Named sequence.gb',
      'Named sequence/.forge/plasmid.json',
      scientificIdentityPath,
      '.waypoint/lims/new.json',
    ]);
    expect(mocks.publish.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.select.mock.invocationCallOrder[0]
    );
    expect(mocks.select.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.gitCommit.mock.invocationCallOrder[0]
    );
    expect(mocks.gitCommit.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.openSequenceFile.mock.invocationCallOrder[0]
    );
  });

  it('retains the complete original creation request across pending delivery and unchanged retry', async () => {
    mocks.namespace.mockResolvedValue(namespace());
    mocks.publish.mockRejectedValueOnce(
      new NativeArtifactPublicationPendingError(accepted, 'EACCES')
    );
    let pending: SequenceCreationPendingError | undefined;
    try {
      await createEmptyDnaSequence(enrolledRequest());
    } catch (error) {
      expect(error).toBeInstanceOf(SequenceCreationPendingError);
      pending = error as SequenceCreationPendingError;
    }
    if (!pending) throw Error('Expected pending creation');
    expect(pending.accepted).toBe(accepted);
    expect(mocks.openSequenceFile).not.toHaveBeenCalled();
    mocks.namespace.mockResolvedValue({ ...namespace(), head: accepted.workspaceVersionId });
    mocks.exists.mockResolvedValue(true);
    await createEmptyDnaSequence({ ...enrolledRequest(), publication: pending.creation });
    expect(mocks.publish.mock.calls[1][0]).toEqual(mocks.publish.mock.calls[0][0]);
    expect(mocks.importFileFromContent).not.toHaveBeenCalled();
  });

  it('reports a pending accepted creation through its catalog message instead of a creation failure', async () => {
    mocks.namespace.mockResolvedValue(namespace());
    mocks.publish.mockRejectedValueOnce(
      new NativeArtifactPublicationPendingError(accepted, 'EACCES')
    );
    const failure = await createEmptyDnaSequence(enrolledRequest()).catch((error) => error);
    expect(failure).toBeInstanceOf(SequenceCreationPendingError);
    expect(toUserMessage(failure, 'failure.failed-to-create-dna-sequence')).toBe(
      userMessage('document.saveRefreshPending')
    );
  });

  it('publishes filled imported bytes and required Git paths before returning without opening a tab', async () => {
    mocks.namespace.mockResolvedValue(namespace());
    const content = serializeGenBank({
      id: 'source',
      name: 'source',
      sequence: 'ATGCGT',
      length: 6,
      circular: true,
      annotations: [],
    });
    mocks.gitStatus.mockResolvedValue(new Map([['Named sequence/Named sequence.gb', 'A']]));
    const result = await createDnaSequencePackage({ ...enrolledRequest(), content, open: false });
    expect(result).toMatchObject({ tabId: null, committed: true, publication: { accepted } });
    expect(mocks.publish.mock.calls[0][0].representation.text).toBe(content);
    expect(mocks.gitCommit).toHaveBeenCalled();
    expect(mocks.openSequenceFile).not.toHaveBeenCalled();
    expect(mocks.importFileFromContent).not.toHaveBeenCalled();
  });

  it('refuses a changed filled source during an accepted retry before publishing or opening', async () => {
    mocks.namespace.mockResolvedValue(namespace());
    const content = serializeGenBank({
      id: 'source',
      name: 'source',
      sequence: 'ATGCGT',
      length: 6,
      circular: false,
      annotations: [],
    });
    mocks.publish.mockRejectedValueOnce(
      new NativeArtifactPublicationPendingError(accepted, 'EACCES')
    );
    let pending: SequenceCreationPendingError | undefined;
    try {
      await createDnaSequencePackage({ ...enrolledRequest(), content, open: false });
    } catch (error) {
      expect(error).toBeInstanceOf(SequenceCreationPendingError);
      pending = error as SequenceCreationPendingError;
    }
    if (!pending) throw Error('Expected pending creation');
    await expect(
      createDnaSequencePackage({
        ...enrolledRequest(),
        content: content.replace(/atgcgt/iu, 'atgcga'),
        open: false,
        publication: pending.creation,
      })
    ).rejects.toThrow('original source bytes');
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    await createDnaSequencePackage({
      ...enrolledRequest(),
      content,
      open: false,
      publication: pending.creation,
    });
    expect(mocks.publish.mock.calls[1][0]).toEqual(mocks.publish.mock.calls[0][0]);
    expect(mocks.openSequenceFile).not.toHaveBeenCalled();
  });

  it('does not fall back to a native file import when the required accepted project disappears', async () => {
    mocks.namespace.mockResolvedValue(null);
    const content = serializeGenBank({
      id: 'source',
      name: 'source',
      sequence: 'ATGCGT',
      length: 6,
      circular: false,
      annotations: [],
    });
    await expect(
      createDnaSequencePackage({
        ...enrolledRequest(),
        content,
        open: false,
        requireAccepted: true,
      })
    ).rejects.toThrow('accepted sequence project is unavailable');
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.importFileFromContent).not.toHaveBeenCalled();
  });

  it('keeps accepted authority when required catalog reconstruction fails', async () => {
    mocks.namespace.mockResolvedValue(namespace());
    mocks.select.mockResolvedValue([]);
    await expect(createEmptyDnaSequence(enrolledRequest())).rejects.toMatchObject({
      accepted,
      creation: { resourceId: accepted.resourceId },
    });
    expect(mocks.gitCommit).not.toHaveBeenCalled();
    expect(mocks.openSequenceFile).not.toHaveBeenCalled();
  });

  it('keeps accepted authority when required Git publication fails', async () => {
    mocks.namespace.mockResolvedValue(namespace());
    mocks.gitStatus.mockResolvedValue(new Map([['Named sequence/Named sequence.gb', 'A']]));
    mocks.gitCommit.mockRejectedValueOnce(new Error('history failed'));
    await expect(createEmptyDnaSequence(enrolledRequest())).rejects.toMatchObject({
      accepted,
      creation: { resourceId: accepted.resourceId },
    });
    expect(mocks.openSequenceFile).not.toHaveBeenCalled();
  });

  it('does not adopt a working package or fall back after an accepted namespace read failure', async () => {
    mocks.namespace.mockResolvedValue(namespace());
    mocks.exists.mockResolvedValue(true);
    await expect(createEmptyDnaSequence(enrolledRequest())).rejects.toThrow('already exists');
    mocks.namespace.mockRejectedValueOnce(new Error('accepted namespace unavailable'));
    await expect(createEmptyDnaSequence(enrolledRequest())).rejects.toThrow(
      'accepted namespace unavailable'
    );
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.importFileFromContent).not.toHaveBeenCalled();
  });

  it('keeps accepted authority when opening the normal viewer fails', async () => {
    mocks.namespace.mockResolvedValue(namespace());
    mocks.openSequenceFile.mockRejectedValueOnce(new Error('viewer unavailable'));
    await expect(createEmptyDnaSequence(enrolledRequest())).rejects.toMatchObject({
      accepted,
      creation: { resourceId: accepted.resourceId },
    });
  });

  it('writes a zero-base managed sequence before opening its real path', async () => {
    const filePath = '/managed/project/Named sequence/Named sequence.gb';
    const documentId = 'sequence-document-named';
    mocks.importFileFromContent.mockResolvedValue({
      destPath: filePath,
      relPath: 'Named sequence/Named sequence.gb',
      committed: true,
      packageProductPaths: [filePath],
    });
    let openedTabId: string | null = null;
    mocks.openSequenceFile.mockImplementation(async () => {
      openedTabId = useCanvasStore.getState().openTab('main', {
        type: 'sequence',
        entityId: documentId,
        label: 'Named sequence',
        sequenceDocument: { kind: 'catalog-sequence', entityId: documentId },
      });
      return openedTabId;
    });

    const result = await createEmptyDnaSequence({
      destinationPath: '/managed/project',
      name: 'Named sequence',
    });

    expect(mocks.importFileFromContent).toHaveBeenCalledTimes(1);
    const write = mocks.importFileFromContent.mock.calls[0][0];
    expect(write.targetRoot).toBe('/managed/project');
    expect(write.fileName).toBe('Named sequence.gb');
    const document = decodeSequenceDocument(write.content, { filename: write.fileName });
    expect(document.sequence.sequence).toBe('');
    expect(document.sequence.length).toBe(0);
    expect(document.sequence.circular).toBe(false);

    expect(mocks.openSequenceFile).toHaveBeenCalledWith({
      filePath,
      label: 'Named sequence',
      strategy: { kind: 'focused' },
      sourceSurface: 'file_tree',
    });
    expect(useSequenceStore.getState().getSequence(documentId)).toMatchObject({
      id: documentId,
      sequence: '',
      length: 0,
      circular: false,
    });
    expect(result).toEqual({ filePath, tabId: openedTabId });
  });

  it('does not open a tab when the authoritative write fails', async () => {
    mocks.importFileFromContent.mockRejectedValue(new Error('write failed'));

    await expect(
      createEmptyDnaSequence({ destinationPath: '/managed/project', name: 'Named sequence' })
    ).rejects.toThrow('write failed');

    expect(mocks.openSequenceFile).not.toHaveBeenCalled();
  });

  it('returns a semantic package name without exposing an internal file extension', () => {
    expect(normalizeEmptyDnaSequenceName('  My / sequence.gbk  ')).toBe('My - sequence');
    expect(() => normalizeEmptyDnaSequenceName('  .gb ')).toThrow(
      'Enter a name for the DNA sequence.'
    );
  });
});
