import type { ResourceId } from '@waypoint/workspace-revisions';
import type {
  BindingEvidenceFreshness,
  RevisionPin,
  ScientificDocument,
  ScientificIssue,
  ScientificReader,
  ScientificSnapshot,
} from './types';

export interface ValidateScientificChangeInput {
  readonly before: ScientificReader;
  readonly after: ScientificReader;
  readonly changedResourceIds: readonly ResourceId[];
}

export function validateScientificChange(
  input: ValidateScientificChangeInput
): readonly ScientificIssue[] {
  const issues: ScientificIssue[] = [];
  const report = (code: ScientificIssue['code'], resourceId: ResourceId, message: string) =>
    issues.push(Object.freeze({ code, resourceId, message }));
  const current = (owner: ResourceId, resourceId: ResourceId, kind: ScientificDocument['kind']) => {
    const found = input.after.current(resourceId);
    if (!found) report('MISSING_REFERENCE', owner, `Missing current ${kind}: ${resourceId}`);
    else if (found.resourceId !== resourceId)
      report('REFERENCE_IDENTITY_MISMATCH', owner, `Wrong resource returned for ${resourceId}`);
    else if (found.document.kind !== kind)
      report('WRONG_REFERENCE_KIND', owner, `Expected ${kind}: ${resourceId}`);
    else return found;
    return null;
  };
  const revision = (owner: ResourceId, pin: RevisionPin, kind: ScientificDocument['kind']) => {
    const found = input.after.revision(pin);
    if (!found)
      report(
        input.after.hasRevision(pin) ? 'WRONG_REFERENCE_KIND' : 'MISSING_REFERENCE',
        owner,
        `Missing ${kind} revision: ${pin.resourceId}@${pin.revisionId}`
      );
    else if (!samePin(found, pin))
      report('REFERENCE_IDENTITY_MISMATCH', owner, `Revision does not belong to ${pin.resourceId}`);
    else if (found.document.kind !== kind)
      report('WRONG_REFERENCE_KIND', owner, `Expected a ${kind} revision: ${pin.resourceId}`);
    else return found;
    return null;
  };
  const evidence = (owner: ResourceId, pins: readonly RevisionPin[]) => {
    for (const pin of pins)
      if (!input.after.hasRevision(pin))
        report(
          'MISSING_REFERENCE',
          owner,
          `Missing accepted evidence: ${pin.resourceId}@${pin.revisionId}`
        );
  };
  for (const resourceId of input.changedResourceIds) {
    const before = input.before.current(resourceId),
      after = input.after.current(resourceId);
    if (
      before?.document.kind === 'accepted-assembly' &&
      (!after || before.scientificHash !== after.scientificHash)
    )
      report(
        'ASSEMBLY_HISTORY_IMMUTABLE',
        resourceId,
        'An accepted assembly cannot be edited or deleted; accept a new version.'
      );
    if (before && after && before.document.kind !== after.document.kind)
      report('KIND_IMMUTABLE', resourceId, 'An existing scientific object cannot change kind.');
  }
  const descent = new Map<ResourceId, Set<ResourceId>>();
  for (const snapshot of input.after.listCurrent()) {
    const owner = snapshot.resourceId,
      document = snapshot.document;
    switch (document.kind) {
      case 'primer-binding': {
        current(owner, document.primerId, 'primer');
        const target = revision(owner, document.target, 'sequence');
        if (target?.document.kind === 'sequence') {
          const { start, end } = document.coordinates,
            length = target.document.bases.length;
          if (
            start >= length ||
            end > length ||
            start === end ||
            (target.document.topology === 'linear' && end <= start)
          )
            report(
              'INVALID_COORDINATES',
              owner,
              'Binding coordinates do not span a valid interval on the pinned sequence.'
            );
        }
        break;
      }
      case 'binding-evidence': {
        const binding = revision(owner, document.binding, 'primer-binding');
        revision(owner, document.primer, 'primer');
        revision(owner, document.target, 'sequence');
        if (
          binding?.document.kind === 'primer-binding' &&
          (binding.document.primerId !== document.primer.resourceId ||
            !samePin(binding.document.target, document.target))
        )
          report(
            'EVIDENCE_INPUT_MISMATCH',
            owner,
            'Evidence inputs differ from the pinned placement inputs.'
          );
        break;
      }
      case 'strain-sequence':
        current(owner, document.strainId, 'strain');
        revision(owner, document.sequence, 'sequence');
        evidence(owner, document.evidence);
        break;
      case 'strain-descent': {
        current(owner, document.strainId, 'strain');
        revision(owner, document.parent, 'strain');
        evidence(owner, document.evidence);
        const parents = descent.get(document.strainId) ?? new Set<ResourceId>();
        parents.add(document.parent.resourceId);
        descent.set(document.strainId, parents);
        break;
      }
      case 'accepted-assembly': {
        for (const source of document.sources) revision(owner, source, 'sequence');
        for (const primer of document.primers) revision(owner, primer, 'primer');
        revision(owner, document.product, 'sequence');
        if (document.parent) {
          const parent = revision(owner, document.parent, 'accepted-assembly');
          if (
            parent?.document.kind === 'accepted-assembly' &&
            parent.document.constructId !== document.constructId
          )
            report(
              'EVIDENCE_INPUT_MISMATCH',
              owner,
              'Assembly parent belongs to a different construct.'
            );
        }
        break;
      }
      default:
        break;
    }
  }

  const done = new Set<ResourceId>(),
    visiting = new Set<ResourceId>();
  for (const strain of descent.keys()) {
    if (done.has(strain)) continue;
    const stack: { id: ResourceId; exit: boolean }[] = [{ id: strain, exit: false }];
    while (stack.length) {
      const next = stack.pop();
      if (!next) break;
      if (next.exit) {
        visiting.delete(next.id);
        done.add(next.id);
        continue;
      }
      if (done.has(next.id)) continue;
      if (visiting.has(next.id)) {
        report('STRAIN_DESCENT_CYCLE', next.id, 'Strain descent contains a cycle.');
        continue;
      }
      visiting.add(next.id);
      stack.push({ id: next.id, exit: true });
      for (const parent of descent.get(next.id) ?? []) stack.push({ id: parent, exit: false });
    }
  }
  return Object.freeze(issues);
}

