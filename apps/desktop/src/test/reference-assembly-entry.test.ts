import { beforeEach, describe, expect, it, vi } from 'vitest';
import { referenceAssemblyById } from '../features/sequence/reference-catalog';
import { referenceAssemblyEntryForTest } from './reference-assembly-entry';

const assets = vi.hoisted(() => ({ listHosted: vi.fn(), installHosted: vi.fn() }));
vi.mock('../platform', () => ({ platform: () => ({ referenceAssets: assets }) }));

describe('reference assembly entry for the live test bridge', () => {
  const grch38 = referenceAssemblyById('grch38')!;
  const prepared = {
    ...grch38,
    members: grch38.members.map((member) => ({
      ...member,
      manifest: {
        ...member.manifest!,
        fastaPath: `prepared/${member.chrom}/${member.chrom}.fa`,
        faiPath: `prepared/${member.chrom}/${member.chrom}.fa.fai`,
      },
    })),
  };

  beforeEach(() => {
    vi.resetAllMocks();
    assets.listHosted.mockResolvedValue([{ id: 'grch38' }]);
    assets.installHosted.mockResolvedValue({ status: 'view-ready', entry: prepared });
  });

  it('uses the admitted hosted filenames, as the real library does', async () => {
    const entry = await referenceAssemblyEntryForTest(grch38);
    expect(entry).toEqual(prepared);
    expect(entry.members).toHaveLength(24);
    expect(assets.installHosted).toHaveBeenCalledWith({
      catalogId: 'grch38',
      themeMode: 'light',
      intent: 'open-view',
    });
  });

  it('retains a non-hosted reference without starting a hosted install', async () => {
    assets.listHosted.mockResolvedValue([]);
    expect(await referenceAssemblyEntryForTest(grch38)).toBe(grch38);
    expect(assets.installHosted).not.toHaveBeenCalled();
  });

  it('does not hide failed hosted admission behind guessed catalog filenames', async () => {
    assets.installHosted.mockRejectedValue(new Error('Cached publication failed admission'));
    await expect(referenceAssemblyEntryForTest(grch38)).rejects.toThrow(
      'Cached publication failed admission'
    );
  });
});
