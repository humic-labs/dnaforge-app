import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, useState } from 'react';
import {
  createEntityReference,
  getEntityReference,
  getEntityReferenceByLocator,
  getEntityReferencesByIds,
} from '../../../../db/entity-references';
import {
  listMolecularPromptTrialVersionsForSavedView,
  MOLECULAR_PROMPT_TRIAL_CHANGE_EVENT,
  type MolecularPromptTrialSiblingStructure,
  type MolecularPromptTrialVersion,
} from '../../../../db/molecular-prompt-trials';
import { useCanvasStore } from '../../../canvas/public/store';
import {
  molecularViewAttrs,
  molecularViewFromReferenceData,
  coordinateDigest,
  validateMolecularViewCoordinates,
} from '../structure3d/utils/molecularView';
import { createMolecularComparison } from '../structure3d/utils/molecularComparison';

export const PROTEIN_RUN_STRUCTURE_NAVIGATED_EVENT = 'dnaforge:protein-run-structure-navigated';

export async function applyProteinComparisonToTab(
  panelId: string,
  tabId: string,
  expectedSavedViewId: string,
  structures: readonly MolecularPromptTrialSiblingStructure[]
): Promise<string> {
  if (structures.length < 2 || !structures.some((item) => item.savedViewId === expectedSavedViewId))
    throw new Error('This run has no multi-structure comparison.');
  const canvas = useCanvasStore.getState();
  const current = canvas.panels[panelId]?.tabs.find((tab) => tab.id === tabId);
  if (!current || current.entityId !== expectedSavedViewId)
    throw new Error('The structure tab changed before the comparison could open.');
  const { reference, comparison, savedViewId } =
    await getOrCreateProteinComparisonReference(structures);
  const latest = useCanvasStore.getState().panels[panelId]?.tabs.find((tab) => tab.id === tabId);
  if (!latest || latest.entityId !== expectedSavedViewId)
    throw new Error('The structure tab changed before the comparison could open.');
  useCanvasStore.getState().updateTab(panelId, tabId, {
    entityId: savedViewId,
    label: comparison.title,
    initialStructureAttrs: molecularViewAttrs(savedViewId, comparison),
    viewState: undefined,
    pendingViewState: undefined,
  });
  return reference.id;
}

export async function getOrCreateProteinComparisonReference(
  structures: readonly MolecularPromptTrialSiblingStructure[]
) {
  if (structures.length < 2) throw new Error('This run has no multi-structure comparison.');
  const references = await getEntityReferencesByIds(structures.map((item) => item.referenceId));
  const byId = new Map(references.map((reference) => [reference.id, reference]));
  const sources = structures.map((item) => {
    const reference = byId.get(item.referenceId);
    const view =
      reference?.entity_type === 'structure'
        ? molecularViewFromReferenceData(reference.data)
        : null;
    if (
      !reference ||
      reference.locator !== `entity://structure/${item.savedViewId}` ||
      !view ||
      view.coordinates.sha256 !== item.coordinateSha256
    )
      throw new Error('A recorded structure does not match its pinned coordinates.');
    return { referenceId: reference.id, view };
  });
  const key = await coordinateDigest(
    structures.map((item) => `${item.referenceId}:${item.coordinateSha256}`).join('|')
  );
  const savedViewId = `saved-view:comparison:${key.slice(0, 32)}`;
  const locator = `entity://structure/${savedViewId}`;
  let reference = await getEntityReferenceByLocator(locator);
  let comparison = reference ? molecularViewFromReferenceData(reference.data) : null;
  if (reference && (!comparison || comparison.version !== 2))
    throw new Error('The saved comparison is invalid.');
  if (!reference) {
    comparison = await createMolecularComparison(
      `Comparison · ${structures.map((item) => item.label).join(' / ')}`.slice(0, 200),
      sources
    );
    reference = await createEntityReference({
      entityType: 'structure',
      displayLabel: comparison.title,
      locator,
      deepLinkParams: null,
      data: comparison,
      source: 'dnaforge-dev-protein-comparison',
      workspaceScope: null,
      workspaceRootPath: null,
    });
  }
  if (!comparison || comparison.version !== 2) throw new Error('The saved comparison is invalid.');
  if (
    comparison.primarySourceReferenceId !== sources[0].referenceId ||
    comparison.coordinates.sha256 !== sources[0].view.coordinates.sha256 ||
    comparison.pinnedAssets.length !== sources.length - 1 ||
    comparison.pinnedAssets.some(
      (asset, index) =>
        asset.sourceReferenceId !== sources[index + 1]?.referenceId ||
        asset.sha256 !== sources[index + 1]?.view.coordinates.sha256
    )
  )
    throw new Error('The saved comparison does not match the recorded run.');
  await validateMolecularViewCoordinates(comparison);
  return { reference, comparison, savedViewId };
}

