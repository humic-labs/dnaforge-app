import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AssemblyPrimerOligoEntry,
  AssemblyPrimerOligoReport,
  LinkAssemblyPrimerOligosResult,
} from '../../assembly/public/saved-primer-oligos';
import type { SavedOligoSnapshot, SavedPrimerLink } from '../../design/public/saved-primer-links';
import type { DesignPrimer, DesignPrimerPair, SequenceDesign } from '../../design/public/types';
import { ExportSection } from './ExportSection';

const commands = vi.hoisted(() => ({ inspect: vi.fn(), link: vi.fn(), reconcile: vi.fn() }));
const navigation = vi.hoisted(() => ({ openLimsEntity: vi.fn() }));

vi.mock('../../assembly/public/saved-primer-oligos', () => ({
  inspectAssemblyPrimerOligos: commands.inspect,
  linkAssemblyPrimerOligos: commands.link,
  reconcileAssemblyPrimerOligos: commands.reconcile,
}));

vi.mock('../../lims/public/open-entity', () => ({
  openLimsEntity: navigation.openLimsEntity,
  isLimsEntityOpened: (result: { status: string }) => result.status.startsWith('opened'),
}));

vi.mock('../hooks/useFinalizeAcceptedAssembly', () => ({
  useFinalizeAcceptedAssembly: () => ({
    warningCount: 0,
    disabledReason: null,
    destinationState: 'loading',
    saveDirectory: '',
    initialSaveDirectory: '',
    isCustomPath: false,
    isExistingPackage: false,
    canFinalize: false,
    status: { state: 'idle' },
    finalize: vi.fn(),
    redraft: vi.fn(),
    resetSavePath: vi.fn(),
    selectSaveDirectory: vi.fn(),
  }),
}));

vi.mock('./AssemblySaveLocationPicker', () => ({ AssemblySaveLocationPicker: () => null }));

const TAIL = 'AGAGGAGAAATACTA';
const BINDING = 'ATGAGTTTATGGAAAAAAATCAGCCTCGG';

function primer(fragmentIndex: number, direction: 'forward' | 'reverse'): DesignPrimer {
  return {
    id: `p${fragmentIndex}-${direction}`,
    name: `F${fragmentIndex + 1} ${direction}`,
    sequence: `${TAIL}${BINDING}`,
    pbs: { start: 0, end: BINDING.length, sequence: BINDING },
    overhang: { length: TAIL.length, sequence: TAIL, tailLength: TAIL.length },
    direction,
    fragmentIndex,
    junctionIndex: fragmentIndex,
    tm: 58.2,
  };
}

const DESIGN_DEFAULTS = {
  topology: 'circular',
  assemblyState: 'ready',
  validationErrors: [],
  proposedPlans: [],
  defaultHomologyLength: 30,
  homologyRegions: [],
  selectedJunctionIndex: null,
  scrollToPosition: null,
  highlightRange: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
} satisfies Partial<SequenceDesign>;

function pairs(count: number): DesignPrimerPair[] {
  return Array.from({ length: count }, (_, fragmentIndex) => ({
    fragmentIndex,
    forward: primer(fragmentIndex, 'forward'),
    reverse: primer(fragmentIndex, 'reverse'),
  }));
}

function design(overrides: Partial<SequenceDesign> = {}): SequenceDesign {
  return {
    ...DESIGN_DEFAULTS,
    id: 'design-1',
    name: 'TamB Gibson',
    version: 11,
    assemblyMethod: 'gibson',
    regions: [],
    spacers: [],
    designPrimers: pairs(1),
    ...overrides,
  };
}

function oligo(oligoId: string, catalogNumber: string, revision = 2): SavedOligoSnapshot {
  return {
    oligoId,
    catalogNumber,
    name: `saved ${catalogNumber}`,
    bases: `${TAIL}${BINDING}`,
    sequenceContentHash: `hash:${oligoId}`,
    artifactRevision: revision,
    chemistry: null,
    bindingSequence: BINDING,
    tmC: 58.9,
    tmConcentrationNm: 500,
    tmModelLabel: 'Default (SantaLucia)',
    bindings: [],
  };
}

