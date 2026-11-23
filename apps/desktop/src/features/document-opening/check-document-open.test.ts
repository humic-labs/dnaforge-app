import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkDocumentOpen, prepareDocumentOpen } from './check-document-open';
import { DocumentReadError } from '../../shared/document-read-failure';

const probes = vi.hoisted(() => ({
  native: vi.fn(),
  inspect: vi.fn(),
  read: vi.fn(),
}));
vi.mock('../../platform', () => ({
  platform: () => ({ workspace: { checkDocument: probes.native } }),
}));
vi.mock('./literal-document-open-check', () => ({
  inspectLiteralDocument: probes.inspect,
  readLiteralDocument: probes.read,
}));

const request = { workspaceRoot: '/docs', path: '/docs/paper.pdf' };
const inspect = {
  state: 'inspect',
  kind: 'pdf',
  path: request.path,
  revision: 'captured-file',
  paths: [request.path],
};
const snapshot = { kind: 'pdf', bytes: new Uint8Array([1, 2, 3]) };

beforeEach(() => {
  vi.resetAllMocks();
  probes.native.mockResolvedValue(inspect);
  probes.read.mockResolvedValue(snapshot);
});

describe('coordinating the desktop reader with the current file', () => {
  it('uses the normal reader without retaining payload on inventory checks', async () => {
    await expect(checkDocumentOpen(request)).resolves.toMatchObject({
      state: 'ready',
      kind: 'pdf',
      revision: 'captured-file',
    });
    expect(probes.native).toHaveBeenCalledTimes(2);
    expect(probes.inspect).toHaveBeenCalledWith('pdf', request.path);
    expect(probes.read).not.toHaveBeenCalled();
  });

  it('passes only checked bytes to an explicit open', async () => {
    const prepared = await prepareDocumentOpen(request.path, false);
    expect(prepared.availability.state).toBe('ready');
    expect(prepared.snapshot).toBe(snapshot);
    expect(probes.inspect).not.toHaveBeenCalled();
  });

  it('discards the old bytes after an atomic replacement while checking', async () => {
    probes.native.mockResolvedValueOnce(inspect).mockResolvedValueOnce({
      ...inspect,
      revision: 'another-file',
    });
    await expect(prepareDocumentOpen(request.path, false)).resolves.toEqual({
      availability: {
        state: 'blocked',
        code: 'changed',
        recognized: false,
        reason: 'The file changed while it was being checked. Try again.',
        paths: [request.path],
      },
    });
  });

  it('returns the known decoder reason when the checked file stayed the same', async () => {
    probes.inspect.mockRejectedValue(new DocumentReadError('password', true));
    await expect(checkDocumentOpen(request)).resolves.toMatchObject({
      state: 'blocked',
      code: 'password',
      recognized: true,
      reason: 'This file is password-protected.',
    });
  });

  it('keeps an unexplained IPC failure neutral', async () => {
    probes.native.mockRejectedValue(new Error('internal bridge failed /internal/path'));
    await expect(checkDocumentOpen(request)).resolves.toMatchObject({
      state: 'blocked',
      code: 'unknown',
      recognized: false,
      reason: 'DNAForge couldn’t open this file.',
    });
    expect(probes.inspect).not.toHaveBeenCalled();
  });
});
