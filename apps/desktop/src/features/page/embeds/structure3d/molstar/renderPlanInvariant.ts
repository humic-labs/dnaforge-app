import { polymerRenderRoleForComponentLabel, type PolymerRenderRole } from './renderPlan';
import {
  detailChainIdFromComponentLabel,
  detailContextChainIdFromComponentLabel,
} from './componentLabels';
import {
  getStructureChainInventoryDiagnostics,
  getStructureRepresentationDiagnostics,
  type StructureRepresentationDiagnostic,
} from './cache';
import { SURFACE_OVERLAY_TAG } from './surfaceOverlay';
import type { MolstarRenderPlan } from './molstarRenderPlan';
import type { StructureRenderTransaction } from '../utils/structureRenderTransaction';
import { STRUCTURE_CONTEXT_MOLSTAR_COLOR } from '../utils/structureRenderModel';

type RenderPlanPhase = 'before-reveal' | 'after-ready';

const POLYMER_ROLES = new Set<PolymerRenderRole>(['query', 'focus', 'context', 'unscoped']);

function isPolymerRole(role: string): role is PolymerRenderRole {
  return POLYMER_ROLES.has(role as PolymerRenderRole);
}

export const LARGE_COMPLEX_INVARIANT_WARN_CHAIN_COUNT = 24;

export class StructureRenderPlanViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StructureRenderPlanViolationError';
  }
}

export interface StructureRenderPlanViolation {
  code:
    | 'unexpected-visible-unscoped-polymer'
    | 'missing-visible-polymer'
    | 'missing-visible-context-polymer'
    | 'missing-visible-surface-layer'
    | 'visible-detail-chain-mismatch'
    | 'selected-chain-leaked-into-context'
    | 'visible-context-chain-color-mismatch';
  message: string;
  expectedVisiblePolymerRoles: string[];
  expectedVisibleNonSurfacePolymerRoles: string[];
  expectedVisibleSurfacePolymerRoles: string[];
  visiblePolymerCount: number;
  visibleUnscopedPolymerCount: number;
  visibleUnscopedNonSurfacePolymerCount: number;
  visibleContextPolymerCount: number;
  visibleContextNonSurfacePolymerCount: number;
  visibleContextSurfacePolymerCount: number;
  visibleSurfacePolymerCount: number;
  visibleNonPolymerCount: number;
  contextRowCount: number;
  componentLabels: string[];
  contextComponentSummaries: StructureComponentSummary[];
  mismatchedDetailChains?: DetailChainMismatch[];
  contextChainLeaks?: ContextChainLeak[];
  mismatchedContextComponents?: ContextColorMismatch[];
}

interface StructureComponentSummary {
  label: string | null;
  representations: Array<{
    typeName: string | null;
    alpha: number | null;
    colorThemeName: string | null;
  }>;
}

interface DetailChainMismatch {
  chainInstanceId: string;
  label: string;
  expectedColorMode: string;
  expectedMolstarColor: number | null;
  actualElementCount: number | null;
  actualVisible: boolean;
  actualTypeName: string | null;
  actualColorThemeName: string | null;
  actualColorThemeParams?: Record<string, unknown>;
  actualMolstarColor: number | null;
}

interface ContextColorMismatch {
  label: string;
  typeName: string | null;
  alpha: number | null;
  actualColorThemeName: string | null;
  actualMolstarColor: number | null;
}

interface ContextChainLeak {
  chainInstanceId: string;
  displayChainId: string;
  label: string;
  matchedChains: StructureRepresentationDiagnostic['components'][number]['chains'];
}