function link(primerId: string, oligoId: string, artifactRevision = 2): SavedPrimerLink {
  return {
    primerId,
    oligoId,
    artifactRevision,
    sequenceContentHash: `hash:${oligoId}`,
    linkedAtDesignVersion: 11,
    linkedAt: '2026-11-10T12:00:00.000Z',
    via: 'matched-existing',
  };
}

function entry(
  designPrimer: DesignPrimer,
  overrides: Partial<AssemblyPrimerOligoEntry> = {}
): AssemblyPrimerOligoEntry {
  return {
    use: {
      designId: 'design-1',
      designName: 'TamB Gibson',
      designVersion: 11,
      assemblyMethod: 'gibson',
      primerId: designPrimer.id,
      primerName: designPrimer.name,
      partNumber: designPrimer.fragmentIndex + 1,
      direction: designPrimer.direction,
      sequence: designPrimer.sequence,
      bindingSequence: BINDING,
      tailSequence: TAIL,
      tmC: 58.2,
      chemistry: null,
      sourceSite: null,
    },
    status: 'unsaved',
    link: null,
    oligo: null,
    candidates: [],
    oligoRevisedSinceLink: false,
    oligoBindingSplit: 'unavailable',
    sourceAttachment: { kind: 'none' },
    ...overrides,
  };
}

function linkedEntry(
  designPrimer: DesignPrimer,
  catalogNumber: string,
  overrides: Partial<AssemblyPrimerOligoEntry> = {}
): AssemblyPrimerOligoEntry {
  const saved = oligo(`oligo-${designPrimer.id}`, catalogNumber);
  return entry(designPrimer, {
    status: 'linked',
    oligo: saved,
    link: link(designPrimer.id, saved.oligoId),
    oligoBindingSplit: 'same',
    ...overrides,
  });
}

function report(
  primers: AssemblyPrimerOligoEntry[],
  overrides: Partial<AssemblyPrimerOligoReport> = {}
): AssemblyPrimerOligoReport {
  return {
    designId: 'design-1',
    designName: 'TamB Gibson',
    designVersion: 11,
    workspaceRoot: '/project',
    tm: { evaluates: 'binding-part', modelLabel: 'Default (SantaLucia)', primerConcNm: 250 },
    primers,
    ...overrides,
  };
}

