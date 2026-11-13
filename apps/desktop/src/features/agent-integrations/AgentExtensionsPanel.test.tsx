import { userMessage } from '@waypoint/user-messages';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  workspacePath: '/workspace',
  capture: vi.fn(),
  analyticsReady: true,
  listManaged: vi.fn(),
  discover: vi.fn(),
  saveCommand: vi.fn(),
  saveSkill: vi.fn(),
  importSkill: vi.fn(),
  setSkillEnabled: vi.fn(),
  setProviderSkillEnabled: vi.fn(),
  inspectSkill: vi.fn(),
  listSkillPacks: vi.fn(),
  browseSkillPack: vi.fn(),
  reviewCatalogSkill: vi.fn(),
  installCatalogSkill: vi.fn(),
  removeSkill: vi.fn(),
  removeCommand: vi.fn(),
  openDialog: vi.fn(),
}));

vi.mock('../../lib/analytics', () => ({
  trackRendererEvent: mocks.capture,
  isAnalyticsCaptureReady: () => mocks.analyticsReady,
  getAnalyticsIdentifiedAccountId: () => 'synthetic-private-account',
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    agentCapabilities: mocks,
    dialog: { open: mocks.openDialog },
  }),
}));

vi.mock('../../stores/workspaceStore', () => ({
  useWorkspaceStore: (selector: (state: { folders: Array<{ path: string }> }) => unknown) =>
    selector({ folders: [{ path: mocks.workspacePath }] }),
}));

import { AgentExtensionsPanel } from './AgentExtensionsPanel';

const plugin = {
  id: 'codex-sdk:plugin:genomics-tools',
  provider: 'codex-sdk' as const,
  nativeId: 'genomics-tools',
  kind: 'plugin' as const,
  label: 'Genomics tools',
  description: 'Installed genomics analysis plugin.',
  scope: 'installation' as const,
  effects: ['process' as const],
  availability: { state: 'disabled-by-policy' as const, reason: 'Isolated.' },
  stages: {
    advertised: true,
    discoverable: true,
    invocable: false,
    visible: true,
    deterministic: true,
    liveQualified: false,
  },
  providerPlugin: {
    installed: true,
    updateAvailable: true,
    installable: true,
    removable: true,
    marketplace: 'local',
  },
};

const memoryReset = {
  ...plugin,
  id: 'codex-sdk:memory:reset',
  nativeId: 'reset',
  kind: 'memory' as const,
  label: 'Reset Codex memory',
  source: 'codex-memory-reset',
};

const managedCommand = {
  id: 'command-1',
  name: 'review-primers',
  description: 'Review a primer pair.',
  instructions: 'Check specificity and melting temperature.',
  provider: 'grok-acp' as const,
  scope: 'workspace' as const,
  workspacePath: '/workspace',
  createdAt: 1,
  updatedAt: 1,
};

const managedMemory = {
  id: 'memory-1',
  name: 'Current organism',
  content: 'This project uses E. coli K-12.',
  provider: 'claude-agent-sdk' as const,
  scope: 'workspace' as const,
  workspacePath: '/workspace',
  conversationId: null,
  createdAt: 1,
  updatedAt: 1,
};

const managedSkill = {
  id: 'skill-1',
  name: 'primer-review',
  description: 'Review primer designs before ordering.',
  instructions: 'Check specificity, melting temperature, and product size.',
  provider: 'all' as const,
  scope: 'workspace' as const,
  workspacePath: '/workspace',
  directoryPath: '/managed-skills/primer-review',
  enabled: true,
  hasSupportingFiles: true,
  origin: 'local' as const,
  source: null,
  contentDigest: null,
  createdAt: 1,
  updatedAt: 1,
};