export function findStructureRenderPlanViolation(input: {
  transaction: StructureRenderTransaction;
  diagnostic: StructureRepresentationDiagnostic;
  molstarPlan?: Pick<MolstarRenderPlan, 'defaults' | 'rolePlan'>;
  expectsDetailChainComponents?: boolean;
}): StructureRenderPlanViolation | null {
  const expectedVisiblePolymerRoles = input.transaction.molstar.representations
    .filter((representation) => representation.visible && isPolymerRole(representation.role))
    .map((representation) => representation.role);
  const expectedVisibleNonSurfacePolymerRoles = input.transaction.molstar.representations
    .filter(
      (representation) =>
        representation.visible &&
        representation.kind !== 'surface' &&
        isPolymerRole(representation.role)
    )
    .map((representation) => representation.role);
  const expectedVisibleSurfacePolymerRoles = input.transaction.molstar.representations
    .filter(
      (representation) =>
        representation.visible &&
        representation.kind === 'surface' &&
        isPolymerRole(representation.role)
    )
    .map((representation) => representation.role);

  if (expectedVisiblePolymerRoles.length === 0) return null;
  if (input.diagnostic.isLoading || input.diagnostic.error) return null;
  if (input.diagnostic.structureCount === 0 || input.diagnostic.representationCount === 0) {
    return null;
  }

  const visiblePolymerCount = visibleRepresentationCount(input.diagnostic, 'polymer');
  const visibleUnscopedPolymerCount = visiblePolymerRoleRepresentationCount(
    input.diagnostic,
    'unscoped'
  );
  const visibleUnscopedNonSurfacePolymerCount = visiblePolymerRoleRepresentationCount(
    input.diagnostic,
    'unscoped',
    undefined,
    { surface: false }
  );
  const contextChainInstanceIds = new Set(
    input.transaction.table.rows
      .filter((row) => !row.detailVisible)
      .map((row) => row.chainInstanceId as string)
  );
  const visibleContextPolymerCount = visiblePolymerRoleRepresentationCount(
    input.diagnostic,
    'context',
    contextChainInstanceIds
  );
  const visibleContextNonSurfacePolymerCount = visiblePolymerRoleRepresentationCount(
    input.diagnostic,
    'context',
    contextChainInstanceIds,
    { surface: false }
  );
  const visibleContextSurfacePolymerCount = visiblePolymerRoleRepresentationCount(
    input.diagnostic,
    'context',
    contextChainInstanceIds,
    { surface: true }
  );
  const visibleSurfacePolymerCount = visibleRepresentationCount(input.diagnostic, 'polymer', {
    surface: true,
  });
  const visibleNonPolymerCount = visibleRepresentationCount(input.diagnostic, 'non-polymer');
  const resolvedTableRows =
    input.transaction.chainCatalogStatus === 'resolved' ? input.transaction.table.rows : [];
  const contextRowCount = resolvedTableRows.filter((row) => !row.detailVisible).length;
  const expectsScopedPolymerComponents =
    input.expectsDetailChainComponents === true || contextRowCount > 0;
  const baseViolationFields = {
    expectedVisiblePolymerRoles,
    expectedVisibleNonSurfacePolymerRoles,
    expectedVisibleSurfacePolymerRoles,
    visiblePolymerCount,
    visibleUnscopedPolymerCount,
    visibleUnscopedNonSurfacePolymerCount,
    visibleContextPolymerCount,
    visibleContextNonSurfacePolymerCount,
    visibleContextSurfacePolymerCount,
    visibleSurfacePolymerCount,
    visibleNonPolymerCount,
    contextRowCount,
    componentLabels: input.diagnostic.componentLabels,
    contextComponentSummaries: polymerRoleComponentSummaries(input.diagnostic, 'context'),
  };

  const mismatchedDetailChains = input.expectsDetailChainComponents
    ? detailChainMismatches(input.transaction, input.diagnostic, input.molstarPlan)
    : [];
  if (mismatchedDetailChains.length > 0) {
    return {
      code: 'visible-detail-chain-mismatch',
      message: `Structure render plan expected ${mismatchedDetailChains.length} visible detail chain representation(s) to match the transaction color mode, but MolStar differed.`,
      ...baseViolationFields,
      mismatchedDetailChains,
    };
  }

  const contextChainLeaks =
    contextRowCount > 0 ? selectedChainContextLeaks(input.transaction, input.diagnostic) : [];
  if (contextChainLeaks.length > 0) {
    return {
      code: 'selected-chain-leaked-into-context',
      message: `Structure render plan expected selected detail chain(s) to be absent from gray context, but ${contextChainLeaks.length} selected chain(s) were still present in visible context components.`,
      ...baseViolationFields,
      contextChainLeaks,
    };
  }

  const expectedContextSurface =
    contextRowCount > 0 && expectedVisibleSurfacePolymerRoles.includes('context');
  const expectedContextNonSurface =
    contextRowCount > 0 && expectedVisibleNonSurfacePolymerRoles.includes('context');
  const mismatchedContextComponents = contextColorMismatches(
    input.diagnostic,
    expectedContextSurface || expectedContextNonSurface
  );
  if (mismatchedContextComponents.length > 0) {
    return {
      code: 'visible-context-chain-color-mismatch',
      message: `Structure render plan expected context polymer representations to stay gray, but ${mismatchedContextComponents.length} visible context representation(s) had non-gray colors.`,
      ...baseViolationFields,
      mismatchedContextComponents,
    };
  }

  if (expectedContextSurface && visibleContextSurfacePolymerCount === 0) {
    return {
      code: 'missing-visible-surface-layer',
      message: `Structure render plan expected a visible context surface layer for ${contextRowCount} context chain row(s), but MolStar has zero visible context surface representations.`,
      ...baseViolationFields,
    };
  }

  if (
    expectsScopedPolymerComponents &&
    expectedVisibleNonSurfacePolymerRoles.includes('context') &&
    visibleUnscopedNonSurfacePolymerCount > 0
  ) {
    return {
      code: 'unexpected-visible-unscoped-polymer',
      message: `Structure render plan expected scoped context/query polymers, but MolStar has ${visibleUnscopedPolymerCount} visible broad unscoped polymer representation(s).`,
      ...baseViolationFields,
    };
  }

  if (
    contextRowCount > 0 &&
    expectedVisibleNonSurfacePolymerRoles.includes('context') &&
    visibleContextNonSurfacePolymerCount === 0
  ) {
    return {
      code: 'missing-visible-context-polymer',
      message: `Structure render plan expected ${contextRowCount} context chain row(s), but MolStar has zero visible context polymer representations.`,
      ...baseViolationFields,
    };
  }

  if (visiblePolymerCount > 0) return null;

  return {
    code: 'missing-visible-polymer',
    message: `Structure render plan expected visible polymer roles (${[
      ...new Set(expectedVisiblePolymerRoles),
    ].join(', ')}) but MolStar has zero visible polymer representations.`,
    ...baseViolationFields,
  };
}

