// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRichSequenceClipboardStore } from './store';
import {
  readSequenceClipboard,
  resolveSequenceClipboardText,
  writeRichSequenceClipboard,
} from './clipboard-service';
import { normalizeRichSequenceFragment } from './rich-sequence-clipboard';

beforeEach(() => {
  useRichSequenceClipboardStore.getState().clear();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined), readText: vi.fn(async () => '') },
  });
});

describe('sequence clipboard service', () => {
  it('uses the DNAForge rich fragment when its plain sequence matches the system text', () => {
    const cached = normalizeRichSequenceFragment({
      sequence: 'ACGT',
      sourceId: '/workspace/source.gb',
      sourceName: 'source',
      start: 4,
      end: 8,
      annotations: [{ name: 'promoter', type: 'promoter', start: 0, end: 4 }],
    });

    expect(resolveSequenceClipboardText('ACGT', cached)).toEqual({
      format: 'dnaforge',
      fragment: cached,
    });
  });

  it('decodes GenBank clipboard text with annotations', () => {
    const resolved =
      resolveSequenceClipboardText(`LOCUS       pasted                   12 bp    DNA     linear
FEATURES             Location/Qualifiers
     promoter        3..8
                     /label="T7"
ORIGIN
        1 acgtacgtac gt
//`);

    expect(resolved?.format).toBe('genbank');
    expect(resolved?.fragment.sequence).toBe('acgtacgtacgt');
    expect(resolved?.fragment.annotations).toEqual([
      expect.objectContaining({ name: 'T7', type: 'promoter', start: 2, end: 8 }),
    ]);
  });

  it('decodes FASTA and raw IUPAC DNA without inventing annotations', () => {
    const fasta = resolveSequenceClipboardText('>insert\nACGTACGT');
    expect(fasta?.format).toBe('fasta');
    expect(fasta?.fragment.sequence).toBe('ACGTACGT');
    expect(fasta?.fragment.annotations).toEqual([]);

    const plain = resolveSequenceClipboardText('ACGU RYSW');
    expect(plain?.format).toBe('plain-dna');
    expect(plain?.fragment.sequence).toBe('ACGTRYSW');
  });

  it('updates rich state only after the system clipboard write succeeds', async () => {
    const fragment = normalizeRichSequenceFragment({
      sequence: 'ACGT',
      sourceId: 'source',
      sourceName: 'source',
      start: 0,
      end: 4,
      annotations: [],
    });
    const writeText = vi.mocked(navigator.clipboard.writeText);
    writeText.mockRejectedValueOnce(new Error('clipboard denied'));

    await expect(writeRichSequenceClipboard(fragment)).rejects.toThrow('clipboard denied');
    expect(useRichSequenceClipboardStore.getState().copiedRegion).toBeNull();

    await writeRichSequenceClipboard(fragment);
    expect(writeText).toHaveBeenLastCalledWith('ACGT');
    expect(useRichSequenceClipboardStore.getState().copiedRegion).toEqual(fragment);
  });

  it('adopts an external sequence format into the shared cache when read', async () => {
    vi.mocked(navigator.clipboard.readText).mockResolvedValueOnce('>external\nACGTACGT');

    const resolved = await readSequenceClipboard();

    expect(resolved?.format).toBe('fasta');
    expect(useRichSequenceClipboardStore.getState().copiedRegion).toEqual(resolved?.fragment);
  });
});

describe('exact committed clipboard observation', () => {
  const input = {
    sequence: 'ACGT',
    sourceId: 'private-source',
    sourceName: 'Private source',
    start: 0,
    end: 4,
    annotations: [],
  };
  it('reports the exact committed rich object only after the system write succeeds', async () => {
    let resolve!: () => void;
    vi.mocked(navigator.clipboard.writeText).mockImplementation(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        })
    );
    const observed = vi.fn();
    const pending = writeRichSequenceClipboard(input, observed);
    expect(observed).not.toHaveBeenCalled();
    resolve();
    await pending;
    expect(observed).toHaveBeenCalledWith(useRichSequenceClipboardStore.getState().copiedRegion);
    expect(observed.mock.calls[0][0]).toBe(useRichSequenceClipboardStore.getState().copiedRegion);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('ACGT');
  });
  it('keeps an optional observer failure from changing the actual clipboard write', async () => {
    await expect(
      writeRichSequenceClipboard(input, () => {
        throw new Error('optional observer');
      })
    ).resolves.toBeUndefined();
    expect(useRichSequenceClipboardStore.getState().copiedRegion?.sequence).toBe('ACGT');
  });
  it('does not observe a failed system write or replace the rich cache', async () => {
    const observed = vi.fn();
    const failure = new Error('system failure');
    vi.mocked(navigator.clipboard.writeText).mockRejectedValue(failure);
    await expect(writeRichSequenceClipboard(input, observed)).rejects.toBe(failure);
    expect(observed).not.toHaveBeenCalled();
    expect(useRichSequenceClipboardStore.getState().copiedRegion).toBeNull();
  });

  it('reports the exact first commit even if a store subscriber replaces the cache synchronously', async () => {
    let replaced = false;
    const unsubscribe = useRichSequenceClipboardStore.subscribe((state) => {
      if (!replaced && state.copiedRegion?.sourceId === input.sourceId) {
        replaced = true;
        state.setCopiedRegion({ ...input, sequence: 'TTTT', sourceId: 'other-source' });
      }
    });
    try {
      const observed = vi.fn();
      await writeRichSequenceClipboard(input, observed);
      expect(observed.mock.calls[0][0]).toMatchObject({
        sequence: 'ACGT',
        sourceId: input.sourceId,
      });
      expect(useRichSequenceClipboardStore.getState().copiedRegion?.sourceId).toBe('other-source');
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('ACGT');
    } finally {
      unsubscribe();
    }
  });
});
