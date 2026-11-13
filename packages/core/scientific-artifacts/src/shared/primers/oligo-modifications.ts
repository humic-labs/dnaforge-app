import { IUPAC_REGEX_CLASS } from '@waypoint/sequence-utils';
import {
  IDT_MODIFICATION_CATALOG,
  IDT_VENDOR_DEFINITION,
  idtModificationCategoryLabels,
  idtModificationNaturalBase,
  idtModificationSupportsOrderType,
  idtModificationPlacements,
  type OligoModificationBehavior,
  type OligoModificationCatalogEntry,
  type OligoModificationPlacement,
  type OligoNaturalBase,
  type OligoVendorProductClass,
} from './oligo-vendor-registry';
import type { OligoOrderType } from './oligo-order-type';

export {
  IDT_CATALOG_SNAPSHOT,
  IDT_MODIFICATION_CATALOG,
  IDT_VENDOR_DEFINITION,
  OLIGO_VENDOR_REGISTRY,
  idtModificationCategoryLabel,
  idtModificationCategoryLabels,
  idtModificationCategoryFilters,
  idtModificationNaturalBase,
  idtModificationPlacements,
  idtModificationSupportsOrderType,
} from './oligo-vendor-registry';
export { oligoOrderTypeLabel } from './oligo-order-type';
export type { OligoOrderType } from './oligo-order-type';
export type {
  OligoModificationBehavior,
  OligoModificationCatalogEntry,
  OligoModificationPlacement,
  OligoNaturalBase,
  OligoVendorProductClass,
  OligoVendorDefinition,
  OligoVendorRule,
} from './oligo-vendor-registry';

export type OligoModificationAnchor =
  | { kind: 'terminus'; end: 'five-prime' | 'three-prime' }
  | { kind: 'between-bases'; offset: number }
  | { kind: 'base'; index: number };

export interface AppliedOligoModificationV1 {
  chemistryId: string;
  vendor: string;
  vendorCode: string;
  placement: OligoModificationPlacement;
  behavior: OligoModificationBehavior;
  anchor: OligoModificationAnchor;
  naturalBase?: OligoNaturalBase;
}

export interface PrimerOligoCompositionV1 {
  vendor: string;

  orderType?: OligoOrderType;
  notation: string;
  modifications: AppliedOligoModificationV1[];
}

export type OligoNotationDiagnosticCode =
  | 'unclosed-token'
  | 'unknown-modification'
  | 'missing-natural-base'
  | 'invalid-base'
  | 'incompatible-order-type'
  | 'invalid-placement'
  | 'vendor-constraint';

export interface OligoNotationDiagnostic {
  code: OligoNotationDiagnosticCode;
  severity: 'error' | 'warning';
  message: string;
  rawStart: number;
  rawEnd: number;
  vendorCode?: string;
  ruleId?: string;
  sourceUrl?: string;
}

export interface ParsedIdtOligoNotation {
  bases: string;
  composition: PrimerOligoCompositionV1 | null;
  diagnostics: OligoNotationDiagnostic[];
  errors: string[];
}

export type OligoNotationDisplayRunKind =
  | 'base'
  | 'degenerate-base'
  | 'rna-base'
  | 'rna-degenerate-base'
  | 'alternate-polymer-base'
  | 'two-prime-o-methyl-base'
  | 'modification'
  | 'whitespace'
  | 'invalid';

export interface OligoNotationDisplayRun {
  kind: OligoNotationDisplayRunKind;
  text: string;
  rawStart: number;
  rawEnd: number;
  naturalBaseIndex?: number;
  catalogEntry?: OligoModificationCatalogEntry;
}

const IDT_BY_CODE = new Map(IDT_MODIFICATION_CATALOG.map((item) => [item.vendorCode, item]));
const IDT_SYMBOLIC_ENTRIES = IDT_MODIFICATION_CATALOG.filter(
  (item) => !item.notation.startsWith('/')
).sort((left, right) => right.notation.length - left.notation.length);