export function assertStructureRenderPlanSatisfiedForViewer(input: {
  viewerCacheKey: string;
  transaction: StructureRenderTransaction;
  molstarPlan?: Pick<MolstarRenderPlan, 'defaults' | 'rolePlan'>;
  phase: RenderPlanPhase;
  detailChainTargets?: unknown;
}): void {
  const diagnostic = getStructureRepresentationDiagnostics(input.viewerCacheKey)[0];
  if (!diagnostic) return;
  const inspectableDiagnostic =
    input.phase === 'before-reveal' ? { ...diagnostic, isLoading: false } : diagnostic;
  const violation = findStructureRenderPlanViolation({
    transaction: input.transaction,
    diagnostic: inspectableDiagnostic,
    molstarPlan: input.molstarPlan,
    expectsDetailChainComponents:
      Array.isArray(input.detailChainTargets) && input.detailChainTargets.length > 0,
  });
  if (!violation) return;

  const violationPayload = {
    viewerCacheKey: input.viewerCacheKey,
    planHash: input.transaction.planHash,
    activeRecipeId: input.transaction.activeRecipeId,
    renderIntent: input.transaction.renderIntent,
    molstarPlanDefaults: input.molstarPlan?.defaults,
    molstarPlanQueryOverride: input.molstarPlan?.rolePlan.polymerOverrides.query,
    molstarPlanContextOverride: input.molstarPlan?.rolePlan.polymerOverrides.context,
    molstarPlanVisibility: input.molstarPlan?.rolePlan.visibility,
    isLoading: diagnostic.isLoading,
    visibleNonPolymerCount: violation.visibleNonPolymerCount,
    visibleUnscopedPolymerCount: violation.visibleUnscopedPolymerCount,
    visibleUnscopedNonSurfacePolymerCount: violation.visibleUnscopedNonSurfacePolymerCount,
    visibleContextPolymerCount: violation.visibleContextPolymerCount,
    visibleContextNonSurfacePolymerCount: violation.visibleContextNonSurfacePolymerCount,
    visibleContextSurfacePolymerCount: violation.visibleContextSurfacePolymerCount,
    visibleSurfacePolymerCount: violation.visibleSurfacePolymerCount,
    contextRowCount: violation.contextRowCount,
    mismatchedDetailChains: violation.mismatchedDetailChains,
    mismatchedContextComponents: violation.mismatchedContextComponents,
    tableRows: input.transaction.table.rows.map((row) => ({
      chainInstanceId: row.chainInstanceId,
      displayChainId: row.displayChainId,
      memberId: row.memberId,
      detailVisible: row.detailVisible,
      labelAsymId: row.labelAsymId,
      authAsymId: row.authAsymId,
      entityId: row.entityId,
      operator: row.operator,
      displayMolstarColor: row.displayMolstarColor,
      detailMolstarColor: row.detailMolstarColor,
    })),
    detailChainTargets: input.detailChainTargets,
    surfaceOverlayLog: surfaceOverlayDiagnosticLog(),
    detailComponentCreationLog: detailComponentCreationLogForTargets(
      input.transaction.table.rows.map((row) => row.chainInstanceId as string)
    ),
    chainInventory: getStructureChainInventoryDiagnostics(input.viewerCacheKey)[0]?.chains ?? [],
    componentLabels: violation.componentLabels,
    contextComponentSummaries: violation.contextComponentSummaries,
    contextChainLeaks: violation.contextChainLeaks,
  };

  const largeComplexLeakWarn =
    violation.code === 'selected-chain-leaked-into-context' &&
    input.transaction.table.rows.length >= LARGE_COMPLEX_INVARIANT_WARN_CHAIN_COUNT;
  if (largeComplexLeakWarn) {
    console.warn(
      `[MolstarViewer:${input.phase}] ${violation.message} (warn-not-throw;  large complex)`,
      violationPayload
    );
    return;
  }

  throw new StructureRenderPlanViolationError(
    `[MolstarViewer:${input.phase}] ${violation.message} ${JSON.stringify(violationPayload)}`
  );
}

