// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeVirtualDigest } from '../hooks/useVirtualDigest';
import { digestEnzyme, digestTelemetryHarness } from '../../../test/fixtures/digest-workflow';
import { DIGEST_RESULT_MIME_TYPE } from '../digest-workflow';
import { RD_FRAGMENT_MIME_TYPE, VirtualDigestPanel } from './VirtualDigestPanel';
import { useRichSequenceClipboardStore } from '../../sequence-clipboard/public/store';
import { useDesignStore } from '../../design/public/store';
import { emptyDesignRegion } from '../../design/public/assembly-slots';
import { AssemblyPartsSection } from './AssemblyPartsSection';

const owners: Array<{ retire(): void }> = [];
beforeEach(() => {
  vi.useFakeTimers();
  useRichSequenceClipboardStore.getState().clear();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  });
});
afterEach(() => {
  cleanup();
  owners.splice(0).forEach((owner) => owner.retire());
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function setup(sequence = 'AAAAGAATTCTTTT') {
  const h = digestTelemetryHarness();
  owners.push(h.owner);
  const result = computeVirtualDigest(sequence, digestEnzyme());
  h.owner.request('private-enzyme-key');
  h.owner.commit('private-enzyme-key', result, undefined, {});
  const props = {
    enzymeName: 'EcoRI',
    sequenceName: 'Private source',
    sourceSequenceId: 'private-source',
    sourceSequence: sequence,
    sourceIsCircular: true,
    sourceAnnotations: [],
    fragments: result.fragments,
    ggStatus: result.ggStatus,
    digestKind: result.digestKind,
    diagnostics: result.diagnostics,
    overhangLength: result.overhangLength,
    onClose: vi.fn(),
  };
  return { ...h, result, props, sequence };
}
function transferData() {
  const data = new Map<string, string>();
  return {
    data,
    types: [RD_FRAGMENT_MIME_TYPE, DIGEST_RESULT_MIME_TYPE],
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
    setDragImage: vi.fn(),
    effectAllowed: '',
  };
}

describe('digest deliberate use through the actual panel, clipboard and assembly owners', () => {
  it('awaits the real clipboard write, keeps exact payload and publishes no focus/wheel fulfillment', async () => {
    const h = setup();
    let resolve!: () => void;
    const write = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        })
    );
    vi.mocked(navigator.clipboard.writeText).mockImplementation(write);
    render(<VirtualDigestPanel {...h.props} />);
    fireEvent.focus(screen.getByTestId('virtual-digest-panel'));
    fireEvent.wheel(screen.getByTestId('fragment-row-0'), { deltaY: 20 });
    expect(
      h.events.filter(({ properties }) => properties.workflow_action !== 'compute')
    ).toHaveLength(0);
    fireEvent.click(screen.getByTitle('Copy fragment sequence to clipboard'));
    expect(h.results('copy')).toHaveLength(0);
    expect(useRichSequenceClipboardStore.getState().copiedRegion).toBeNull();
    const fragment = h.result.fragments[0];
    const expected =
      h.sequence.slice(fragment.startPosition) + h.sequence.slice(0, fragment.endPosition);
    expect(write).toHaveBeenCalledWith(expected);
    await act(async () => resolve());
    expect(h.results('copy')).toHaveLength(1);
    expect(h.results('copy')[0].properties).toMatchObject({
      outcome_kind: 'digest_use_accepted',
      affected_count: 1,
    });
    expect(useRichSequenceClipboardStore.getState().copiedRegion).toMatchObject({
      sequence: expected,
      sourceSequence: h.sequence,
      sourceType: 'rd',
      start: fragment.startPosition,
      end: fragment.startPosition + fragment.length,
      rdOverhangs: {
        upstream: fragment.upstream.sequence,
        downstream: fragment.downstream.sequence,
      },
      rdEnds: { upstream: fragment.upstream.rdEnd, downstream: fragment.downstream.rdEnd },
    });
    expect(JSON.stringify(h.events)).not.toContain('Private source');
    expect(JSON.stringify(h.events)).not.toContain(h.sequence);
  });

  it('records clipboard failure without a copied cache or accepted-use receipt', async () => {
    const h = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(navigator.clipboard.writeText).mockRejectedValue(
      new Error('private native clipboard failure')
    );
    render(<VirtualDigestPanel {...h.props} />);
    await act(async () => {
      fireEvent.click(screen.getByTitle('Copy fragment sequence to clipboard'));
    });
    expect(useRichSequenceClipboardStore.getState().copiedRegion).toBeNull();
    expect(h.results('copy')[0].properties).toMatchObject({
      success: false,
      error_class: 'unknown',
      outcome_kind: 'digest_use_refused',
    });
    expect(JSON.stringify(h.events)).not.toContain('private native clipboard failure');
  });

  it('does not turn a missing source identity into a successful copy', () => {
    const h = setup();
    render(<VirtualDigestPanel {...h.props} sourceSequenceId={undefined} />);
    fireEvent.click(screen.getByTitle('Copy fragment sequence to clipboard'));
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(h.results('copy')[0].properties).toMatchObject({
      workflow_status: 'blocked',
      outcome_kind: 'digest_use_refused',
    });
  });

  it.each(['source', 'identity', 'opt-out', 'unmount'] as const)(
    'excludes late clipboard completion after %s retirement',
    async (reason) => {
      const h = setup();
      let resolve!: () => void;
      vi.mocked(navigator.clipboard.writeText).mockImplementation(
        () =>
          new Promise<void>((done) => {
            resolve = done;
          })
      );
      const view = render(<VirtualDigestPanel {...h.props} />);
      fireEvent.click(screen.getByTitle('Copy fragment sequence to clipboard'));
      if (reason === 'source') {
        const next = computeVirtualDigest('CCCCGAATTCTTTT', digestEnzyme());
        h.owner.commit('private-enzyme-key', next, undefined, {});
        view.rerender(
          <VirtualDigestPanel
            {...h.props}
            fragments={next.fragments}
            sourceSequence="CCCCGAATTCTTTT"
          />
        );
      } else if (reason === 'unmount') {
        h.owner.retire();
        view.unmount();
      } else h.changeContext(reason === 'opt-out' ? null : 'new-identity-context');
      await act(async () => resolve());
      expect(h.results('copy')).toHaveLength(0);
      expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
    }
  );

  it('joins drag placement only after Add Fragment accepts the exact material in the real store', () => {
    const h = setup();
    const panel = render(<VirtualDigestPanel {...h.props} />);
    const transfer = transferData();
    fireEvent.dragStart(screen.getByTestId('fragment-row-0'), { dataTransfer: transfer });
    const payload = JSON.parse(transfer.getData(RD_FRAGMENT_MIME_TYPE));
    expect(transfer.getData(DIGEST_RESULT_MIME_TYPE)).toMatch(/^[0-9a-f-]{36}$/i);
    expect(payload).not.toHaveProperty('resultId');
    expect(h.results('place')).toHaveLength(0);
    panel.unmount();
    const id = useDesignStore.getState().createDesign('Local assembly');
    const design = useDesignStore.getState().designs[id];
    render(<AssemblyPartsSection design={design} />);
    fireEvent.drop(screen.getByTestId('assembly-empty-parts-cue'), { dataTransfer: transfer });
    expect(useDesignStore.getState().designs[id].regions).toHaveLength(0);
    expect(h.results('place')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Add Fragment' }));
    const region = useDesignStore.getState().designs[id].regions[0];
    expect(region).toMatchObject({
      sequence: payload.sequence,
      sourceSequenceId: payload.sourceSequenceId,
      sourceStart: payload.sourceStart,
      sourceEnd: payload.sourceEnd,
      rdEnds: payload.rdEnds,
      annotations: payload.annotations,
      sourceIsCircular: payload.sourceIsCircular,
    });
    expect(h.results('place')[0].properties).toMatchObject({
      outcome_kind: 'digest_use_accepted',
      affected_count: 1,
    });
  });

  it('records actual placement refusal on confirmation cancel without mutating the assembly', () => {
    const h = setup();
    const panel = render(<VirtualDigestPanel {...h.props} />);
    const transfer = transferData();
    fireEvent.dragStart(screen.getByTestId('fragment-row-0'), { dataTransfer: transfer });
    panel.unmount();
    const id = useDesignStore.getState().createDesign('Local assembly');
    render(<AssemblyPartsSection design={useDesignStore.getState().designs[id]} />);
    fireEvent.drop(screen.getByTestId('assembly-empty-parts-cue'), { dataTransfer: transfer });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useDesignStore.getState().designs[id].regions).toHaveLength(0);
    expect(h.results('place')[0].properties).toMatchObject({
      outcome_kind: 'digest_use_refused',
      affected_count: 0,
    });
  });

  it('keeps the committed copy join through the ordinary Paste as part owner', async () => {
    const h = setup();
    const panel = render(<VirtualDigestPanel {...h.props} />);
    await act(async () => {
      fireEvent.click(screen.getByTitle('Copy fragment sequence to clipboard'));
    });
    const copied = useRichSequenceClipboardStore.getState().copiedRegion!;
    panel.unmount();
    const id = useDesignStore.getState().createDesign('Local assembly');
    render(<AssemblyPartsSection design={useDesignStore.getState().designs[id]} />);
    fireEvent.click(screen.getByTestId('assembly-paste-as-part'));
    expect(useDesignStore.getState().designs[id].regions[0]).toMatchObject({
      sequence: copied.sequence,
      sourceStart: copied.start,
      sourceEnd: copied.end,
      rdEnds: copied.rdEnds,
      annotations: copied.annotations,
    });
    expect(h.results('place')[0].properties.outcome_kind).toBe('digest_use_accepted');
  });

  it('attests the ordinary placeholder fill only after the real region update accepts its material', async () => {
    const h = setup();
    const panel = render(<VirtualDigestPanel {...h.props} />);
    await act(async () => {
      fireEvent.click(screen.getByTitle('Copy fragment sequence to clipboard'));
    });
    const copied = useRichSequenceClipboardStore.getState().copiedRegion!;
    panel.unmount();
    const id = useDesignStore.getState().createDesign('Local placeholder assembly');
    useDesignStore.getState().addRegion(id, emptyDesignRegion());
    const design = useDesignStore.getState().designs[id];
    const placeholder = design.regions[0];
    render(<AssemblyPartsSection design={design} />);
    fireEvent.click(screen.getByTestId(`assembly-placeholder-paste-${placeholder.id}`));
    const accepted = useDesignStore.getState().designs[id].regions;
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      id: placeholder.id,
      isPlaceholder: false,
      sequence: copied.sequence,
      sourceStart: copied.start,
      sourceEnd: copied.end,
      rdEnds: copied.rdEnds,
    });
    expect(h.results('place')[0].properties.outcome_kind).toBe('digest_use_accepted');
  });
});