const CANONICAL_DNA_BASES = new Set(['A', 'C', 'G', 'T']);
const CANONICAL_RNA_BASES = new Set(['A', 'C', 'G', 'U']);
const RNA_IUPAC_BASES = new Set([
  ...Object.keys(IUPAC_REGEX_CLASS).filter((base) => base !== 'T'),
  'U',
]);

interface PrefixedRnaBase {
  prefix: 'r' | 'm';
  text: string;
  naturalBase: string;
  kind: 'rna-base' | 'rna-degenerate-base' | 'two-prime-o-methyl-base';
}

function prefixedRnaBaseAt(notation: string, index: number): PrefixedRnaBase | null {
  const prefix = notation[index];
  if (prefix !== 'r' && prefix !== 'm') return null;
  const base = notation[index + 1]?.toUpperCase();
  if (!base) return null;
  if (prefix === 'm') {
    if (!CANONICAL_RNA_BASES.has(base)) return null;
    return {
      prefix,
      text: notation.slice(index, index + 2),
      naturalBase: notation[index + 1],
      kind: 'two-prime-o-methyl-base',
    };
  }
  if (!RNA_IUPAC_BASES.has(base)) return null;
  return {
    prefix,
    text: notation.slice(index, index + 2),
    naturalBase: notation[index + 1],
    kind: CANONICAL_RNA_BASES.has(base) ? 'rna-base' : 'rna-degenerate-base',
  };
}

export function tokenizeIdtOligoNotation(
  notation: string,
  options: Pick<ParseIdtOligoNotationOptions, 'orderType'> = {}
): OligoNotationDisplayRun[] {
  const runs: OligoNotationDisplayRun[] = [];
  let rawIndex = 0;
  let naturalBaseIndex = 0;

  while (rawIndex < notation.length) {
    const character = notation[rawIndex];
    if (/\s/.test(character)) {
      const rawStart = rawIndex;
      while (rawIndex < notation.length && /\s/.test(notation[rawIndex])) rawIndex += 1;
      runs.push({
        kind: 'whitespace',
        text: notation.slice(rawStart, rawIndex),
        rawStart,
        rawEnd: rawIndex,
      });
      continue;
    }

    if (character === '/') {
      const close = notation.indexOf('/', rawIndex + 1);
      const rawEnd = close < 0 ? notation.length : close + 1;
      const text = notation.slice(rawIndex, rawEnd);
      const vendorCode = close < 0 ? null : notation.slice(rawIndex + 1, close);
      const catalogEntry = vendorCode ? IDT_BY_CODE.get(vendorCode) : undefined;
      const run: OligoNotationDisplayRun = {
        kind: catalogEntry ? 'modification' : 'invalid',
        text,
        rawStart: rawIndex,
        rawEnd,
        ...(catalogEntry ? { catalogEntry } : {}),
      };
      if (catalogEntry?.behavior === 'modified-base') {
        run.naturalBaseIndex = naturalBaseIndex;
        naturalBaseIndex += 1;
      }
      runs.push(run);
      rawIndex = rawEnd;
      continue;
    }

    const symbolicEntry = IDT_SYMBOLIC_ENTRIES.find((entry) =>
      notation.startsWith(entry.notation, rawIndex)
    );
    if (symbolicEntry) {
      runs.push({
        kind: 'modification',
        text: symbolicEntry.notation,
        rawStart: rawIndex,
        rawEnd: rawIndex + symbolicEntry.notation.length,
        catalogEntry: symbolicEntry,
        ...(symbolicEntry.behavior === 'modified-base'
          ? { naturalBaseIndex: naturalBaseIndex++ }
          : {}),
      });
      rawIndex += symbolicEntry.notation.length;
      continue;
    }

    const prefixedRnaBase =
      options.orderType === 'rna' ? prefixedRnaBaseAt(notation, rawIndex) : null;
    if (prefixedRnaBase) {
      runs.push({
        kind: prefixedRnaBase.kind,
        text: prefixedRnaBase.text,
        rawStart: rawIndex,
        rawEnd: rawIndex + prefixedRnaBase.text.length,
        naturalBaseIndex,
      });
      naturalBaseIndex += 1;
      rawIndex += prefixedRnaBase.text.length;
      continue;
    }

    const upper = character.toUpperCase();
    const isIupac = upper in IUPAC_REGEX_CLASS;
    const kind: OligoNotationDisplayRunKind =
      options.orderType === 'rna'
        ? CANONICAL_RNA_BASES.has(upper)
          ? 'rna-base'
          : upper === 'T'
            ? 'alternate-polymer-base'
            : isIupac
              ? 'rna-degenerate-base'
              : 'invalid'
        : upper === 'U'
          ? 'invalid'
          : isIupac
            ? CANONICAL_DNA_BASES.has(upper)
              ? 'base'
              : 'degenerate-base'
            : 'invalid';
    runs.push({
      kind,
      text: character,
      rawStart: rawIndex,
      rawEnd: rawIndex + 1,
      naturalBaseIndex,
    });
    naturalBaseIndex += 1;
    rawIndex += 1;
  }

  return runs;
}