function completed(
  overrides: Partial<LinkAssemblyPrimerOligosResult>
): LinkAssemblyPrimerOligosResult {
  return {
    status: 'completed',
    changed: true,
    linked: [],
    kept: [],
    ambiguous: [],
    unsaved: [],
    unresolved: [],
    bindingSplitRestored: [],
    failed: [],
    oligoWrites: [],
    report: null,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function renderTable(current: SequenceDesign, projectRoot: string | null = '/project') {
  return render(
    <ExportSection design={current} primers={current.designPrimers} projectRoot={projectRoot} />
  );
}

const savedOligoCell = (position: string) =>
  screen.getByTestId(`assembly-primer-saved-oligo-${position}`);
const status = () => screen.getByTestId('assembly-primers-oligo-status');

describe('assembly primer table saved oligos', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    commands.inspect.mockResolvedValue(null);
    commands.reconcile.mockImplementation(async (designId: string) => ({
      report: (await commands.inspect(designId)) as AssemblyPrimerOligoReport | null,
      linked: [],
      refusal: null,
    }));
  });

  it('shows the binding split, every saved-oligo state, the Tm context and a summary', async () => {
    const current = design({ designPrimers: pairs(4) });
    const [first, second, third, fourth] = current.designPrimers;
    const p380 = oligo('oligo-380', 'P380', 4);
    const p381 = oligo('oligo-381', 'P381');
    commands.inspect.mockResolvedValue(
      report([
        entry(first!.forward, {
          status: 'linked',
          oligo: p380,
          link: link(first!.forward.id, p380.oligoId, 3),
          oligoRevisedSinceLink: true,
          oligoBindingSplit: 'missing',
        }),
        entry(first!.reverse, { status: 'match-available', oligo: p381, candidates: [p381] }),
        entry(second!.forward, {
          status: 'ambiguous',
          candidates: [oligo('oligo-a', 'P382'), oligo('oligo-b', 'P383')],
        }),
        entry(second!.reverse),
        entry(third!.forward, {
          status: 'draft-primer-changed',
          oligo: oligo('oligo-384', 'P384'),
          link: link(third!.forward.id, 'oligo-384'),
        }),
        entry(third!.reverse, {
          status: 'oligo-bases-changed',
          oligo: oligo('oligo-385', 'P385'),
          link: link(third!.reverse.id, 'oligo-385'),
        }),
        entry(fourth!.forward, {
          status: 'oligo-unavailable',
          link: link(fourth!.forward.id, 'oligo-gone'),
        }),
        linkedEntry(fourth!.reverse, 'P386'),
      ])
    );

    renderTable(current);

    await waitFor(() => expect(savedOligoCell('0-forward')).toHaveAttribute('data-link-state'));
    expect(commands.reconcile).toHaveBeenCalledWith('design-1');
    expect(screen.getByRole('columnheader', { name: 'Binding / tail' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Saved oligo' })).toBeInTheDocument();
    expect(screen.getByTestId('assembly-primer-row-0-forward')).toHaveTextContent('29 / 15 nt');

    expect(savedOligoCell('0-forward')).toHaveAttribute('data-link-state', 'linked');
    expect(screen.getByTestId('assembly-primer-open-oligo-0-forward')).toHaveTextContent(
      'P380 · saved P380'
    );
    expect(savedOligoCell('0-forward')).toHaveTextContent('rev 3, now rev 4');

    expect(savedOligoCell('0-reverse')).toHaveAttribute('data-link-state', 'match-available');
    expect(savedOligoCell('0-reverse')).toHaveTextContent('Matches P381 (not linked)');

    expect(savedOligoCell('1-forward')).toHaveAttribute('data-link-state', 'ambiguous');
    expect(within(savedOligoCell('1-forward')).getByTitle('P382, P383')).toHaveTextContent(
      '2 identical saved oligos'
    );

    expect(screen.getByTestId('assembly-primer-choose-oligo-1-forward-P382')).toHaveTextContent(
      'Link P382'
    );
    expect(screen.getByTestId('assembly-primer-choose-oligo-1-forward-P383')).toBeEnabled();

    expect(savedOligoCell('1-reverse')).toHaveAttribute('data-link-state', 'unsaved');
    expect(savedOligoCell('1-reverse')).toHaveTextContent('Not saved');

    expect(savedOligoCell('2-forward')).toHaveAttribute('data-link-state', 'draft-primer-changed');
    expect(savedOligoCell('2-forward')).toHaveTextContent('Draft differs from P384');
    expect(screen.getByTestId('assembly-primer-open-oligo-2-forward')).toBeInTheDocument();

    expect(savedOligoCell('2-reverse')).toHaveAttribute('data-link-state', 'oligo-bases-changed');
    expect(savedOligoCell('2-reverse')).toHaveTextContent('P385 was edited after linking');
    expect(screen.getByTestId('assembly-primer-open-oligo-2-reverse')).toBeInTheDocument();

    expect(savedOligoCell('3-forward')).toHaveAttribute('data-link-state', 'oligo-unavailable');
    expect(savedOligoCell('3-forward')).toHaveTextContent('Saved oligo unavailable');

    expect(savedOligoCell('3-reverse')).toHaveTextContent('rev 2');
    expect(savedOligoCell('3-reverse')).not.toHaveTextContent('now rev');

    expect(screen.getByTestId('assembly-primers-link-saved')).toBeEnabled();
    expect(screen.getByTestId('assembly-primers-save-to-registry')).toBeEnabled();
    expect(screen.getByTestId('assembly-primers-restore-split')).toHaveTextContent(
      'Restore binding split (1)'
    );
    expect(screen.getByTestId('assembly-primers-restore-split').title).toContain(
      'no record of which bases bind the template'
    );
    expect(status()).toHaveAttribute('role', 'status');
    expect(status()).toHaveTextContent(
      '2 of 8 primers linked to saved oligos. 3 links need attention. 1 matches a saved oligo but is not linked. 1 primer has several identical saved oligos. 1 not saved.'
    );
    expect(screen.getByTestId('assembly-primers-tm-context')).toHaveTextContent(
      'Tm is calculated on the binding part only · Default (SantaLucia) · 250 nM primer.'
    );
  });

  it('summarizes a fully linked and a never saved table without offering actions it cannot take', async () => {
    const current = design();
    const [pair] = current.designPrimers;
    commands.inspect.mockResolvedValue(
      report([linkedEntry(pair!.forward, 'P380'), linkedEntry(pair!.reverse, 'P381')])
    );
    const view = renderTable(current);
    await waitFor(() =>
      expect(status()).toHaveTextContent('2 of 2 primers linked to saved oligos.')
    );
    expect(screen.queryByTestId('assembly-primers-link-saved')).not.toBeInTheDocument();
    expect(screen.queryByTestId('assembly-primers-save-to-registry')).not.toBeInTheDocument();
    expect(screen.queryByTestId('assembly-primers-restore-split')).not.toBeInTheDocument();
    view.unmount();

    commands.inspect.mockResolvedValue(report([entry(pair!.forward), entry(pair!.reverse)]));
    renderTable(current);
    await waitFor(() => expect(status()).toHaveTextContent('No primers saved yet.'));
    expect(screen.queryByTestId('assembly-primers-link-saved')).not.toBeInTheDocument();
    expect(screen.getByTestId('assembly-primers-save-to-registry')).toBeInTheDocument();
  });

  it('links matching oligos at the design version on screen and reports what happened', async () => {
    const current = design();
    const [pair] = current.designPrimers;
    const p380 = oligo('oligo-380', 'P380');
    const p381 = oligo('oligo-381', 'P381');
    commands.inspect.mockResolvedValue(
      report([
        entry(pair!.forward, { status: 'match-available', oligo: p380, candidates: [p380] }),
        entry(pair!.reverse, { status: 'match-available', oligo: p381, candidates: [p381] }),
      ])
    );
    const linking = deferred<LinkAssemblyPrimerOligosResult>();
    commands.link.mockReturnValue(linking.promise);

    renderTable(current);
    fireEvent.click(await screen.findByTestId('assembly-primers-link-saved'));

    expect(commands.link).toHaveBeenCalledExactlyOnceWith({
      designId: 'design-1',
      expectedDesignVersion: 11,
    });
    expect(screen.getByTestId('assembly-primers-link-saved')).toBeDisabled();

    linking.resolve(
      completed({
        linked: [
          { primerId: pair!.forward.id, oligoId: 'oligo-380', via: 'matched-existing' },
          { primerId: pair!.reverse.id, oligoId: 'oligo-381', via: 'matched-existing' },
        ],
        report: report([
          entry(pair!.forward, {
            status: 'linked',
            oligo: p380,
            link: link(pair!.forward.id, 'oligo-380'),
            oligoBindingSplit: 'same',
          }),
          entry(pair!.reverse, {
            status: 'linked',
            oligo: p381,
            link: link(pair!.reverse.id, 'oligo-381'),
            oligoBindingSplit: 'same',
          }),
        ]),
      })
    );

    await waitFor(() => expect(status()).toHaveTextContent('2 primers linked to saved oligos.'));
    expect(savedOligoCell('0-forward')).toHaveAttribute('data-link-state', 'linked');
    expect(savedOligoCell('0-reverse')).toHaveAttribute('data-link-state', 'linked');
    expect(screen.queryByTestId('assembly-primers-link-saved')).not.toBeInTheDocument();
  });

  it('saves unsaved primers to the registry and keeps the result after the links reload', async () => {
    const current = design();
    const [pair] = current.designPrimers;
    const after = report([linkedEntry(pair!.forward, 'P380'), linkedEntry(pair!.reverse, 'P381')]);
    commands.inspect.mockResolvedValueOnce(
      report([entry(pair!.forward), linkedEntry(pair!.reverse, 'P381')])
    );
    commands.inspect.mockResolvedValue(after);
    commands.link.mockResolvedValue(
      completed({
        linked: [{ primerId: pair!.forward.id, oligoId: 'oligo-380', via: 'saved-from-assembly' }],
        kept: [pair!.reverse.id],
        report: after,
      })
    );

    const view = renderTable(current);
    fireEvent.click(await screen.findByTestId('assembly-primers-save-to-registry'));

    expect(commands.link).toHaveBeenCalledExactlyOnceWith({
      designId: 'design-1',
      expectedDesignVersion: 11,
      saveUnsaved: true,
    });
    await waitFor(() =>
      expect(status()).toHaveTextContent('1 saved to the registry, 1 already linked.')
    );

    const linked = design({
      savedPrimerLinks: [link(pair!.forward.id, 'oligo-380'), link(pair!.reverse.id, 'oligo-381')],
    });
    view.rerender(
      <ExportSection design={linked} primers={current.designPrimers} projectRoot="/project" />
    );
    await waitFor(() => expect(commands.inspect).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(savedOligoCell('0-forward')).toHaveTextContent('P380'));
    expect(status()).toHaveTextContent('1 saved to the registry, 1 already linked.');
  });

  it('restores a missing binding split on request', async () => {
    const current = design();
    const [pair] = current.designPrimers;
    commands.inspect.mockResolvedValue(
      report([
        linkedEntry(pair!.forward, 'P380', { oligoBindingSplit: 'missing' }),
        linkedEntry(pair!.reverse, 'P381'),
      ])
    );
    commands.link.mockResolvedValue(
      completed({
        linked: [{ primerId: pair!.forward.id, oligoId: 'oligo-380', via: 'matched-existing' }],
        kept: [pair!.reverse.id],
        bindingSplitRestored: [
          { primerId: pair!.forward.id, oligoId: 'oligo-380', artifactRevision: 3 },
        ],
        report: report([linkedEntry(pair!.forward, 'P380'), linkedEntry(pair!.reverse, 'P381')]),
      })
    );

    renderTable(current);
    fireEvent.click(await screen.findByTestId('assembly-primers-restore-split'));

    expect(commands.link).toHaveBeenCalledExactlyOnceWith({
      designId: 'design-1',
      expectedDesignVersion: 11,
      restoreMissingBindingSplit: true,
    });
    await waitFor(() =>
      expect(status()).toHaveTextContent(
        'Binding split restored on 1 saved oligo, 1 already linked.'
      )
    );
    expect(screen.queryByTestId('assembly-primers-restore-split')).not.toBeInTheDocument();
  });

  it('says in plain words when a primer needs a choice, when a call is refused and when it fails', async () => {
    const current = design();
    const [pair] = current.designPrimers;
    const ambiguous = report([
      entry(pair!.forward, {
        status: 'ambiguous',
        candidates: [oligo('oligo-a', 'P382'), oligo('oligo-b', 'P383')],
      }),
      linkedEntry(pair!.reverse, 'P381'),
    ]);
    commands.inspect.mockResolvedValue(ambiguous);
    commands.link.mockResolvedValueOnce(
      completed({
        changed: false,
        kept: [pair!.reverse.id],
        ambiguous: [{ primerId: pair!.forward.id, oligoIds: ['oligo-a', 'oligo-b'] }],
        report: ambiguous,
      })
    );
    commands.link.mockResolvedValueOnce({
      ...completed({ changed: false }),
      status: 'refused',
      refusal: {
        code: 'project-unavailable',
        message:
          'The project that owns this design is not open, so its saved oligos cannot be read.',
      },
    });
    commands.link.mockRejectedValueOnce(new Error('The registry database is locked.'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    renderTable(current);
    const chooser = () => screen.getByTestId('assembly-primer-choose-oligo-0-forward-P382');
    expect(screen.queryByTestId('assembly-primers-link-saved')).not.toBeInTheDocument();

    fireEvent.click(await screen.findByTestId('assembly-primer-choose-oligo-0-forward-P382'));
    await waitFor(() =>
      expect(status()).toHaveTextContent(
        '1 already linked. 1 primer has several identical saved oligos; pick one in the Saved oligo column.'
      )
    );

    expect(chooser()).toBeEnabled();

    fireEvent.click(chooser());
    await waitFor(() =>
      expect(status()).toHaveTextContent(
        'The project that owns this design is not open, so its saved oligos cannot be read.'
      )
    );

    fireEvent.click(chooser());
    await waitFor(() =>
      expect(status()).toHaveTextContent(
        'We couldn’t complete this assembly action. Check your inputs and try again.'
      )
    );
    expect(status()).not.toHaveTextContent('registry database');
    expect(warn).toHaveBeenCalledWith(
      '[AssemblyPrimerOligos] Saved oligos could not be linked:',
      expect.objectContaining({ message: 'The registry database is locked.' })
    );
    warn.mockRestore();
    expect(chooser()).toBeEnabled();
    expect(commands.link).toHaveBeenCalledTimes(3);
  });

  it('links the saved oligo the researcher picks when several are identical', async () => {
    const current = design();
    const [pair] = current.designPrimers;
    commands.inspect.mockResolvedValue(
      report([
        entry(pair!.forward, {
          status: 'ambiguous',
          candidates: [oligo('oligo-a', 'P382'), oligo('oligo-b', 'P383')],
        }),
        linkedEntry(pair!.reverse, 'P381'),
      ])
    );
    commands.link.mockResolvedValueOnce(
      completed({
        linked: [{ primerId: pair!.forward.id, oligoId: 'oligo-b', via: 'matched-existing' }],
        kept: [pair!.reverse.id],
        report: report([linkedEntry(pair!.forward, 'P383'), linkedEntry(pair!.reverse, 'P381')]),
      })
    );

    renderTable(current);
    fireEvent.click(await screen.findByTestId('assembly-primer-choose-oligo-0-forward-P383'));

    expect(commands.link).toHaveBeenCalledExactlyOnceWith({
      designId: 'design-1',
      expectedDesignVersion: 11,
      choices: [{ primerId: pair!.forward.id, oligoId: 'oligo-b' }],
    });
    await waitFor(() =>
      expect(status()).toHaveTextContent('1 primer linked to a saved oligo, 1 already linked.')
    );
  });

  it('reports primers that could not be saved without showing raw error text', async () => {
    const current = design();
    const [pair] = current.designPrimers;
    const unsaved = report([entry(pair!.forward), linkedEntry(pair!.reverse, 'P381')]);
    commands.inspect.mockResolvedValue(unsaved);
    commands.link.mockResolvedValue(
      completed({
        changed: false,
        kept: [pair!.reverse.id],
        failed: [{ primerId: pair!.forward.id, message: 'SQLITE_BUSY: database is locked' }],
        report: unsaved,
      })
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    renderTable(current);
    fireEvent.click(await screen.findByTestId('assembly-primers-save-to-registry'));

    await waitFor(() =>
      expect(status()).toHaveTextContent(
        '1 already linked. 1 primer could not be saved or linked. We couldn’t complete this primer action. Check your inputs and try again.'
      )
    );
    expect(status()).not.toHaveTextContent('SQLITE_BUSY');
    expect(warn).toHaveBeenCalledWith('[AssemblyPrimerOligos] Some primers were not linked:', [
      { primerId: pair!.forward.id, message: 'SQLITE_BUSY: database is locked' },
    ]);
    warn.mockRestore();
  });

  it('offers Save to registry for a link whose draft primer changed', async () => {
    const current = design();
    const [pair] = current.designPrimers;
    const stale = report([
      entry(pair!.forward, {
        status: 'draft-primer-changed',
        oligo: oligo('oligo-380', 'P380'),
        link: link(pair!.forward.id, 'oligo-380'),
      }),
      linkedEntry(pair!.reverse, 'P381'),
    ]);
    commands.inspect.mockResolvedValue(stale);
    commands.link.mockResolvedValue(
      completed({
        changed: false,
        kept: [pair!.reverse.id],
        unresolved: [
          { primerId: pair!.forward.id, state: 'draft-primer-changed', oligoId: 'oligo-380' },
        ],
        report: stale,
      })
    );

    renderTable(current);
    fireEvent.click(await screen.findByTestId('assembly-primers-link-saved'));

    await waitFor(() =>
      expect(status()).toHaveTextContent(
        '1 primer no longer matches its saved oligo; use Save to registry to save the current bases.'
      )
    );
    expect(screen.getByTestId('assembly-primers-save-to-registry')).toBeEnabled();
  });

  it('disables the actions and explains why when the project is not open', async () => {
    const current = design();
    const [pair] = current.designPrimers;
    commands.inspect.mockResolvedValue(report([entry(pair!.forward), entry(pair!.reverse)]));

    renderTable(current, null);

    const save = await screen.findByTestId('assembly-primers-save-to-registry');
    expect(save).toBeDisabled();
    expect(save.title).toContain('Open the project that owns this design');
    fireEvent.click(save);
    expect(commands.link).not.toHaveBeenCalled();
  });

  it('ignores a report that arrives after the design changed', async () => {
    const first = design();
    const second = design({ id: 'design-2', name: 'Other design' });
    const [pair] = first.designPrimers;
    const slow = deferred<AssemblyPrimerOligoReport | null>();
    commands.inspect.mockImplementation((designId: string) =>
      designId === 'design-1'
        ? slow.promise
        : Promise.resolve(
            report([entry(pair!.forward), entry(pair!.reverse)], { designId: 'design-2' })
          )
    );

    const view = renderTable(first);
    view.rerender(
      <ExportSection design={second} primers={second.designPrimers} projectRoot="/project" />
    );
    await waitFor(() => expect(savedOligoCell('0-forward')).toHaveTextContent('Not saved'));

    await act(async () => {
      slow.resolve(
        report([linkedEntry(pair!.forward, 'P380'), linkedEntry(pair!.reverse, 'P381')])
      );
      await slow.promise;
    });
    expect(commands.inspect).toHaveBeenCalledTimes(2);

    expect(savedOligoCell('0-forward')).toHaveAttribute('data-link-state', 'unsaved');
    expect(status()).toHaveTextContent('No primers saved yet.');
  });

  it('keeps the newest report when an older read of the same design finishes late', async () => {
    const before = design();
    const after = design({ version: 12, designPrimers: pairs(1) });
    const [pair] = after.designPrimers;
    const slow = deferred<AssemblyPrimerOligoReport | null>();
    commands.inspect.mockReturnValueOnce(slow.promise);
    commands.inspect.mockResolvedValue(
      report([linkedEntry(pair!.forward, 'P380'), linkedEntry(pair!.reverse, 'P381')])
    );

    const view = renderTable(before);
    view.rerender(
      <ExportSection design={after} primers={after.designPrimers} projectRoot="/project" />
    );
    await waitFor(() => expect(savedOligoCell('0-forward')).toHaveTextContent('P380'));

    await act(async () => {
      slow.resolve(report([entry(pair!.forward), entry(pair!.reverse)]));
      await slow.promise;
    });

    expect(commands.inspect).toHaveBeenCalledTimes(2);
    expect(savedOligoCell('0-forward')).toHaveAttribute('data-link-state', 'linked');
  });

  it('opens a linked oligo through the registry and reports a failed open', async () => {
    const current = design();
    const [pair] = current.designPrimers;
    commands.inspect.mockResolvedValue(
      report([linkedEntry(pair!.forward, 'P380'), linkedEntry(pair!.reverse, 'P381')])
    );
    navigation.openLimsEntity.mockResolvedValueOnce({ status: 'opened_primer', tabId: 'tab-1' });
    navigation.openLimsEntity.mockResolvedValueOnce({
      status: 'not_opened',
      target: null,
      message: 'The project that owns this primer is unavailable.',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    renderTable(current);
    fireEvent.click(await screen.findByTestId('assembly-primer-open-oligo-0-forward'));
    expect(navigation.openLimsEntity).toHaveBeenLastCalledWith({
      entityId: `oligo-${pair!.forward.id}`,
    });
    await waitFor(() => expect(navigation.openLimsEntity).toHaveBeenCalledTimes(1));
    expect(status()).toHaveTextContent('2 of 2 primers linked to saved oligos.');

    fireEvent.click(screen.getByTestId('assembly-primer-open-oligo-0-reverse'));
    await waitFor(() =>
      expect(status()).toHaveTextContent('Saved oligo P381 could not be opened.')
    );
    expect(warn).toHaveBeenCalledWith(
      '[AssemblyPrimerOligos] A saved oligo could not be opened:',
      'The project that owns this primer is unavailable.'
    );
    warn.mockRestore();
  });

  it('does not read saved oligos or show their status when there are no primers', async () => {
    const current = design({ designPrimers: [] });
    renderTable(current);
    await Promise.resolve();
    expect(commands.inspect).not.toHaveBeenCalled();
    expect(commands.reconcile).not.toHaveBeenCalled();
    expect(screen.queryByTestId('assembly-primers-oligo-status')).not.toBeInTheDocument();
  });

  it('links matching saved oligos when the design opens, with no press', async () => {
    const current = design();
    const [pair] = current.designPrimers;
    const p380 = oligo('oligo-380', 'P380');
    const p381 = oligo('oligo-381', 'P381');
    commands.reconcile.mockResolvedValue({
      report: report([
        entry(pair!.forward, {
          status: 'linked',
          oligo: p380,
          link: link(pair!.forward.id, 'oligo-380'),
          oligoBindingSplit: 'same',
        }),
        entry(pair!.reverse, {
          status: 'linked',
          oligo: p381,
          link: link(pair!.reverse.id, 'oligo-381'),
          oligoBindingSplit: 'same',
        }),
      ]),
      linked: [
        { primerId: pair!.forward.id, oligoId: 'oligo-380', via: 'matched-existing' },
        { primerId: pair!.reverse.id, oligoId: 'oligo-381', via: 'matched-existing' },
      ],
      refusal: null,
    });

    renderTable(current);

    await waitFor(() =>
      expect(status()).toHaveTextContent('2 of 2 primers linked to saved oligos.')
    );
    expect(commands.reconcile).toHaveBeenCalledExactlyOnceWith('design-1');
    expect(savedOligoCell('0-forward')).toHaveAttribute('data-link-state', 'linked');
    expect(screen.getByTestId('assembly-primer-open-oligo-0-forward')).toHaveTextContent(
      'P380 · saved P380'
    );
    expect(screen.queryByTestId('assembly-primers-link-saved')).not.toBeInTheDocument();
  });

  it('offers the link press only when opening the design could not link them', async () => {
    const current = design();
    const [pair] = current.designPrimers;
    const p380 = oligo('oligo-380', 'P380');
    commands.reconcile.mockResolvedValue({
      report: report([
        entry(pair!.forward, { status: 'match-available', oligo: p380, candidates: [p380] }),
        linkedEntry(pair!.reverse, 'P381'),
      ]),
      linked: [],
      refusal: { code: 'design-busy', message: 'The design is being finalized.' },
    });

    renderTable(current);

    await waitFor(() =>
      expect(savedOligoCell('0-forward')).toHaveAttribute('data-link-state', 'match-available')
    );
    expect(screen.getByTestId('assembly-primers-link-saved')).toBeInTheDocument();
  });

  it('links once for a design version and again only after the design changes', async () => {
    const current = design();
    const [pair] = current.designPrimers;
    const linked = report([linkedEntry(pair!.forward, 'P380'), linkedEntry(pair!.reverse, 'P381')]);
    commands.reconcile.mockResolvedValue({ report: linked, linked: [], refusal: null });
    commands.inspect.mockResolvedValue(linked);

    const view = renderTable(current);
    await waitFor(() => expect(commands.reconcile).toHaveBeenCalledTimes(1));

    view.rerender(
      <ExportSection
        design={design({ savedPrimerLinks: [link(pair!.forward.id, 'oligo-380')] })}
        primers={current.designPrimers}
        projectRoot="/project"
      />
    );
    await waitFor(() => expect(commands.inspect).toHaveBeenCalledTimes(1));
    expect(commands.reconcile).toHaveBeenCalledTimes(1);

    view.rerender(
      <ExportSection
        design={design({ version: 12 })}
        primers={current.designPrimers}
        projectRoot="/project"
      />
    );
    await waitFor(() => expect(commands.reconcile).toHaveBeenCalledTimes(2));
  });

  it('marks a linked oligo whose binding part is missing or disagrees', async () => {
    const current = design({ designPrimers: pairs(2) });
    const [first, second] = current.designPrimers;
    commands.inspect.mockResolvedValue(
      report([
        linkedEntry(first!.forward, 'P380', { oligoBindingSplit: 'missing' }),
        linkedEntry(first!.reverse, 'P381', { oligoBindingSplit: 'different' }),
        linkedEntry(second!.forward, 'P382'),
        linkedEntry(second!.reverse, 'P383'),
      ])
    );

    renderTable(current);

    const splitNote = (position: string) =>
      screen.getByTestId(`assembly-primer-oligo-split-${position}`);
    await waitFor(() => expect(splitNote('0-forward')).toHaveAttribute('data-split', 'missing'));
    expect(splitNote('0-forward')).toHaveTextContent('No binding part on file');
    expect(splitNote('0-reverse')).toHaveTextContent('Binding part differs');
    expect(screen.queryByTestId('assembly-primer-oligo-split-1-forward')).not.toBeInTheDocument();
    expect(screen.getByTestId('assembly-primers-restore-split')).toHaveTextContent(
      'Restore binding split (1)'
    );
  });
});