export function bindingEvidenceFreshness(
  document: ScientificDocument,
  reader: ScientificReader
): BindingEvidenceFreshness {
  if (document.kind !== 'binding-evidence') throw new TypeError('Expected binding evidence.');
  const pairs: readonly [RevisionPin, ScientificDocument['kind']][] = [
    [document.primer, 'primer'],
    [document.target, 'sequence'],
    [document.binding, 'primer-binding'],
  ];
  let stale = false;
  const originals: ScientificSnapshot[] = [];
  for (const [pin, kind] of pairs) {
    const original = reader.revision(pin),
      active = reader.current(pin.resourceId);
    if (
      !original ||
      !active ||
      !samePin(original, pin) ||
      original.document.kind !== kind ||
      active.document.kind !== kind ||
      active.resourceId !== pin.resourceId
    )
      return 'unavailable';
    originals.push(original);
    const before = kind === 'primer-binding' ? original.scientificHash : original.bindingInputHash;
    const after = kind === 'primer-binding' ? active.scientificHash : active.bindingInputHash;
    if (before === null || after === null) return 'unavailable';
    stale ||= before !== after;
  }
  const binding = originals[2]?.document;
  if (
    binding?.kind !== 'primer-binding' ||
    binding.primerId !== document.primer.resourceId ||
    !samePin(binding.target, document.target)
  )
    return 'unavailable';
  return stale ? 'stale' : 'current';
}

function samePin(left: RevisionPin, right: RevisionPin): boolean {
  return left.resourceId === right.resourceId && left.revisionId === right.revisionId;
}