interface PendingModification {
  entry: OligoModificationCatalogEntry;
  baseOffsetBefore: number;
  baseIndex?: number;
  rawStart: number;
  rawEnd: number;
}

export interface ParseIdtOligoNotationOptions {
  orderType?: OligoOrderType;
  productClass?: OligoVendorProductClass;

  enforceVendorConstraints?: boolean;

  enforceOrderTypeAvailability?: boolean;
}

function isValidIdtNaturalBase(args: {
  naturalBase: string;
  syntax: 'dna' | 'rna' | 'two-prime-o-methyl' | 'modified-base';
  orderType: OligoOrderType;
}): boolean {
  if (args.syntax === 'rna' || args.syntax === 'two-prime-o-methyl') {
    return RNA_IUPAC_BASES.has(args.naturalBase);
  }
  if (args.syntax === 'modified-base') {
    return (
      args.naturalBase in IUPAC_REGEX_CLASS ||
      (args.orderType === 'rna' && args.naturalBase === 'U')
    );
  }
  return (
    args.naturalBase in IUPAC_REGEX_CLASS && (args.orderType === 'rna' || args.naturalBase !== 'U')
  );
}

function consumeSlashIdtToken(args: {
  notation: string;
  index: number;
  orderType: OligoOrderType;
  enforceOrderTypeAvailability?: boolean;
  addDiagnostic: (diagnostic: OligoNotationDiagnostic) => void;
  addPendingModification: (
    catalogEntry: OligoModificationCatalogEntry,
    rawStart: number,
    rawEnd: number
  ) => void;
}): { index: number; stop: boolean } {
  const close = args.notation.indexOf('/', args.index + 1);
  if (close < 0) {
    args.addDiagnostic({
      code: 'unclosed-token',
      severity: 'error',
      message: 'Unclosed IDT modification token.',
      rawStart: args.index,
      rawEnd: args.notation.length,
    });
    return { index: args.index, stop: true };
  }
  const vendorCode = args.notation.slice(args.index + 1, close);
  const catalogEntry = IDT_BY_CODE.get(vendorCode);
  if (!catalogEntry) {
    args.addDiagnostic({
      code: 'unknown-modification',
      severity: 'error',
      message: `Unknown IDT modification /${vendorCode}/.`,
      rawStart: args.index,
      rawEnd: close + 1,
      vendorCode,
    });
    return { index: close + 1, stop: false };
  }
  if (
    args.enforceOrderTypeAvailability !== false &&
    !idtModificationSupportsOrderType(catalogEntry, args.orderType)
  ) {
    args.addDiagnostic({
      code: 'incompatible-order-type',
      severity: 'error',
      message: `${catalogEntry.notation} is not available for IDT ${args.orderType.toUpperCase()} oligos.`,
      rawStart: args.index,
      rawEnd: close + 1,
      vendorCode,
      ...(catalogEntry.productUrl ? { sourceUrl: catalogEntry.productUrl } : {}),
    });
  }
  args.addPendingModification(catalogEntry, args.index, close + 1);
  return { index: close + 1, stop: false };
}