describe('AgentExtensionsPanel', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  }
  async function openReviewedCatalog() {
    fireEvent.click(screen.getByRole('button', { name: 'Available skills' }));
    fireEvent.click(await screen.findByRole('button', { name: 'View crispr-guide-audit' }));
    const button = await screen.findByRole('button', { name: 'Install crispr-guide-audit' });
    await waitFor(() => expect(button).toBeEnabled());
    return button;
  }

  function skillEvents() {
    return mocks.capture.mock.calls
      .filter(([event]) => event === 'skill_operation_observed')
      .map(([, properties]) => properties);
  }

  it('observes real review and editor cancellation without claiming an installation or writing native data', async () => {
    render(<AgentExtensionsPanel view="skills" />);
    await openReviewedCatalog();
    expect(skillEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          skills_action: 'review',
          skills_result: 'reviewed',
          skills_installed: 'not_attested',
          skills_task_reuse: 'not_attested',
        }),
      ])
    );
    expect(mocks.installCatalogSkill).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'New skill' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Instructions' }), {
      target: { value: 'PRIVATE CANCELLED BODY' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(skillEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          skills_action: 'cancel',
          skills_result: 'cancelled',
          skills_authority: 'surface',
        }),
      ])
    );
    expect(mocks.saveSkill).not.toHaveBeenCalled();
    expect(mocks.importSkill).not.toHaveBeenCalled();
    expect(mocks.installCatalogSkill).not.toHaveBeenCalled();
    expect(JSON.stringify(skillEvents())).not.toMatch(
      /PRIVATE|crispr-guide-audit|review-token|github|synthetic-private-account/u
    );
  });

  it('observes leaving a reviewed catalog intent as surface cancellation with no native install', async () => {
    render(<AgentExtensionsPanel view="skills" />);
    await openReviewedCatalog();
    fireEvent.click(screen.getByRole('button', { name: 'Installed skills' }));
    expect(skillEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          skills_action: 'cancel',
          skills_result: 'cancelled',
          skills_source: 'catalog',
          skills_authority: 'surface',
          skills_installed: 'not_attested',
        }),
      ])
    );
    expect(mocks.installCatalogSkill).not.toHaveBeenCalled();
    expect(mocks.saveSkill).not.toHaveBeenCalled();
  });

  it('keeps native returned acceptance separate from failed inventory and makes refresh read only', async () => {
    render(<AgentExtensionsPanel view="skills" />);
    const install = await openReviewedCatalog();
    mocks.listManaged.mockRejectedValueOnce(new Error('Synthetic inventory unavailable'));
    fireEvent.click(install);
    await screen.findByText(
      'Skill installed. Refresh the installed skills to check the current list.'
    );
    expect(skillEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          skills_action: 'install',
          skills_stage: 'owner_return',
          skills_result: 'accepted',
          skills_installed: 'not_attested',
        }),
        expect.objectContaining({
          skills_action: 'install',
          skills_stage: 'readback',
          skills_result: 'inventory_unavailable',
          skills_installed: 'not_attested',
        }),
      ])
    );
    const reads = mocks.listManaged.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh installed skills' }));
    await waitFor(() => expect(mocks.listManaged.mock.calls.length).toBeGreaterThan(reads));
    await waitFor(() =>
      expect(skillEvents()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            skills_action: 'discover',
            skills_stage: 'readback',
            skills_result: 'inventory_returned',
          }),
        ])
      )
    );
    expect(mocks.installCatalogSkill).toHaveBeenCalledOnce();
  });

  it('attests installed inventory only after the exact accepted catalog target matches host scope and reviewed revision', async () => {
    render(<AgentExtensionsPanel view="skills" />);
    const install = await openReviewedCatalog();
    const review = await mocks.reviewCatalogSkill.mock.results[0].value;
    mocks.installCatalogSkill.mockImplementationOnce(async () => {
      mocks.listManaged.mockResolvedValue({
        commands: [],
        memory: [],
        skills: [
          {
            ...managedSkill,
            id: 'catalog-skill-1',
            name: review.skill.name,
            scope: 'global',
            workspacePath: null,
            origin: 'catalog',
            source: {
              packId: review.skill.packId,
              skillPath: review.skill.skillId,
              revision: review.skill.revision,
            },
          },
        ],
      });
      return { ok: true, skillId: 'catalog-skill-1' };
    });
    fireEvent.click(install);
    await waitFor(() =>
      expect(skillEvents()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            skills_action: 'install',
            skills_result: 'inventory_matched',
            skills_host: 'all',
            skills_scope: 'global',
            skills_installed: 'installed',
            skills_task_reuse: 'not_attested',
          }),
        ])
      )
    );
    expect(mocks.installCatalogSkill).toHaveBeenCalledOnce();
    expect(JSON.stringify(skillEvents())).not.toMatch(
      /catalog-skill-1|review-token|crispr-guide-audit|PRIVATE|github/u
    );
  });

  it.each(['wrong_host', 'wrong_scope', 'wrong_revision'])(
    'does not attest the accepted target from %s inventory',
    async (mismatch) => {
      render(<AgentExtensionsPanel view="skills" />);
      const install = await openReviewedCatalog();
      mocks.installCatalogSkill.mockImplementationOnce(async () => {
        const candidate = {
          ...managedSkill,
          id: 'catalog-skill-1',
          name: 'crispr-guide-audit',
          provider: mismatch === 'wrong_host' ? 'codex-sdk' : 'all',
          scope: mismatch === 'wrong_scope' ? 'workspace' : 'global',
          workspacePath: mismatch === 'wrong_scope' ? '/workspace' : null,
          origin: 'catalog',
          source: {
            packId: 'fixture-biology',
            skillPath: 'skills/crispr-guide-audit',
            revision: (mismatch === 'wrong_revision' ? 'b' : 'a').repeat(40),
          },
        };
        mocks.listManaged.mockResolvedValue({ commands: [], memory: [], skills: [candidate] });
        return { ok: true, skillId: candidate.id };
      });
      fireEvent.click(install);
      await screen.findByText(
        'Skill installed. Refresh the installed skills to check the current list.'
      );
      expect(skillEvents()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            skills_action: 'install',
            skills_result: 'inventory_unavailable',
            skills_installed: 'not_attested',
          }),
        ])
      );
      expect(skillEvents().some((row) => row.skills_result === 'inventory_matched')).toBe(false);
      expect(mocks.installCatalogSkill).toHaveBeenCalledOnce();
    }
  );

  it.each(['consent_off', 'publisher_throws'])(
    'preserves the exact native save when %s',
    async (failure) => {
      if (failure === 'consent_off') mocks.analyticsReady = false;
      else
        mocks.capture.mockImplementation(() => {
          throw new Error('Synthetic optional publisher failed');
        });
      render(<AgentExtensionsPanel view="skills" />);
      fireEvent.click(await screen.findByRole('button', { name: 'New skill' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
        target: { value: 'synthetic-audit' },
      });
      fireEvent.change(screen.getByRole('textbox', { name: 'Use when' }), {
        target: { value: 'Synthetic acceptance only.' },
      });
      fireEvent.change(screen.getByRole('textbox', { name: 'Instructions' }), {
        target: { value: 'PRIVATE SYNTHETIC BODY' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Create skill' }));
      await waitFor(() => expect(mocks.saveSkill).toHaveBeenCalledOnce());
      expect(mocks.saveSkill).toHaveBeenCalledWith({
        name: 'synthetic-audit',
        description: 'Synthetic acceptance only.',
        instructions: 'PRIVATE SYNTHETIC BODY',
        provider: 'all',
        scope: 'global',
        workspacePath: null,
        enabled: true,
      });
      if (failure === 'consent_off') expect(mocks.capture).not.toHaveBeenCalled();
    }
  );

  it('retires a consumed token before double activation and requires explicit fresh review before the retry', async () => {
    const failed = deferred<{ ok: false; error: string; stage: string }>();
    mocks.installCatalogSkill.mockReturnValueOnce(failed.promise);
    render(<AgentExtensionsPanel view="skills" />);
    const install = await openReviewedCatalog();
    const first = await mocks.reviewCatalogSkill.mock.results[0].value;
    act(() => {
      fireEvent.click(install);
      fireEvent.click(install);
    });
    expect(mocks.installCatalogSkill).toHaveBeenCalledTimes(1);
    await act(async () =>
      failed.resolve({ ok: false, error: 'Synthetic first download failed', stage: 'download' })
    );
    expect(await screen.findByText(userMessage('assistant.failed'))).toBeInTheDocument();
    expect(install).toBeDisabled();
    mocks.reviewCatalogSkill.mockResolvedValueOnce({ ...first, reviewToken: 'fresh-review-2' });
    fireEvent.click(screen.getByRole('button', { name: 'Review skill again' }));
    await waitFor(() => expect(install).toBeEnabled());
    expect(mocks.installCatalogSkill).toHaveBeenCalledTimes(1);
    fireEvent.click(install);
    await waitFor(() => expect(mocks.installCatalogSkill).toHaveBeenCalledTimes(2));
    expect(mocks.installCatalogSkill.mock.calls.map(([request]) => request.reviewToken)).toEqual([
      'review-token-1',
      'fresh-review-2',
    ]);
  });

  it('treats an expired review as requiring new authority rather than automatically installing on refresh', async () => {
    mocks.installCatalogSkill.mockResolvedValueOnce({
      ok: false,
      error: 'Review this skill again before installing it.',
    });
    render(<AgentExtensionsPanel view="skills" />);
    const install = await openReviewedCatalog();
    fireEvent.click(install);
    expect(
      await screen.findByText('Review this skill again before installing it.')
    ).toBeInTheDocument();
    expect(install).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh skill sources' }));
    await waitFor(() =>
      expect(mocks.browseSkillPack).toHaveBeenLastCalledWith({
        packId: 'fixture-biology',
        forceRefresh: true,
      })
    );
    expect(mocks.installCatalogSkill).toHaveBeenCalledTimes(1);
  });

  it('keeps a committed install separate from failed inventory readback and retries only the read', async () => {
    render(<AgentExtensionsPanel view="skills" />);
    const install = await openReviewedCatalog();
    mocks.listManaged.mockRejectedValueOnce(new Error('Synthetic inventory readback failed'));
    fireEvent.click(install);
    expect(
      await screen.findByText(
        'Skill installed. Refresh the installed skills to check the current list.'
      )
    ).toBeInTheDocument();
    expect(mocks.installCatalogSkill).toHaveBeenCalledTimes(1);
    expect(install).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Review skill again' }));
    await waitFor(() => expect(mocks.reviewCatalogSkill).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Add crispr-guide-audit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add crispr-guide-audit' }));
    expect(mocks.installCatalogSkill).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh installed skills' }));
    await waitFor(() =>
      expect(screen.queryByText('Synthetic inventory readback failed')).not.toBeInTheDocument()
    );
    expect(mocks.installCatalogSkill).toHaveBeenCalledTimes(1);
    expect(mocks.reviewCatalogSkill).toHaveBeenCalledTimes(2);
  });

  it('requires inventory reconciliation after an unknown native mutation outcome', async () => {
    mocks.installCatalogSkill.mockRejectedValueOnce(new Error('Synthetic lost acknowledgment'));
    render(<AgentExtensionsPanel view="skills" />);
    const install = await openReviewedCatalog();
    fireEvent.click(install);
    expect(
      await screen.findByText(
        'Installation outcome unknown. Refresh installed skills before trying again.'
      )
    ).toBeInTheDocument();
    expect(install).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Review skill again' }));
    await waitFor(() => expect(mocks.reviewCatalogSkill).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Add crispr-guide-audit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add crispr-guide-audit' }));
    expect(mocks.installCatalogSkill).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh installed skills' }));
    await waitFor(() =>
      expect(
        screen.queryByText(
          'Installation outcome unknown. Refresh installed skills before trying again.'
        )
      ).not.toBeInTheDocument()
    );
    expect(mocks.installCatalogSkill).toHaveBeenCalledTimes(1);
  });

  it('retires host/scope intent and obtains a new review before installing for the changed host', async () => {
    render(<AgentExtensionsPanel view="skills" />);
    const install = await openReviewedCatalog();
    const first = await mocks.reviewCatalogSkill.mock.results[0].value;
    fireEvent.click(screen.getByRole('combobox', { name: 'Install skill for' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Codex', exact: true }));
    await waitFor(() => expect(install).toBeDisabled());
    expect(mocks.installCatalogSkill).not.toHaveBeenCalled();
    mocks.reviewCatalogSkill.mockResolvedValueOnce({ ...first, reviewToken: 'codex-review' });
    fireEvent.click(screen.getByRole('button', { name: 'Review skill again' }));
    await waitFor(() => expect(install).toBeEnabled());
    fireEvent.click(install);
    await waitFor(() =>
      expect(mocks.installCatalogSkill).toHaveBeenCalledWith({
        reviewToken: 'codex-review',
        provider: 'codex-sdk',
        scope: 'global',
        workspacePath: null,
      })
    );
  });

  it('shows a changed reviewed revision and still requires another explicit install confirmation', async () => {
    render(<AgentExtensionsPanel view="skills" />);
    const install = await openReviewedCatalog();
    const firstReview = await mocks.reviewCatalogSkill.mock.results[0].value;
    const firstCatalog = await mocks.browseSkillPack.mock.results[0].value;
    mocks.browseSkillPack.mockResolvedValueOnce({
      ...firstCatalog,
      snapshot: { ...firstCatalog.snapshot, snapshotId: 'catalog-new', revision: 'c'.repeat(40) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh skill sources' }));
    await waitFor(() => expect(install).toBeDisabled());
    mocks.reviewCatalogSkill.mockResolvedValueOnce({
      ...firstReview,
      reviewToken: 'revision-c',
      skill: { ...firstReview.skill, revision: 'c'.repeat(40) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review skill again' }));
    expect(await screen.findByText('cccccccccccc')).toBeInTheDocument();
    await waitFor(() => expect(install).toBeEnabled());
    expect(mocks.installCatalogSkill).not.toHaveBeenCalled();
    fireEvent.click(install);
    await waitFor(() => expect(mocks.installCatalogSkill).toHaveBeenCalledTimes(1));
  });

  it('keeps Available pending independently of an already loaded installed inventory', async () => {
    const ready = await mocks.browseSkillPack.getMockImplementation()!({
      packId: 'fixture-biology',
    });
    const pending = deferred<typeof ready>();
    mocks.browseSkillPack.mockReturnValueOnce(pending.promise);
    mocks.listManaged.mockResolvedValue({ skills: [managedSkill] });
    render(<AgentExtensionsPanel view="skills" />);
    expect(await screen.findByText('1 installed · 1 enabled')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Available skills' }));
    expect(screen.getAllByText('Loading available skills…').length).toBeGreaterThan(0);
    expect(screen.queryByText('No matching skills.')).not.toBeInTheDocument();
    await act(async () => pending.resolve(ready));
    expect(
      await screen.findByRole('button', { name: 'View crispr-guide-audit' })
    ).toBeInTheDocument();
  });

  it('retains previously successful catalog rows on all-pack refresh failure and recovers with an explicit bounded retry', async () => {
    render(<AgentExtensionsPanel view="skills" />);
    fireEvent.click(screen.getByRole('button', { name: 'Available skills' }));
    expect(
      await screen.findByRole('button', { name: 'View crispr-guide-audit' })
    ).toBeInTheDocument();
    mocks.browseSkillPack.mockRejectedValueOnce(new Error('Synthetic catalog refresh failed'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh skill sources' }));
    expect(await screen.findByText(/Previously loaded skills are retained/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View crispr-guide-audit' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry skill sources' }));
    await waitFor(() =>
      expect(screen.queryByText(/Previously loaded skills are retained/)).not.toBeInTheDocument()
    );
    expect(mocks.installCatalogSkill).not.toHaveBeenCalled();
  });

  it('distinguishes all-pack first-read failure from true empty and no matches', async () => {
    mocks.browseSkillPack.mockRejectedValueOnce(new Error('Synthetic first catalog failure'));
    render(<AgentExtensionsPanel view="skills" />);
    fireEvent.click(screen.getByRole('button', { name: 'Available skills' }));
    expect(await screen.findByText('Available skills are unavailable.')).toBeInTheDocument();
    expect(screen.queryByText('No available skills.')).not.toBeInTheDocument();
    expect(screen.queryByText('No matching skills.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry skill sources' }));
    expect(
      await screen.findByRole('button', { name: 'View crispr-guide-audit' })
    ).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search skills' }), {
      target: { value: 'no synthetic match' },
    });
    expect(screen.getByText('No matching skills.')).toBeInTheDocument();
  });

  it('shows true empty only after a successful empty catalog receipt', async () => {
    const ready = await mocks.browseSkillPack.getMockImplementation()!({
      packId: 'fixture-biology',
    });
    mocks.browseSkillPack.mockResolvedValueOnce({
      ...ready,
      snapshot: { ...ready.snapshot, skills: [] },
    });
    render(<AgentExtensionsPanel view="skills" />);
    fireEvent.click(screen.getByRole('button', { name: 'Available skills' }));
    expect(await screen.findByText('No available skills.')).toBeInTheDocument();
    expect(screen.queryByText('No matching skills.')).not.toBeInTheDocument();
  });

  it('cannot let an older catalog success clear a newer context failure', async () => {
    const ready = await mocks.browseSkillPack.getMockImplementation()!({
      packId: 'fixture-biology',
    });
    const old = deferred<typeof ready>();
    mocks.browseSkillPack
      .mockReturnValueOnce(old.promise)
      .mockRejectedValueOnce(new Error('Current source unavailable'));
    const view = render(<AgentExtensionsPanel view="skills" />);
    fireEvent.click(screen.getByRole('button', { name: 'Available skills' }));
    await waitFor(() => expect(mocks.browseSkillPack).toHaveBeenCalledTimes(1));
    mocks.workspacePath = '/other';
    view.rerender(<AgentExtensionsPanel view="skills" />);
    expect(await screen.findByText('Available skills are unavailable.')).toBeInTheDocument();
    await act(async () => old.resolve(ready));
    expect(screen.getByText('Available skills are unavailable.')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'View crispr-guide-audit' })
    ).not.toBeInTheDocument();
  });

  it('cannot let an older catalog failure replace a newer successful context', async () => {
    const ready = await mocks.browseSkillPack.getMockImplementation()!({
      packId: 'fixture-biology',
    });
    const old = deferred<typeof ready>();
    mocks.browseSkillPack.mockReturnValueOnce(old.promise).mockResolvedValueOnce(ready);
    const view = render(<AgentExtensionsPanel view="skills" />);
    fireEvent.click(screen.getByRole('button', { name: 'Available skills' }));
    await waitFor(() => expect(mocks.browseSkillPack).toHaveBeenCalledTimes(1));
    mocks.workspacePath = '/other';
    view.rerender(<AgentExtensionsPanel view="skills" />);
    expect(
      await screen.findByRole('button', { name: 'View crispr-guide-audit' })
    ).toBeInTheDocument();
    await act(async () => old.reject(new Error('Obsolete failure')));
    expect(screen.queryByText('Obsolete failure')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View crispr-guide-audit' })).toBeInTheDocument();
  });

  it('does not put a late install failure into a different selected skill detail', async () => {
    mocks.listManaged.mockResolvedValue({ skills: [managedSkill] });
    const pending = deferred<{ ok: false; error: string; stage: string }>();
    mocks.installCatalogSkill.mockReturnValueOnce(pending.promise);
    render(<AgentExtensionsPanel view="skills" />);
    const install = await openReviewedCatalog();
    fireEvent.click(install);
    fireEvent.click(screen.getByRole('button', { name: 'Installed skills' }));
    fireEvent.click(await screen.findByRole('button', { name: 'View primer-review' }));
    await act(async () =>
      pending.resolve({ ok: false, error: 'Obsolete row install failure', stage: 'download' })
    );
    const details = screen.getByRole('region', { name: 'Skill details' });
    expect(details).toHaveTextContent(managedSkill.instructions);
    expect(within(details).queryByText('Obsolete row install failure')).not.toBeInTheDocument();
  });

  it('retires a pending review on workspace transition without applying its token or document to the new context', async () => {
    const result = await mocks.reviewCatalogSkill.getMockImplementation()!({
      snapshotId: 'catalog-snapshot-1',
      skillId: 'skills/crispr-guide-audit',
    });
    const old = deferred<typeof result>();
    mocks.reviewCatalogSkill.mockReturnValueOnce(old.promise);
    const view = render(<AgentExtensionsPanel view="skills" />);
    fireEvent.click(screen.getByRole('button', { name: 'Available skills' }));
    fireEvent.click(await screen.findByRole('button', { name: 'View crispr-guide-audit' }));
    await waitFor(() => expect(mocks.reviewCatalogSkill).toHaveBeenCalledTimes(1));
    mocks.workspacePath = '/other';
    view.rerender(<AgentExtensionsPanel view="skills" />);
    await act(async () => old.resolve(result));
    expect(
      screen.queryByRole('button', { name: 'Install crispr-guide-audit' })
    ).not.toBeInTheDocument();
    expect(mocks.installCatalogSkill).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.analyticsReady = true;
    mocks.capture.mockReset().mockImplementation(() => undefined);
    mocks.workspacePath = '/workspace';
    mocks.listManaged.mockResolvedValue({ commands: [], skills: [], memory: [] });
    mocks.discover.mockResolvedValue({
      schemaVersion: 1,
      snapshotId: 'snapshot-codex',
      provider: 'codex-sdk',
      providerVersion: '1',
      accountFingerprint: 'account-a',
      workspaceFingerprint: 'workspace-a',
      capturedAt: 1,
      controls: [plugin, memoryReset],
    });
    mocks.saveCommand.mockResolvedValue({ ok: true });
    mocks.removeCommand.mockResolvedValue({ ok: true });
    mocks.saveSkill.mockResolvedValue({ ok: true });
    mocks.importSkill.mockResolvedValue({ ok: true });
    mocks.setSkillEnabled.mockResolvedValue({ ok: true });
    mocks.setProviderSkillEnabled.mockResolvedValue({ ok: true });
    mocks.inspectSkill.mockResolvedValue({
      ok: true,
      skill: {
        document:
          '---\nname: sequence-audit\ndescription: Audit a sequence.\n---\n\n# Sequence audit\n\nRun every check in order.\n',
        sourcePath: '~/.codex/skills/sequence-audit/SKILL.md',
        files: [{ path: 'SKILL.md', byteCount: 128 }],
      },
    });
    mocks.listSkillPacks.mockResolvedValue([
      {
        id: 'fixture-biology',
        name: 'Fixture Biology',
        publisher: 'Fixture Lab',
        description: 'Biology skills discovered from the current source tree.',
        repositoryUrl: 'https://github.com/fixture-lab/biology-skills',
        delivery: 'dnaforge',
        provider: null,
        trust: 'community',
        repositoryLicense: 'MIT',
        licenseNotice: 'Models and datasets can carry separate license terms.',
      },
    ]);
    mocks.browseSkillPack.mockResolvedValue({
      ok: true,
      snapshot: {
        schemaVersion: 1,
        snapshotId: 'catalog-snapshot-1',
        packId: 'fixture-biology',
        revision: 'a'.repeat(40),
        capturedAt: 1,
        skills: [
          {
            id: 'skills/crispr-guide-audit',
            name: 'crispr-guide-audit',
            fileCount: 3,
            byteCount: 812,
            hasScripts: true,
          },
        ],
      },
    });
    mocks.reviewCatalogSkill.mockResolvedValue({
      ok: true,
      reviewToken: 'review-token-1',
      skill: {
        packId: 'fixture-biology',
        packName: 'Fixture Biology',
        publisher: 'Fixture Lab',
        repositoryUrl: 'https://github.com/fixture-lab/biology-skills',
        skillId: 'skills/crispr-guide-audit',
        name: 'crispr-guide-audit',
        description: 'Audit CRISPR guide candidates before ordering.',
        revision: 'a'.repeat(40),
        version: '1.4.0',
        license: 'MIT',
        additionalLicenses: [
          {
            key: 'model_license',
            label: 'Model license',
            value: 'CC-BY-NC-SA-4.0',
          },
        ],
        compatibility: 'Requires candidate guide sequences.',
        allowedTools: 'Read Bash(bowtie:*)',
        fileCount: 3,
        byteCount: 812,
        hasScripts: true,
        installable: true,
        installBlockReason: null,
        delivery: 'dnaforge',
        provider: null,
        document:
          '---\nname: crispr-guide-audit\ndescription: Audit CRISPR guide candidates before ordering.\n---\n\n# CRISPR guide audit\n\nCheck PAM compatibility and off-target risk.\n',
        files: [
          { path: 'SKILL.md', byteCount: 512 },
          { path: 'references/checklist.md', byteCount: 300 },
        ],
      },
    });
    mocks.installCatalogSkill.mockResolvedValue({ ok: true, skillId: 'catalog-skill-1' });
    mocks.removeSkill.mockResolvedValue({ ok: true });
    mocks.openDialog.mockResolvedValue(null);
  });

  it('separates installed and available skills with direct actions and no pagination', async () => {
    mocks.listManaged.mockResolvedValue({ commands: [], skills: [managedSkill], memory: [] });
    render(<AgentExtensionsPanel view="skills" preferredProvider="codex-sdk" />);

    const inventory = await screen.findByRole('list', { name: 'Skill inventory' });
    expect(within(inventory).getByText('primer-review')).toBeInTheDocument();
    expect(within(inventory).queryByText('crispr-guide-audit')).not.toBeInTheDocument();
    expect(
      within(inventory).getByRole('switch', { name: 'Turn off primer-review from DNAForge' })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Available skills' }));
    const availableInventory = await screen.findByRole('list', { name: 'Skill inventory' });
    expect(await within(availableInventory).findByText('crispr-guide-audit')).toBeInTheDocument();
    expect(
      within(availableInventory).getByRole('button', { name: 'Add crispr-guide-audit' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Installed' })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Skill host' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next skill page' })).not.toBeInTheDocument();
    expect(screen.queryByText(/You normally do not need/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Manage available skills' })
    ).not.toBeInTheDocument();
  });

  it('shows managed skills before slow CLI discovery and does not force a rescan on open', async () => {
    mocks.listManaged.mockResolvedValue({ commands: [], skills: [managedSkill], memory: [] });
    mocks.discover.mockImplementation(() => new Promise(() => {}));

    render(<AgentExtensionsPanel view="skills" />);

    expect(await screen.findByText('primer-review')).toBeInTheDocument();
    expect(mocks.discover).toHaveBeenCalledTimes(3);
    for (const [request] of mocks.discover.mock.calls) {
      expect(request).not.toHaveProperty('forceRefresh', true);
    }
  });

  it('shows the complete selected catalog skill and provenance beside the unified list', async () => {
    render(<AgentExtensionsPanel view="skills" preferredProvider="codex-sdk" />);

    fireEvent.click(screen.getByRole('button', { name: 'Available skills' }));
    const inventory = await screen.findByRole('list', { name: 'Skill inventory' });
    fireEvent.click(within(inventory).getByRole('button', { name: 'View crispr-guide-audit' }));

    const details = await screen.findByRole('region', { name: 'Skill details' });
    expect(within(details).getAllByText('Fixture Lab · Fixture Biology')).toHaveLength(2);
    expect(within(details).getByText(/# CRISPR guide audit/)).toBeVisible();
    expect(within(details).getByText(/Check PAM compatibility and off-target risk/)).toBeVisible();
    expect(within(details).getByText('references/checklist.md')).toBeVisible();
    expect(within(details).getByLabelText('Install skill for')).toHaveAttribute(
      'data-value',
      'codex-sdk'
    );
    expect(within(details).getByLabelText('Install skill availability')).toHaveAttribute(
      'data-value',
      'global'
    );
    expect(
      within(details).getByRole('button', { name: 'Install crispr-guide-audit' })
    ).toBeVisible();
  });

  it('adds a catalog skill directly from its inventory row', async () => {
    render(<AgentExtensionsPanel view="skills" preferredProvider="codex-sdk" />);

    fireEvent.click(screen.getByRole('button', { name: 'Available skills' }));
    const inventory = await screen.findByRole('list', { name: 'Skill inventory' });
    fireEvent.click(
      await within(inventory).findByRole('button', { name: 'Add crispr-guide-audit' })
    );

    await waitFor(() =>
      expect(mocks.installCatalogSkill).toHaveBeenCalledWith({
        reviewToken: 'review-token-1',
        provider: 'codex-sdk',
        scope: 'global',
        workspacePath: null,
      })
    );
  });

  it('puts the custom skill editor in the detail pane with explicit vertical labels', async () => {
    mocks.listManaged.mockResolvedValue({ commands: [], skills: [managedSkill], memory: [] });
    render(<AgentExtensionsPanel view="skills" preferredProvider="codex-sdk" />);

    fireEvent.click(await screen.findByRole('button', { name: 'New skill' }));

    const editor = screen.getByRole('region', { name: 'Skill editor' });
    expect(within(editor).getByLabelText('Name')).toBeInTheDocument();
    expect(within(editor).getByLabelText('Use when')).toBeInTheDocument();
    expect(within(editor).getByLabelText('Instructions')).toBeInTheDocument();
    expect(within(editor).getByLabelText('Available to')).toBeInTheDocument();
    expect(within(editor).getByLabelText('Scope')).toBeInTheDocument();
    expect(within(editor).getByRole('button', { name: 'Create skill' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Skill inventory' })).toBeInTheDocument();
  });

  it('keeps one focused skill manager without prompt shortcuts, saved context, or provider package catalogs', async () => {
    mocks.listManaged.mockResolvedValue({
      commands: [managedCommand],
      skills: [managedSkill],
      memory: [managedMemory],
    });

    render(<AgentExtensionsPanel view="overview" />);

    const skills = await screen.findByTestId('capability-skills');
    expect(within(skills).queryByRole('heading', { name: 'Skills' })).not.toBeInTheDocument();
    expect(within(skills).getByRole('list', { name: 'Skill inventory' })).toBeInTheDocument();
    expect(within(skills).getByText('1 installed · 1 enabled')).toBeInTheDocument();
    expect(within(skills).queryByText(/Agents load these workflows/i)).not.toBeInTheDocument();
    const skillToolbar = within(skills).getByTestId('skill-browser-toolbar');
    expect(
      within(skillToolbar).getByRole('button', { name: 'Installed skills' })
    ).toBeInTheDocument();
    expect(
      within(skillToolbar).getByRole('button', { name: 'Available skills' })
    ).toBeInTheDocument();
    expect(within(skillToolbar).getByRole('button', { name: 'New skill' })).toBeInTheDocument();
    expect(
      within(skillToolbar).getByRole('button', { name: 'Import skill folder' })
    ).toBeInTheDocument();
    expect(screen.queryByTestId('capability-prompt-shortcuts')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Prompt shortcuts' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New shortcut' })).not.toBeInTheDocument();
    expect(screen.queryByText('/review-primers')).not.toBeInTheDocument();
    expect(screen.queryByTestId('capability-saved-context')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Saved context' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New context' })).not.toBeInTheDocument();
    expect(screen.queryByText('Current organism')).not.toBeInTheDocument();

    expect(screen.queryByText('Agent extension library')).not.toBeInTheDocument();
    expect(screen.queryByText('CLI host coverage')).not.toBeInTheDocument();
    expect(screen.queryByText('Provider-managed CLI state')).not.toBeInTheDocument();
    expect(screen.queryByTestId('capability-provider-extensions')).not.toBeInTheDocument();
    expect(screen.queryByText('Provider extensions')).not.toBeInTheDocument();
    expect(screen.queryByText('Provider data')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('searchbox', { name: 'Search provider extensions' })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Manage skills/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Command' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Context' })).not.toBeInTheDocument();
  });

  it('creates one reusable skill for every agent runtime', async () => {
    render(<AgentExtensionsPanel view="overview" />);
    await screen.findByTestId('capability-skills');

    expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New skill' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'primer-review' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Use when' }), {
      target: { value: 'Review primer designs before ordering.' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Instructions' }), {
      target: { value: 'Check specificity, melting temperature, and product size.' },
    });
    fireEvent.click(screen.getByRole('combobox', { name: 'Scope' }));
    fireEvent.click(screen.getByRole('option', { name: 'This workspace' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create skill' }));

    await waitFor(() => expect(mocks.saveSkill).toHaveBeenCalledOnce());
    expect(mocks.saveSkill).toHaveBeenCalledWith({
      name: 'primer-review',
      description: 'Review primer designs before ordering.',
      instructions: 'Check specificity, melting temperature, and product size.',
      provider: 'all',
      scope: 'workspace',
      workspacePath: '/workspace',
      enabled: true,
    });
  });

  it('imports a complete skill folder through the native folder picker', async () => {
    mocks.openDialog.mockResolvedValue('/Users/test/my-skill');
    render(<AgentExtensionsPanel view="overview" />);
    await screen.findByTestId('capability-skills');

    fireEvent.click(screen.getByRole('button', { name: 'Import skill folder' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }));

    await waitFor(() => expect(mocks.importSkill).toHaveBeenCalledOnce());
    expect(mocks.openDialog).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: 'Import skill folder',
    });
    expect(mocks.importSkill).toHaveBeenCalledWith({
      sourcePath: '/Users/test/my-skill',
      provider: 'all',
      scope: 'global',
      workspacePath: null,
    });
  });

  it('searches the installed skill list and can disable a saved skill', async () => {
    mocks.listManaged.mockResolvedValue({ commands: [], skills: [managedSkill], memory: [] });
    render(<AgentExtensionsPanel view="skills" />);

    const inventory = await screen.findByRole('list', { name: 'Skill inventory' });
    expect(within(inventory).getByText('primer-review')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search skills' }), {
      target: { value: 'missing' },
    });
    expect(screen.queryByText('primer-review')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search skills' }), {
      target: { value: 'primer' },
    });
    const filteredInventory = screen.getByRole('list', { name: 'Skill inventory' });
    expect(within(filteredInventory).getByText('primer-review')).toBeInTheDocument();
    expect(within(filteredInventory).queryByText('crispr-guide-audit')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Turn off primer-review from DNAForge' }));

    await waitFor(() =>
      expect(mocks.setSkillEnabled).toHaveBeenCalledWith({ id: 'skill-1', enabled: false })
    );
  });

  it('keeps successful catalog sources available when another source fails', async () => {
    mocks.listSkillPacks.mockResolvedValue([
      {
        id: 'fixture-biology',
        name: 'Fixture Biology',
        publisher: 'Fixture Lab',
        description: 'Biology skills discovered from the current source tree.',
        repositoryUrl: 'https://github.com/fixture-lab/biology-skills',
        delivery: 'dnaforge',
        provider: null,
        trust: 'community',
        repositoryLicense: 'MIT',
        licenseNotice: 'Models and datasets can carry separate license terms.',
      },
      {
        id: 'unavailable-catalog',
        name: 'Unavailable Catalog',
        publisher: 'Offline Lab',
        description: 'A catalog that cannot currently be reached.',
        repositoryUrl: 'https://github.com/offline-lab/skills',
        delivery: 'dnaforge',
        provider: null,
        trust: 'community',
        repositoryLicense: 'MIT',
        licenseNotice: null,
      },
    ]);
    mocks.browseSkillPack.mockImplementation(async ({ packId }: { packId: string }) => {
      if (packId === 'unavailable-catalog') throw new Error('Catalog is temporarily unavailable.');
      return {
        ok: true,
        snapshot: {
          schemaVersion: 1,
          snapshotId: 'catalog-snapshot-1',
          packId: 'fixture-biology',
          revision: 'a'.repeat(40),
          capturedAt: 1,
          skills: [
            {
              id: 'skills/crispr-guide-audit',
              name: 'crispr-guide-audit',
              fileCount: 3,
              byteCount: 812,
              hasScripts: true,
            },
          ],
        },
      };
    });

    render(<AgentExtensionsPanel view="skills" />);

    fireEvent.click(screen.getByRole('button', { name: 'Available skills' }));
    const inventory = await screen.findByRole('list', { name: 'Skill inventory' });
    expect(
      await within(inventory).findByRole('button', { name: 'View crispr-guide-audit' })
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Some skill sources could not be loaded.');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Unavailable Catalog: Could not load this skill source.'
    );
  });

  it('does not silently re-enable a disabled skill when editing it', async () => {
    mocks.listManaged.mockResolvedValue({
      commands: [],
      skills: [{ ...managedSkill, enabled: false }],
      memory: [],
    });
    render(<AgentExtensionsPanel view="skills" />);

    const inventory = await screen.findByRole('list', { name: 'Skill inventory' });
    fireEvent.click(within(inventory).getByRole('button', { name: 'View primer-review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit skill primer-review' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Use when' }), {
      target: { value: 'Updated while disabled.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save skill' }));

    await waitFor(() => expect(mocks.saveSkill).toHaveBeenCalledOnce());
    expect(mocks.saveSkill).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'skill-1', enabled: false })
    );
  });

  it('requires explicit confirmation before removing a saved skill', async () => {
    mocks.listManaged.mockResolvedValue({ commands: [], skills: [managedSkill], memory: [] });
    render(<AgentExtensionsPanel view="skills" />);

    const inventory = await screen.findByRole('list', { name: 'Skill inventory' });
    fireEvent.click(within(inventory).getByRole('button', { name: 'View primer-review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove skill primer-review' }));
    expect(mocks.removeSkill).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm remove skill primer-review' }));

    await waitFor(() => expect(mocks.removeSkill).toHaveBeenCalledWith({ id: 'skill-1' }));
  });

  it('keeps the ordinary skill journey to Installed and Available', async () => {
    render(<AgentExtensionsPanel view="skills" />);
    await screen.findByRole('button', { name: 'Available skills' });

    expect(screen.getByRole('button', { name: 'Installed skills' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.queryByRole('button', { name: 'CLI skills' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Available skills' })).toBeInTheDocument();
    expect(screen.queryByText(/ask normally/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Turn a skill on or off/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Available skills' }));
    const inventory = await screen.findByRole('list', { name: 'Skill inventory' });
    expect(await within(inventory).findByText('crispr-guide-audit')).toBeInTheDocument();
    expect(within(inventory).getByText(/Fixture Lab · Fixture Biology/)).toBeInTheDocument();
    expect(screen.queryByText('Genomics tools')).not.toBeInTheDocument();
  });

  it('toggles a runtime-owned skill from the same Installed list', async () => {
    const nativeSkill = {
      ...plugin,
      id: 'codex-sdk:skill:sequence-audit',
      nativeId: 'sequence-audit',
      kind: 'skill' as const,
      label: 'sequence-audit',
      description: 'Audit a biological sequence.',
      source: '/Users/test/.codex/skills/sequence-audit/SKILL.md',
      availability: { state: 'supported' as const },
      stages: { ...plugin.stages, invocable: true },
      dnaforgePolicy: { enabled: true, scope: 'installation' as const },
    };
    mocks.discover.mockImplementation(async (request: { provider: string }) => ({
      schemaVersion: 1,
      snapshotId: `snapshot-${request.provider}`,
      provider: request.provider,
      providerVersion: '1',
      accountFingerprint: 'account-a',
      workspaceFingerprint: 'workspace-a',
      capturedAt: 1,
      controls: request.provider === 'codex-sdk' ? [nativeSkill] : [],
    }));

    render(<AgentExtensionsPanel view="skills" preferredProvider="codex-sdk" />);
    const inventory = await screen.findByRole('list', { name: 'Skill inventory' });
    expect(within(inventory).getByText('sequence-audit')).toBeInTheDocument();
    fireEvent.click(within(inventory).getByRole('button', { name: 'View sequence-audit' }));

    fireEvent.click(screen.getByRole('combobox', { name: 'Native skill setting scope' }));
    fireEvent.click(screen.getByRole('option', { name: 'This workspace' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Turn off sequence-audit from Codex' }));

    await waitFor(() =>
      expect(mocks.setProviderSkillEnabled).toHaveBeenCalledWith({
        selection: {
          snapshotId: 'snapshot-codex-sdk',
          provider: 'codex-sdk',
          capabilityId: nativeSkill.id,
        },
        enabled: false,
        scope: 'workspace',
        workspacePath: '/workspace',
      })
    );
  });

  it('keeps provider-owned skills inside a focused source and details manager', async () => {
    const codexSkill = {
      ...plugin,
      id: 'codex-sdk:skill:sequence-audit',
      nativeId: 'sequence-audit',
      kind: 'skill' as const,
      label: 'sequence-audit',
      description: 'Audit a biological sequence with Codex.',
      source: '/Users/test/.codex/skills/sequence-audit/SKILL.md',
      availability: { state: 'supported' as const },
      stages: { ...plugin.stages, invocable: true },
      dnaforgePolicy: { enabled: true, scope: 'installation' as const },
    };
    const claudeSkill = {
      ...codexSkill,
      id: 'claude-agent-sdk:skill:sequence-audit',
      provider: 'claude-agent-sdk' as const,
      description: 'Audit a biological sequence with Claude Code.',
      source: '/Users/test/.claude/skills/sequence-audit/SKILL.md',
    };
    mocks.discover.mockImplementation(async (request: { provider: string }) => ({
      schemaVersion: 1,
      snapshotId: `snapshot-${request.provider}`,
      provider: request.provider,
      providerVersion: '1',
      accountFingerprint: 'account-a',
      workspaceFingerprint: 'workspace-a',
      capturedAt: 1,
      controls:
        request.provider === 'codex-sdk'
          ? [codexSkill]
          : request.provider === 'claude-agent-sdk'
            ? [claudeSkill]
            : [],
    }));

    render(<AgentExtensionsPanel view="skills" preferredProvider="codex-sdk" />);

    expect(await screen.findByRole('heading', { name: 'Skills' })).toBeInTheDocument();
    const inventory = await screen.findByRole('list', { name: 'Skill inventory' });
    expect(within(inventory).getAllByRole('button', { name: 'View sequence-audit' })).toHaveLength(
      2
    );
    expect(within(inventory).getByText('Codex')).toBeInTheDocument();
    expect(within(inventory).getByText('Claude Code')).toBeInTheDocument();
    expect(within(inventory).getAllByRole('switch')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'New skill' }));
    expect(screen.getByRole('combobox', { name: 'Available to' })).toHaveAttribute(
      'data-value',
      'codex-sdk'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(within(inventory).getAllByRole('button', { name: 'View sequence-audit' })[1]!);

    fireEvent.click(screen.getByRole('combobox', { name: 'Native skill setting scope' }));
    fireEvent.click(screen.getByRole('option', { name: 'This workspace' }));
    fireEvent.click(
      screen.getByRole('switch', { name: 'Turn off sequence-audit from Claude Code' })
    );

    await waitFor(() =>
      expect(mocks.setProviderSkillEnabled).toHaveBeenCalledWith({
        selection: {
          snapshotId: 'snapshot-claude-agent-sdk',
          provider: 'claude-agent-sdk',
          capabilityId: claudeSkill.id,
        },
        enabled: false,
        scope: 'workspace',
        workspacePath: '/workspace',
      })
    );
  });

  it('keeps two installed copies of one catalog skill separate by host', async () => {
    const source = {
      packId: 'fixture-biology',
      packName: 'Fixture Biology',
      publisher: 'Fixture Lab',
      repositoryUrl: 'https://github.com/fixture-lab/biology-skills',
      skillPath: 'skills/crispr-guide-audit',
      revision: 'a'.repeat(40),
      version: '1.4.0',
      license: 'MIT',
      additionalLicenses: [],
      compatibility: null,
    };
    mocks.listManaged.mockResolvedValue({
      commands: [],
      memory: [],
      skills: [
        {
          ...managedSkill,
          id: 'catalog-codex',
          name: 'crispr-guide-audit',
          provider: 'codex-sdk',
          scope: 'global',
          workspacePath: null,
          origin: 'catalog',
          source,
        },
        {
          ...managedSkill,
          id: 'catalog-claude',
          name: 'crispr-guide-audit',
          provider: 'claude-agent-sdk',
          scope: 'global',
          workspacePath: null,
          origin: 'catalog',
          source,
        },
      ],
    });

    render(<AgentExtensionsPanel view="skills" />);
    const inventory = await screen.findByRole('list', { name: 'Skill inventory' });
    expect(
      within(inventory).getAllByRole('button', { name: 'View crispr-guide-audit' })
    ).toHaveLength(2);
    expect(
      within(inventory).getByRole('switch', {
        name: 'Turn off crispr-guide-audit from Codex',
      })
    ).toBeInTheDocument();
    expect(
      within(inventory).getByRole('switch', {
        name: 'Turn off crispr-guide-audit from Claude Code',
      })
    ).toBeInTheDocument();
  });

  it('can remove a workspace CLI-skill override and inherit the everywhere setting', async () => {
    const nativeSkill = {
      ...plugin,
      id: 'codex-sdk:skill:sequence-audit',
      nativeId: 'sequence-audit',
      kind: 'skill' as const,
      label: 'sequence-audit',
      description: 'Audit a biological sequence.',
      source: '/Users/test/.codex/skills/sequence-audit/SKILL.md',
      availability: {
        state: 'disabled-by-policy' as const,
        reason: 'Disabled for this workspace in DNAForge.',
      },
      stages: { ...plugin.stages, invocable: false },
      dnaforgePolicy: { enabled: false, scope: 'workspace' as const },
    };
    mocks.discover.mockImplementation(async (request: { provider: string }) => ({
      schemaVersion: 1,
      snapshotId: `snapshot-${request.provider}`,
      provider: request.provider,
      providerVersion: '1',
      accountFingerprint: 'account-a',
      workspaceFingerprint: 'workspace-a',
      capturedAt: 1,
      controls: request.provider === 'codex-sdk' ? [nativeSkill] : [],
    }));

    render(<AgentExtensionsPanel view="skills" preferredProvider="codex-sdk" />);
    const inventory = await screen.findByRole('list', { name: 'Skill inventory' });
    fireEvent.click(within(inventory).getByRole('button', { name: 'View sequence-audit' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Use everywhere setting for sequence-audit' })
    );

    await waitFor(() =>
      expect(mocks.setProviderSkillEnabled).toHaveBeenCalledWith({
        selection: {
          snapshotId: 'snapshot-codex-sdk',
          provider: 'codex-sdk',
          capabilityId: nativeSkill.id,
        },
        inheritGlobal: true,
        scope: 'workspace',
        workspacePath: '/workspace',
      })
    );
  });

  it('reviews an immutable catalog skill before a separate confirmed install', async () => {
    render(<AgentExtensionsPanel view="skills" />);
    fireEvent.click(screen.getByRole('button', { name: 'Available skills' }));

    const catalogList = await screen.findByRole('list', { name: 'Skill inventory' });
    expect(within(catalogList).getByText('crispr-guide-audit')).toBeInTheDocument();
    expect(within(catalogList).getByText(/3 files · Includes scripts/)).toBeInTheDocument();
    expect(mocks.installCatalogSkill).not.toHaveBeenCalled();

    fireEvent.click(within(catalogList).getByRole('button', { name: 'View crispr-guide-audit' }));
    const details = await screen.findByRole('region', { name: 'Skill details' });
    expect(within(details).getByText('1.4.0')).toBeInTheDocument();
    expect(within(details).getByText('CC-BY-NC-SA-4.0')).toBeInTheDocument();
    expect(within(details).getByText('aaaaaaaaaaaa')).toBeInTheDocument();
    expect(within(details).getByText('Read Bash(bowtie:*)')).toBeInTheDocument();
    expect(mocks.installCatalogSkill).not.toHaveBeenCalled();

    fireEvent.click(within(details).getByRole('button', { name: 'Install crispr-guide-audit' }));
    await waitFor(() =>
      expect(mocks.installCatalogSkill).toHaveBeenCalledWith({
        reviewToken: 'review-token-1',
        provider: 'all',
        scope: 'global',
        workspacePath: null,
      })
    );
  });

  it('labels a newer catalog revision as an update to the existing app-owned copy', async () => {
    mocks.listManaged.mockResolvedValue({
      commands: [],
      memory: [],
      skills: [
        {
          ...managedSkill,
          id: 'catalog-skill-1',
          name: 'crispr-guide-audit',
          scope: 'global',
          workspacePath: null,
          origin: 'catalog',
          source: {
            packId: 'fixture-biology',
            packName: 'Fixture Biology',
            publisher: 'Fixture Lab',
            repositoryUrl: 'https://github.com/fixture-lab/biology-skills',
            skillPath: 'skills/crispr-guide-audit',
            revision: 'b'.repeat(40),
            version: '1.3.0',
            license: 'MIT',
            additionalLicenses: [],
            compatibility: null,
          },
          contentDigest: 'c'.repeat(64),
        },
      ],
    });

    render(<AgentExtensionsPanel view="skills" />);
    const inventory = await screen.findByRole('list', { name: 'Skill inventory' });
    fireEvent.click(within(inventory).getByRole('button', { name: 'View crispr-guide-audit' }));

    const updateButton = await screen.findByRole('button', {
      name: 'Update crispr-guide-audit',
    });
    expect(updateButton).toHaveTextContent('Update skill');
    expect(screen.getByText(/Installed revision b{12} will be replaced/)).toBeInTheDocument();
  });

  it('shows a long CLI skill list continuously and search narrows it without pagination', async () => {
    const count = 9;
    const skills = Array.from({ length: count }, (_, index) => ({
      ...plugin,
      id: `codex-sdk:skill:skill-${index}`,
      nativeId: `skill-${index}`,
      kind: 'skill' as const,
      label: `skill-${index}`,
      description: `Description ${index}`,
      source: `/Users/test/.codex/skills/skill-${index}/SKILL.md`,
      availability: { state: 'supported' as const },
      stages: { ...plugin.stages, invocable: true },
      dnaforgePolicy: { enabled: true, scope: 'installation' as const },
    }));
    mocks.discover.mockImplementation(async (request: { provider: string }) => ({
      schemaVersion: 1,
      snapshotId: `snapshot-${request.provider}`,
      provider: request.provider,
      providerVersion: '1',
      accountFingerprint: 'account-a',
      workspaceFingerprint: 'workspace-a',
      capturedAt: 1,
      controls: request.provider === 'codex-sdk' ? skills : [],
    }));

    render(<AgentExtensionsPanel view="skills" preferredProvider="codex-sdk" />);
    const inventory = await screen.findByRole('list', { name: 'Skill inventory' });
    expect(screen.getByTestId('agent-skill-manager-page')).toHaveClass(
      'flex',
      'h-full',
      'min-h-0',
      'overflow-hidden'
    );
    expect(screen.getByTestId('skill-browser')).toHaveClass('flex', 'min-h-0', 'flex-1');
    expect(screen.getByTestId('skill-browser-controls')).not.toHaveClass('overflow-y-auto');
    expect(screen.getByTestId('skill-inventory-scroll')).toHaveClass(
      'min-h-0',
      'flex-1',
      'overflow-y-auto'
    );
    expect(screen.getByTestId('skill-details-column')).toHaveClass(
      'min-h-0',
      'overflow-y-auto',
      'overscroll-contain'
    );
    expect(screen.getByRole('button', { name: 'Installed skills' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByText('9 installed · 9 enabled')).toBeInTheDocument();
    expect(within(inventory).getAllByRole('listitem')).toHaveLength(9);
    expect(within(inventory).getByText('skill-0')).toBeInTheDocument();
    expect(within(inventory).getByText('Description 0')).toBeInTheDocument();
    expect(within(inventory).getByText('skill-8')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next skill page' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Available skills' }));
    expect(within(inventory).getByText('crispr-guide-audit')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Installed skills' }));

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search skills' }), {
      target: { value: 'skill-3' },
    });
    expect(within(inventory).getByText('skill-3')).toBeInTheDocument();
    expect(within(inventory).queryByText('skill-8')).not.toBeInTheDocument();
    expect(within(inventory).getAllByRole('listitem')).toHaveLength(1);
  });
});