export async function applyProteinRunVersionToTab(
  panelId: string,
  tabId: string,
  expectedSavedViewId: string,
  version: MolecularPromptTrialVersion
): Promise<void> {
  const reference = await getEntityReference(version.referenceId);
  if (
    reference?.entity_type !== 'structure' ||
    reference.locator !== `entity://structure/${version.savedViewId}`
  )
    throw new Error('This recorded structure view is missing.');
  const view = molecularViewFromReferenceData(reference.data);
  if (!view || view.coordinates.sha256 !== version.coordinateSha256)
    throw new Error('This recorded structure view does not match the pinned coordinates.');
  await applyProteinSavedViewReferenceToTab(panelId, tabId, expectedSavedViewId, reference);
}

export async function applyProteinSavedViewReferenceToTab(
  panelId: string,
  tabId: string,
  expectedSavedViewId: string,
  reference: NonNullable<Awaited<ReturnType<typeof getEntityReference>>>,
  expectedCoordinateSha256?: string
): Promise<void> {
  const view = molecularViewFromReferenceData(reference.data);
  const prefix = 'entity://structure/';
  const savedViewId = reference.locator?.startsWith(prefix)
    ? reference.locator.slice(prefix.length)
    : null;
  if (reference.entity_type !== 'structure' || !view || !savedViewId?.startsWith('saved-view:'))
    throw new Error('This recorded structure view is missing or invalid.');
  if (expectedCoordinateSha256 && view.coordinates.sha256 !== expectedCoordinateSha256)
    throw new Error('This recorded structure view does not match the pinned coordinates.');
  await validateMolecularViewCoordinates(view);

  const canvas = useCanvasStore.getState();
  const current = canvas.panels[panelId]?.tabs.find((tab) => tab.id === tabId);
  if (!current || current.entityId !== expectedSavedViewId)
    throw new Error('The structure tab changed before the version could open.');
  canvas.updateTab(panelId, tabId, {
    entityId: savedViewId,
    label: view.title,
    initialStructureAttrs: molecularViewAttrs(savedViewId, view),
    viewState: undefined,
    pendingViewState: undefined,
  });
}

export function ProteinRunVersionSwitcher({
  panelId,
  tabId,
  savedViewId,
  isActive,
}: {
  panelId: string;
  tabId: string;
  savedViewId: string;
  isActive: boolean;
}) {
  const [versions, setVersions] = useState<MolecularPromptTrialVersion[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isActive || !savedViewId.startsWith('saved-view:')) return;
    let cancelled = false;
    const refresh = () => {
      void listMolecularPromptTrialVersionsForSavedView(savedViewId).then(
        (next) => {
          if (!cancelled) setVersions(next);
        },
        () => {
          if (!cancelled) setVersions([]);
        }
      );
    };
    refresh();
    window.addEventListener(MOLECULAR_PROMPT_TRIAL_CHANGE_EVENT, refresh);
    return () => {
      cancelled = true;
      window.removeEventListener(MOLECULAR_PROMPT_TRIAL_CHANGE_EVENT, refresh);
    };
  }, [isActive, savedViewId]);

  if (versions.length < 2 || !versions.some((version) => version.savedViewId === savedViewId))
    return null;
  const labelCounts = new Map<string, number>();
  for (const version of versions)
    labelCounts.set(version.label, (labelCounts.get(version.label) ?? 0) + 1);

  return (
    <div className="flex items-center gap-2">
      <select
        aria-label="Saved run version"
        data-testid="protein-run-version-select"
        title="Compare saved versions of this structure view"
        value={savedViewId}
        disabled={busy}
        className="max-w-52 rounded border border-border bg-bg px-2 py-1 text-xs text-fg"
        onChange={(event) => {
          const next = versions.find((version) => version.savedViewId === event.target.value);
          if (!next || next.savedViewId === savedViewId) return;
          setBusy(true);
          setError(null);
          void applyProteinRunVersionToTab(panelId, tabId, savedViewId, next)
            .catch((cause: unknown) =>
              setError(toUserMessage(cause, 'failure.the-saved-version-could-not-open'))
            )
            .finally(() => setBusy(false));
        }}
      >
        {versions.map((version) => (
          <option key={version.resultId} value={version.savedViewId}>
            {version.label}
            {(labelCounts.get(version.label) ?? 0) > 1
              ? ` · ${new Date(version.recordedAt).toLocaleString()}`
              : ''}
          </option>
        ))}
      </select>
      {error && (
        <span role="alert" className="max-w-52 text-xs text-error">
          {toUserMessage(error, 'structure.failed')}
        </span>
      )}
    </div>
  );
}