function idtPendingModificationsAreAdjacent(
  notation: string,
  left: PendingModification,
  right: PendingModification
): boolean {
  return (
    left.baseOffsetBefore === right.baseOffsetBefore &&
    !/[^\s]/.test(notation.slice(left.rawEnd, right.rawStart))
  );
}

function enforceIdtVendorConstraintRules(args: {
  notation: string;
  pending: PendingModification[];
  modifications: AppliedOligoModificationV1[];
  productClass?: OligoVendorProductClass;
  enforceVendorConstraints?: boolean;
  addDiagnostic: (diagnostic: OligoNotationDiagnostic) => void;
}): void {
  const areAdjacent = (left: PendingModification, right: PendingModification): boolean =>
    idtPendingModificationsAreAdjacent(args.notation, left, right);
  const addRuleDiagnostic = (
    rule: { id: string; message: string; sourceUrl: string },
    source: PendingModification,
    severity: 'error' | 'warning'
  ): void => {
    args.addDiagnostic({
      code: 'vendor-constraint',
      severity,
      message: rule.message,
      rawStart: source.rawStart,
      rawEnd: source.rawEnd,
      vendorCode: source.entry.vendorCode,
      ruleId: rule.id,
      sourceUrl: rule.sourceUrl,
    });
  };

  for (const rule of args.enforceVendorConstraints === false ? [] : IDT_VENDOR_DEFINITION.rules) {
    if (rule.kind === 'max-consecutive' || rule.kind === 'documented-adjacent-series') {
      let consecutive = 0;
      let previous: PendingModification | null = null;
      const maximum = rule.kind === 'max-consecutive' ? rule.maximum : rule.maximumDocumented;
      for (const current of args.pending) {
        const sameSeries =
          previous !== null &&
          current.entry.chemistryId === rule.chemistryId &&
          previous.entry.chemistryId === rule.chemistryId &&
          areAdjacent(previous, current);
        consecutive =
          current.entry.chemistryId === rule.chemistryId ? (sameSeries ? consecutive + 1 : 1) : 0;
        if (consecutive === maximum + 1) {
          addRuleDiagnostic(
            rule,
            current,
            rule.kind === 'max-consecutive' ? rule.severity : 'warning'
          );
        }
        previous = current;
      }
      continue;
    }

    if (rule.kind === 'contextual-max-consecutive') {
      for (let companionIndex = 0; companionIndex < args.pending.length; companionIndex += 1) {
        const companion = args.pending[companionIndex];
        if (
          companion.entry.chemistryId !== rule.appliesWhen.adjacentChemistryId ||
          !rule.appliesWhen.terminalPlacements.includes(
            companion.entry.placement as 'five-prime' | 'three-prime'
          )
        ) {
          continue;
        }
        const direction = companion.entry.placement === 'five-prime' ? 1 : -1;
        let previous = companion;
        let indexInDirection = companionIndex + direction;
        let count = 0;
        while (indexInDirection >= 0 && indexInDirection < args.pending.length) {
          const current = args.pending[indexInDirection];
          const adjacent =
            direction === 1 ? areAdjacent(previous, current) : areAdjacent(current, previous);
          if (current.entry.chemistryId !== rule.chemistryId || !adjacent) break;
          count += 1;
          if (count === rule.maximum + 1) addRuleDiagnostic(rule, current, rule.severity);
          previous = current;
          indexInDirection += direction;
        }
      }
      continue;
    }

    if (rule.kind === 'incompatible-chemistries') {
      const left = args.pending.find((item) =>
        rule.leftChemistryIds.includes(item.entry.chemistryId)
      );
      const right = args.pending.find((item) =>
        rule.rightChemistryIds.includes(item.entry.chemistryId)
      );
      if (left && right)
        addRuleDiagnostic(rule, left.rawStart > right.rawStart ? left : right, rule.severity);
      continue;
    }

    if (rule.kind === 'requires-companion') {
      const trigger = args.pending.find((item) =>
        rule.triggerChemistryIds.includes(item.entry.chemistryId)
      );
      if (!trigger) continue;
      const hasCompanion = args.modifications.some((modification) =>
        rule.requiredAnyOf.some(
          (requirement) =>
            modification.chemistryId === requirement.chemistryId &&
            (!requirement.placement || modification.placement === requirement.placement)
        )
      );
      if (!hasCompanion) addRuleDiagnostic(rule, trigger, rule.severity);
      continue;
    }

    if (rule.kind === 'max-total') {
      const productClass = args.productClass ?? 'dna-rna-oligo';
      if (!rule.productClasses.includes(productClass)) continue;
      const matching = args.pending.filter((item) =>
        rule.chemistryIds.includes(item.entry.chemistryId)
      );
      const firstExcess = matching[rule.maximum];
      if (firstExcess) addRuleDiagnostic(rule, firstExcess, rule.severity);
    }
  }
}