function surfaceOverlayDiagnosticLog(): unknown[] {
  const globalWithDiagnostics = globalThis as {
    __WAYPOINT_MOLSTAR_SURFACE_OVERLAY_LOG__?: unknown[];
  };
  const log = globalWithDiagnostics.__WAYPOINT_MOLSTAR_SURFACE_OVERLAY_LOG__;
  return Array.isArray(log) ? log.slice(-50) : [];
}

function detailComponentCreationLogForTargets(targetIds: readonly string[]): unknown[] {
  const targetIdSet = new Set(targetIds);
  const globalWithDiagnostics = globalThis as {
    __WAYPOINT_MOLSTAR_DETAIL_COMPONENT_CREATION_LOG__?: unknown[];
  };
  const log = globalWithDiagnostics.__WAYPOINT_MOLSTAR_DETAIL_COMPONENT_CREATION_LOG__;
  if (!Array.isArray(log)) return [];
  return log
    .filter((entry) => {
      const targetId = (entry as { targetId?: unknown })?.targetId;
      return typeof targetId === 'string' && targetIdSet.has(targetId);
    })
    .slice(-24);
}

function detailChainMismatches(
  transaction: StructureRenderTransaction,
  diagnostic: StructureRepresentationDiagnostic,
  molstarPlan?: Pick<MolstarRenderPlan, 'defaults' | 'rolePlan'>
): DetailChainMismatch[] {
  if (transaction.chainCatalogStatus !== 'resolved') return [];
  const mismatches: DetailChainMismatch[] = [];
  const expectedColorMode = expectedDetailChainColorMode(transaction, molstarPlan);
  for (const row of transaction.table.rows) {
    if (!row.detailVisible) continue;
    const expectedColor = row.displayMolstarColor ?? row.detailMolstarColor ?? null;
    if (expectedColor === null && expectedColorMode === 'chain') continue;

    const label = `Detail Chain: ${row.chainInstanceId}`;
    const component = componentForLabel(diagnostic, label);
    const representation = primaryRepresentationForComponent(component);
    const actualVisible = isVisibleRepresentation(representation);
    const actualColor = molstarColorFromRepresentation(representation);
    const colorMatches =
      actualVisible &&
      (component?.elementCount ?? 0) > 0 &&
      detailChainColorThemeMatches({
        representation,
        expectedColorMode,
        expectedColor,
      });
    if (colorMatches) continue;

    mismatches.push({
      chainInstanceId: row.chainInstanceId as string,
      label,
      expectedColorMode,
      expectedMolstarColor: expectedColor,
      actualElementCount: component?.elementCount ?? null,
      actualVisible,
      actualTypeName: representation?.typeName ?? null,
      actualColorThemeName: representation?.colorThemeName ?? null,
      actualColorThemeParams: representation?.colorThemeParams,
      actualMolstarColor: actualColor,
    });
  }
  return mismatches;
}

