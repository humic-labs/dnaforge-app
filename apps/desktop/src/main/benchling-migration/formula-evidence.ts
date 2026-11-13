import type { ProjectionFormulaEvidence, SourceObject } from '../../shared/benchling-migration';
import { SUPPORTED_TABLE_FORMULAS } from '../../shared/table-formulas';
import { classifyNotebookFormula } from './notebook-html-projection';

const FORMULA_ATTRIBUTE =
  /\b(?:data-formula|data-cell-formula|data-benchling-formula|formula)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

export const VALIDATION_FORMULA_EVIDENCE = Symbol('validationFormulaEvidence');
export type SourceObjectFormulaValidationView = SourceObject & {
  readonly [VALIDATION_FORMULA_EVIDENCE]: readonly ProjectionFormulaEvidence[];
};

export function collectProjectionFormulaEvidence(
  sourceObject: SourceObject | SourceObjectFormulaValidationView
): ProjectionFormulaEvidence[] {
  if (VALIDATION_FORMULA_EVIDENCE in sourceObject) {
    return sourceObject[VALIDATION_FORMULA_EVIDENCE].map((entry) => ({ ...entry }));
  }
  const evidence: ProjectionFormulaEvidence[] = [];
  const supportedFormulaNames = new Set<string>(SUPPORTED_TABLE_FORMULAS);
  visit(sourceObject.content, 'content', evidence, supportedFormulaNames);
  visit(sourceObject.metadata, 'metadata', evidence, supportedFormulaNames);
  return deduplicateEvidence(evidence);
}

function visit(
  value: unknown,
  locator: string,
  evidence: ProjectionFormulaEvidence[],
  supportedFormulaNames: ReadonlySet<string>
): void {
  if (typeof value === 'string') {
    collectHtmlFormulaAttributes(value, locator, evidence, supportedFormulaNames);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      visit(entry, `${locator}[${index}]`, evidence, supportedFormulaNames)
    );
    return;
  }
  if (!isRecord(value)) return;

  const formula = formulaFromRecord(value);
  if (formula) {
    const explicitCompatibility =
      value.formulaCompatibility === 'supported' || value.formulaCompatibility === 'unsupported'
        ? value.formulaCompatibility
        : value.compatibility === 'supported' || value.compatibility === 'unsupported'
          ? value.compatibility
          : null;
    evidence.push({
      locator,
      formula,
      compatibility:
        explicitCompatibility ?? classifyNotebookFormula(formula, supportedFormulaNames),
      stale: value.stale === true,
    });
  }

  for (const [key, entry] of Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    visit(entry, `${locator}.${key}`, evidence, supportedFormulaNames);
  }
}

function collectHtmlFormulaAttributes(
  html: string,
  locator: string,
  evidence: ProjectionFormulaEvidence[],
  supportedFormulaNames: ReadonlySet<string>
): void {
  if (!html.includes('<') || !/formula/i.test(html)) return;
  let match: RegExpExecArray | null;
  let index = 0;
  FORMULA_ATTRIBUTE.lastIndex = 0;
  while ((match = FORMULA_ATTRIBUTE.exec(html)) !== null) {
    const formula = decodeHtmlAttribute(match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!formula.startsWith('=')) continue;
    index += 1;
    evidence.push({
      locator: `${locator}#formula-${index}`,
      formula,
      compatibility: classifyNotebookFormula(formula, supportedFormulaNames),
      stale: false,
    });
  }
}

function formulaFromRecord(value: Record<string, unknown>): string | null {
  for (const candidate of [value.formula, value.sourceFormula]) {
    if (typeof candidate === 'string' && candidate.trim().startsWith('=')) {
      return candidate.trim();
    }
  }
  if (
    value.type === 'formula' &&
    typeof value.value === 'string' &&
    value.value.trim().startsWith('=')
  ) {
    return value.value.trim();
  }
  return null;
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function deduplicateEvidence(
  evidence: readonly ProjectionFormulaEvidence[]
): ProjectionFormulaEvidence[] {
  const unique = new Map<string, ProjectionFormulaEvidence>();
  for (const entry of evidence) {
    const key = `${entry.locator}\0${entry.formula}`;
    unique.set(key, { ...entry });
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.locator.localeCompare(right.locator) || left.formula.localeCompare(right.formula)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