export function parseIdtOligoNotation(
  notation: string,
  options: ParseIdtOligoNotationOptions = {}
): ParsedIdtOligoNotation {
  const diagnostics: OligoNotationDiagnostic[] = [];
  const bases: string[] = [];
  const orderType = options.orderType ?? 'dna';
  const naturalBaseSources: Array<{
    rawStart: number;
    rawEnd: number;
    syntax: 'dna' | 'rna' | 'two-prime-o-methyl' | 'modified-base';
  }> = [];
  const pending: PendingModification[] = [];
  const addDiagnostic = (diagnostic: OligoNotationDiagnostic): void => {
    diagnostics.push(diagnostic);
  };
  const addPendingModification = (
    catalogEntry: OligoModificationCatalogEntry,
    rawStart: number,
    rawEnd: number
  ): void => {
    const modification: PendingModification = {
      entry: catalogEntry,
      baseOffsetBefore: bases.length,
      rawStart,
      rawEnd,
    };
    if (catalogEntry.behavior === 'modified-base') {
      const naturalBase = idtModificationNaturalBase(catalogEntry, orderType);
      if (!naturalBase) {
        addDiagnostic({
          code: 'missing-natural-base',
          severity: 'error',
          message: `IDT modification ${catalogEntry.notation} has no verified natural-base analogue.`,
          rawStart,
          rawEnd,
          vendorCode: catalogEntry.vendorCode,
          ...(catalogEntry.productUrl ? { sourceUrl: catalogEntry.productUrl } : {}),
        });
      } else {
        modification.baseIndex = bases.length;
        bases.push(naturalBase);
        naturalBaseSources.push({ rawStart, rawEnd, syntax: 'modified-base' });
      }
    }
    pending.push(modification);
  };
  let index = 0;

  while (index < notation.length) {
    const character = notation[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === '/') {
      const slash = consumeSlashIdtToken({
        notation,
        index,
        orderType,
        enforceOrderTypeAvailability: options.enforceOrderTypeAvailability,
        addDiagnostic,
        addPendingModification,
      });
      index = slash.index;
      if (slash.stop) break;
      continue;
    }
    const symbolicEntry = IDT_SYMBOLIC_ENTRIES.find((entry) =>
      notation.startsWith(entry.notation, index)
    );
    if (symbolicEntry) {
      addPendingModification(symbolicEntry, index, index + symbolicEntry.notation.length);
      index += symbolicEntry.notation.length;
      continue;
    }

    const prefixedRnaBase = orderType === 'rna' ? prefixedRnaBaseAt(notation, index) : null;
    if (prefixedRnaBase) {
      bases.push(prefixedRnaBase.naturalBase);
      naturalBaseSources.push({
        rawStart: index,
        rawEnd: index + prefixedRnaBase.text.length,
        syntax: prefixedRnaBase.prefix === 'm' ? 'two-prime-o-methyl' : 'rna',
      });
      index += prefixedRnaBase.text.length;
      continue;
    }
    bases.push(character);
    naturalBaseSources.push({ rawStart: index, rawEnd: index + 1, syntax: 'dna' });
    index += 1;
  }

  const naturalBases = bases.join('');
  const idtReadyNotation = notation.replace(/\s+/g, '');
  for (let baseIndex = 0; baseIndex < naturalBases.length; baseIndex += 1) {
    const naturalBase = naturalBases[baseIndex].toUpperCase();
    const source = naturalBaseSources[baseIndex] ?? {
      rawStart: 0,
      rawEnd: 0,
      syntax: 'dna' as const,
    };
    const valid = isValidIdtNaturalBase({
      naturalBase,
      syntax: source.syntax,
      orderType,
    });
    if (!valid) {
      addDiagnostic({
        code: 'invalid-base',
        severity: 'error',
        message: `Invalid natural primer base ${naturalBases[baseIndex]} at position ${baseIndex}.`,
        ...source,
      });
    }
  }

  const modifications = pending.map(({ entry: catalogEntry, baseOffsetBefore, baseIndex }) => {
    const naturalBase = idtModificationNaturalBase(catalogEntry, orderType);
    const actualBasePlacement: OligoModificationPlacement =
      baseIndex === 0
        ? 'five-prime'
        : baseIndex === naturalBases.length - 1
          ? 'three-prime'
          : 'internal';
    const placement = catalogEntry.allowedPlacements ? actualBasePlacement : catalogEntry.placement;
    const anchor: OligoModificationAnchor =
      catalogEntry.behavior === 'modified-base'
        ? { kind: 'base', index: baseIndex ?? baseOffsetBefore }
        : catalogEntry.placement === 'five-prime'
          ? { kind: 'terminus', end: 'five-prime' }
          : catalogEntry.placement === 'three-prime'
            ? { kind: 'terminus', end: 'three-prime' }
            : { kind: 'between-bases', offset: baseOffsetBefore };
    const applied: AppliedOligoModificationV1 = {
      chemistryId: catalogEntry.chemistryId,
      vendor: catalogEntry.vendor,
      vendorCode: catalogEntry.vendorCode,
      placement,
      behavior: catalogEntry.behavior,
      anchor,
      ...(naturalBase ? { naturalBase } : {}),
    };
    return applied;
  });

  modifications.forEach((modification, modificationIndex) => {
    const pendingModification = pending[modificationIndex];
    const sourceOffset = pendingModification?.baseOffsetBefore ?? -1;
    const token = pendingModification?.entry.notation ?? displayIdtToken(modification.vendorCode);
    const addPlacementError = (message: string): void => {
      addDiagnostic({
        code: 'invalid-placement',
        severity: 'error',
        message,
        rawStart: pendingModification?.rawStart ?? 0,
        rawEnd: pendingModification?.rawEnd ?? 0,
        vendorCode: modification.vendorCode,
        ...(pendingModification?.entry.productUrl
          ? { sourceUrl: pendingModification.entry.productUrl }
          : {}),
      });
    };
    const allowedPlacements = pendingModification
      ? idtModificationPlacements(pendingModification.entry)
      : [modification.placement];
    if (modification.placement === 'five-prime') {
      const valid =
        modification.anchor.kind === 'terminus'
          ? modification.anchor.end === 'five-prime' && sourceOffset === 0
          : modification.anchor.kind === 'base' && modification.anchor.index === 0;
      if (!valid || !allowedPlacements.includes('five-prime')) {
        addPlacementError(`${token} can only be used at the 5′ end.`);
      }
      return;
    }
    if (modification.placement === 'three-prime') {
      const valid =
        modification.anchor.kind === 'terminus'
          ? modification.anchor.end === 'three-prime' && sourceOffset === naturalBases.length
          : modification.anchor.kind === 'base' &&
            modification.anchor.index === naturalBases.length - 1;
      if (!valid || !allowedPlacements.includes('three-prime')) {
        addPlacementError(`${token} can only be used at the 3′ end.`);
      }
      return;
    }
    const internalOffset =
      modification.anchor.kind === 'base'
        ? modification.anchor.index
        : modification.anchor.kind === 'between-bases'
          ? modification.anchor.offset
          : -1;
    const valid =
      modification.anchor.kind === 'base'
        ? internalOffset > 0 && internalOffset < naturalBases.length - 1
        : internalOffset > 0 && internalOffset < naturalBases.length;
    if (!valid || !allowedPlacements.includes('internal')) {
      addPlacementError(`${token} can only be used between two bases.`);
    }
  });

  enforceIdtVendorConstraintRules({
    notation,
    pending,
    modifications,
    productClass: options.productClass,
    enforceVendorConstraints: options.enforceVendorConstraints,
    addDiagnostic,
  });

  const errors = diagnostics
    .filter((diagnostic) => diagnostic.severity === 'error')
    .map((diagnostic) => diagnostic.message);

  return {
    bases: naturalBases,
    composition:
      errors.length === 0 && (modifications.length > 0 || orderType === 'rna')
        ? {
            vendor: 'idt',
            ...(orderType === 'rna' ? { orderType } : {}),
            notation: idtReadyNotation,
            modifications,
          }
        : null,
    diagnostics,
    errors,
  };
}