function expectedDetailChainColorMode(
  transaction: StructureRenderTransaction,
  molstarPlan?: Pick<MolstarRenderPlan, 'defaults' | 'rolePlan'>
): string {
  const planDrivenColorMode =
    molstarPlan?.rolePlan.polymerOverrides.query?.colorMode ?? molstarPlan?.defaults.colorMode;
  if (planDrivenColorMode) return planDrivenColorMode;

  return (
    transaction.molstar.representations.find(
      (representation) =>
        representation.visible &&
        representation.kind !== 'surface' &&
        (representation.role === 'query' ||
          representation.role === 'focus' ||
          representation.role === 'unscoped')
    )?.colorMode ?? 'chain'
  );
}

function detailChainColorThemeMatches(input: {
  representation:
    | StructureRepresentationDiagnostic['components'][number]['representations'][number]
    | null;
  expectedColorMode: string;
  expectedColor: number | null;
}): boolean {
  if (!isVisibleRepresentation(input.representation)) return false;
  switch (input.expectedColorMode) {
    case 'chain':
      return (
        input.representation?.colorThemeName === 'uniform' &&
        input.expectedColor !== null &&
        molstarColorFromRepresentation(input.representation) === input.expectedColor
      );
    case 'element':
      return input.representation?.colorThemeName === 'element-symbol';
    case 'bfactor':
      return (
        input.representation?.colorThemeName === 'uncertainty' &&
        numericTupleEquals(input.representation.colorThemeParams.domain, [0, 100])
      );
    case 'plddt':
      return (
        input.representation?.colorThemeName === 'uncertainty' &&
        numericTupleEquals(input.representation.colorThemeParams.domain, [50, 90])
      );
    case 'alphamissense':
      return input.representation?.colorThemeName === 'chain-id';
    default:
      return false;
  }
}