export function serializeIdtOligoOrderNotation(
  notation: string,
  orderType: OligoOrderType = 'dna'
): string {
  const parsed = parseIdtOligoNotation(notation, { orderType });
  if (parsed.errors.length > 0) throw new Error(parsed.errors[0]);

  const runs = tokenizeIdtOligoNotation(notation, { orderType });
  const hasExplicitRnaSyntax =
    orderType === 'rna' &&
    runs.some(
      (run) =>
        (run.text.startsWith('r') || run.text.startsWith('m')) &&
        (run.kind === 'rna-base' ||
          run.kind === 'rna-degenerate-base' ||
          run.kind === 'two-prime-o-methyl-base')
    );

  return runs
    .map((run) => {
      if (run.kind === 'whitespace') return '';
      if (
        orderType === 'rna' &&
        !hasExplicitRnaSyntax &&
        (run.kind === 'rna-base' || run.kind === 'rna-degenerate-base') &&
        run.text.length === 1
      ) {
        return `r${run.text}`;
      }
      return run.text;
    })
    .join('');
}

export function searchIdtModificationOptions(
  options: readonly OligoModificationCatalogEntry[],
  query: string,
  filters: {
    categoryLabel?: string;
    categoryLabels?: readonly string[];
    placement?: OligoModificationPlacement;
    placements?: readonly OligoModificationPlacement[];
    orderType?: OligoOrderType;
  } = {}
): readonly OligoModificationCatalogEntry[] {
  const normalized = query.trim().toLowerCase();
  return options.filter((item) => {
    if (filters.orderType && !idtModificationSupportsOrderType(item, filters.orderType)) {
      return false;
    }
    const selectedCategories = filters.categoryLabels?.length
      ? filters.categoryLabels
      : filters.categoryLabel
        ? [filters.categoryLabel]
        : [];
    if (
      selectedCategories.length > 0 &&
      !selectedCategories.some((label) => idtModificationCategoryLabels(item).includes(label))
    ) {
      return false;
    }
    const selectedPlacements = filters.placements?.length
      ? filters.placements
      : filters.placement
        ? [filters.placement]
        : [];
    if (
      selectedPlacements.length > 0 &&
      !selectedPlacements.some((placement) => idtModificationPlacements(item).includes(placement))
    ) {
      return false;
    }
    if (!normalized) return true;
    return [
      item.label,
      item.vendorCode,
      item.category,
      ...idtModificationCategoryLabels(item),
      ...(item.searchTerms ?? []),
    ]
      .join(' ')
      .toLowerCase()
      .includes(normalized);
  });
}

export function insertIdtModification(
  notation: string,
  replaceStart: number,
  replaceEnd: number,
  vendorCode: string,
  options: { consumeFollowingBase?: boolean; orderType?: OligoOrderType } = {}
): { notation: string; caret: number } {
  const catalogEntry = IDT_BY_CODE.get(vendorCode);
  if (!catalogEntry) throw new Error(`Unknown IDT modification ${vendorCode}.`);
  const token = catalogEntry.notation;
  const orderType = options.orderType ?? 'dna';
  const naturalBase = idtModificationNaturalBase(catalogEntry, orderType);
  let suffix = notation.slice(replaceEnd);
  const prefixedNaturalBaseWidth =
    naturalBase !== undefined &&
    orderType === 'rna' &&
    (suffix[0] === 'r' || suffix[0] === 'm') &&
    suffix[1]?.toUpperCase() === naturalBase
      ? 2
      : 0;
  const plainNaturalBaseWidth =
    naturalBase !== undefined && suffix[0]?.toUpperCase() === naturalBase ? 1 : 0;
  if (
    catalogEntry.behavior === 'modified-base' &&
    (options.consumeFollowingBase ?? true) &&
    (prefixedNaturalBaseWidth > 0 || plainNaturalBaseWidth > 0)
  ) {
    suffix = suffix.slice(prefixedNaturalBaseWidth || plainNaturalBaseWidth);
  }
  return {
    notation: `${notation.slice(0, replaceStart)}${token}${suffix}`,
    caret: replaceStart + token.length,
  };
}