function numericTupleEquals(value: unknown, expected: readonly number[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}

function contextColorMismatches(
  diagnostic: StructureRepresentationDiagnostic,
  expectsVisibleContext: boolean
): ContextColorMismatch[] {
  if (!expectsVisibleContext) return [];
  const mismatches: ContextColorMismatch[] = [];
  for (const component of diagnostic.components) {
    if (!component.label) continue;
    if (polymerRenderRoleForComponentLabel(component.label) !== 'context') continue;
    for (const representation of component.representations) {
      if (!isVisibleRepresentation(representation)) continue;
      if (isGrayContextRepresentation(representation)) continue;
      mismatches.push({
        label: component.label,
        typeName: representation.typeName,
        alpha: representation.alpha,
        actualColorThemeName: representation.colorThemeName,
        actualMolstarColor: molstarColorFromRepresentation(representation),
      });
    }
  }
  return mismatches;
}

function selectedChainContextLeaks(
  transaction: StructureRenderTransaction,
  diagnostic: StructureRepresentationDiagnostic
): ContextChainLeak[] {
  if (transaction.chainCatalogStatus !== 'resolved') return [];
  const selectedRows = transaction.table.rows.filter((row) => row.detailVisible);
  if (selectedRows.length === 0) return [];

  const leaks: ContextChainLeak[] = [];
  for (const component of diagnostic.components) {
    if (!component.label) continue;
    if (polymerRenderRoleForComponentLabel(component.label) !== 'context') continue;
    if (!component.representations.some(isVisibleNonSurfaceRepresentation)) continue;

    const componentChainInstanceId = detailContextChainIdFromComponentLabel(component.label);
    for (const row of selectedRows) {
      if (componentChainInstanceId !== null) {
        if (componentChainInstanceId !== row.chainInstanceId) continue;
        const matchedChains = component.chains.filter((chain) =>
          chainMatchesTransactionRow(chain, row)
        );
        leaks.push({
          chainInstanceId: row.chainInstanceId as string,
          displayChainId: row.displayChainId,
          label: component.label,
          matchedChains: matchedChains.length > 0 ? matchedChains : component.chains,
        });
        continue;
      }

      const matchedChains = component.chains.filter((chain) =>
        chainMatchesTransactionRow(chain, row)
      );
      if (matchedChains.length === 0) continue;
      leaks.push({
        chainInstanceId: row.chainInstanceId as string,
        displayChainId: row.displayChainId,
        label: component.label,
        matchedChains,
      });
    }
  }
  return leaks;
}

function chainMatchesTransactionRow(
  chain: StructureRepresentationDiagnostic['components'][number]['chains'][number],
  row: StructureRenderTransaction['table']['rows'][number]
): boolean {
  const rowAuthAsymId = chainIdToken(row.authAsymId);
  const rowLabelAsymId = chainIdToken(row.labelAsymId);
  const rowDisplayChainId = chainIdToken(row.displayChainId);
  const chainAuthAsymId = chainIdToken(chain.authAsymId);
  const chainLabelAsymId = chainIdToken(chain.labelAsymId);

  const matchedTypedChainId =
    (rowAuthAsymId !== null && rowAuthAsymId === chainAuthAsymId) ||
    (rowLabelAsymId !== null && rowLabelAsymId === chainLabelAsymId);
  const hasTypedRowChainId = rowAuthAsymId !== null || rowLabelAsymId !== null;
  const matchedDisplayFallback =
    !hasTypedRowChainId &&
    rowDisplayChainId !== null &&
    (rowDisplayChainId === chainAuthAsymId || rowDisplayChainId === chainLabelAsymId);
  if (!matchedTypedChainId && !matchedDisplayFallback) return false;

  const rowEntityId = normalizedToken(row.entityId);
  if (rowEntityId && normalizedToken(chain.entityId) !== rowEntityId) return false;

  const rowOperator = normalizedToken(row.operator);
  if (rowOperator && normalizedToken(chain.operatorName) !== rowOperator) return false;

  return true;
}

function chainIdToken(value: string | null | undefined): string | null {
  const token = value?.trim();
  return token ? token : null;
}

function normalizedToken(value: string | null | undefined): string | null {
  const token = value?.trim().toLowerCase();
  return token ? token : null;
}

function polymerRoleComponentSummaries(
  diagnostic: StructureRepresentationDiagnostic,
  role: PolymerRenderRole
): StructureComponentSummary[] {
  return diagnostic.components
    .filter(
      (component) =>
        component.label !== null &&
        component.label !== undefined &&
        polymerRenderRoleForComponentLabel(component.label) === role
    )
    .map((component) => ({
      label: component.label ?? null,
      representations: component.representations.map((representation) => ({
        typeName: representation.typeName,
        alpha: representation.alpha,
        colorThemeName: representation.colorThemeName,
      })),
    }));
}

function componentForLabel(
  diagnostic: StructureRepresentationDiagnostic,
  label: string
): StructureRepresentationDiagnostic['components'][number] | null {
  return diagnostic.components.find((component) => component.label === label) ?? null;
}

function primaryRepresentationForComponent(
  component: StructureRepresentationDiagnostic['components'][number] | null | undefined
): StructureRepresentationDiagnostic['components'][number]['representations'][number] | null {
  return component?.representations[0] ?? null;
}

function isVisibleRepresentation(
  representation:
    | StructureRepresentationDiagnostic['components'][number]['representations'][number]
    | null
    | undefined
): boolean {
  return !!representation?.typeName && representation.alpha !== 0;
}

function isVisibleNonSurfaceRepresentation(
  representation:
    | StructureRepresentationDiagnostic['components'][number]['representations'][number]
    | null
    | undefined
): boolean {
  return (
    !!representation &&
    isVisibleRepresentation(representation) &&
    !isSurfaceRepresentation(representation)
  );
}

function isGrayContextRepresentation(
  representation:
    | StructureRepresentationDiagnostic['components'][number]['representations'][number]
    | null
    | undefined
): boolean {
  return molstarColorFromRepresentation(representation) === STRUCTURE_CONTEXT_MOLSTAR_COLOR;
}

function molstarColorFromRepresentation(
  representation:
    | StructureRepresentationDiagnostic['components'][number]['representations'][number]
    | null
    | undefined
): number | null {
  if (!representation) return null;
  if (
    representation.colorThemeName === 'uniform' &&
    typeof representation.colorThemeParams.value === 'number'
  ) {
    return representation.colorThemeParams.value;
  }
  if (representation.colorThemeName === 'chain-id') {
    return singlePaletteColor(representation.colorThemeParams);
  }
  if (representation.colorThemeName === 'illustrative') {
    const style = representation.colorThemeParams.style as
      | { name?: unknown; params?: Record<string, unknown> }
      | undefined;
    if (style?.name === 'chain-id') return singlePaletteColor(style.params);
  }
  return null;
}

function singlePaletteColor(params: Record<string, unknown> | undefined): number | null {
  const colors = (params?.palette as { params?: { list?: { colors?: unknown[] } } } | undefined)
    ?.params?.list?.colors;
  if (Array.isArray(colors) && colors.length === 1 && typeof colors[0] === 'number') {
    return colors[0];
  }
  return null;
}

function visibleRepresentationCount(
  diagnostic: StructureRepresentationDiagnostic,
  kind: 'polymer' | 'non-polymer',
  options: { surface?: boolean } = {}
): number {
  let count = 0;
  for (const component of diagnostic.components) {
    const isPolymer = !!component.label && !!polymerRenderRoleForComponentLabel(component.label);
    if ((kind === 'polymer') !== isPolymer) continue;
    for (const representation of component.representations) {
      if (representation.alpha === 0) continue;
      if (!representation.typeName) continue;
      if (
        options.surface !== undefined &&
        isSurfaceRepresentation(representation) !== options.surface
      ) {
        continue;
      }
      count += 1;
    }
  }
  return count;
}

function visiblePolymerRoleRepresentationCount(
  diagnostic: StructureRepresentationDiagnostic,
  role: PolymerRenderRole,
  contextChainInstanceIds?: ReadonlySet<string>,
  options: { surface?: boolean } = {}
): number {
  let count = 0;
  for (const component of diagnostic.components) {
    if (!component.label) continue;
    const labelRole = polymerRenderRoleForComponentLabel(component.label);
    const detailChainId = detailChainIdFromComponentLabel(component.label);
    const matchesSingleChainContext =
      role === 'context' &&
      detailChainId !== null &&
      contextChainInstanceIds?.has(detailChainId) === true;
    if (labelRole !== role && !matchesSingleChainContext) continue;
    for (const representation of component.representations) {
      if (representation.alpha === 0) continue;
      if (!representation.typeName) continue;
      if (
        options.surface !== undefined &&
        isSurfaceRepresentation(representation) !== options.surface
      ) {
        continue;
      }
      count += 1;
    }
  }
  return count;
}

function isSurfaceRepresentation(
  representation: StructureRepresentationDiagnostic['components'][number]['representations'][number]
): boolean {
  return (
    representation.tags.includes(SURFACE_OVERLAY_TAG) ||
    representation.typeName === 'molecular-surface' ||
    representation.typeName === 'gaussian-surface' ||
    representation.typeName?.includes('surface') === true
  );
}