export function displayIdtToken(vendorCode: string): string {
  return IDT_BY_CODE.get(vendorCode)?.notation ?? `/${vendorCode}/`;
}

export function resizeIdtOligoNotation(
  notation: string,
  length: number,
  extension = '',
  orderType: OligoOrderType = 'dna'
): string {
  const parsed = parseIdtOligoNotation(notation, { orderType });
  if (parsed.errors.length > 0) throw new Error(parsed.errors[0]);
  if (!Number.isInteger(length) || length < 0) throw new Error('Invalid oligo length.');
  if (length === parsed.bases.length) return notation;
  const runs = tokenizeIdtOligoNotation(notation, { orderType });
  let terminalStart = runs.length;
  while (terminalStart > 0) {
    const run = runs[terminalStart - 1];
    const entry = run.catalogEntry;
    if (
      run.kind === 'whitespace' ||
      (entry &&
        idtModificationPlacements(entry).includes('three-prime') &&
        (entry.behavior === 'terminal-attachment' || entry.placement === 'three-prime'))
    ) {
      terminalStart -= 1;
    } else break;
  }
  const suffix = runs.slice(terminalStart);
  const terminalBases = suffix.filter((run) => run.naturalBaseIndex !== undefined).length;
  if (length < terminalBases) throw new Error('Length would remove a terminal modified base.');
  if (length > parsed.bases.length) {
    const added = extension.slice(0, length - parsed.bases.length);
    if (added.length !== length - parsed.bases.length) {
      throw new Error('Missing template bases for oligo extension.');
    }
    const offset = runs[terminalStart]?.rawStart ?? notation.length;
    return notation.slice(0, offset) + added + notation.slice(offset);
  }
  const retainedBases = length - terminalBases;
  let seenBases = 0;
  const prefix = runs.slice(0, terminalStart).filter((run) => {
    if (run.naturalBaseIndex !== undefined) {
      seenBases += 1;
      return run.naturalBaseIndex < retainedBases;
    }

    if (
      run.catalogEntry?.behavior === 'between-bases' ||
      run.catalogEntry?.behavior === 'linkage'
    ) {
      return seenBases > 0 && seenBases < retainedBases + terminalBases;
    }
    return true;
  });
  return [...prefix, ...suffix].map((run) => run.text).join('');
}
