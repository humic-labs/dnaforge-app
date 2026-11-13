export const STRUCTURE_COMPONENT_LABELS = {
  polymer: 'Polymer',
  rcsbContextPolymer: 'Structure Context',
  rcsbDetailContextPolymer: 'Structure Detail Context',
  rcsbFocusPolymer: 'Active Focus',
  rcsbQueryPolymer: 'Query Polymer',
  rcsbDetailMemberPrefix: 'Detail Member: ',
  rcsbDetailChainPrefix: 'Detail Chain: ',
  rcsbDetailContextChainPrefix: 'Detail Context Chain: ',
} as const;

export function isQueryPolymerComponentLabel(label: string): boolean {
  return (
    label === STRUCTURE_COMPONENT_LABELS.polymer ||
    label === STRUCTURE_COMPONENT_LABELS.rcsbQueryPolymer ||
    isDetailMemberPolymerComponentLabel(label) ||
    isDetailChainPolymerComponentLabel(label)
  );
}

export function isContextPolymerComponentLabel(label: string): boolean {
  return (
    label === STRUCTURE_COMPONENT_LABELS.rcsbContextPolymer ||
    label === STRUCTURE_COMPONENT_LABELS.rcsbDetailContextPolymer ||
    isDetailContextChainPolymerComponentLabel(label)
  );
}

export function isFocusPolymerComponentLabel(label: string): boolean {
  return label === STRUCTURE_COMPONENT_LABELS.rcsbFocusPolymer;
}

export function isBroadPolymerComponentLabel(label: string): boolean {
  return (
    label === STRUCTURE_COMPONENT_LABELS.polymer ||
    label === STRUCTURE_COMPONENT_LABELS.rcsbQueryPolymer ||
    label === STRUCTURE_COMPONENT_LABELS.rcsbFocusPolymer ||
    label === STRUCTURE_COMPONENT_LABELS.rcsbContextPolymer
  );
}

export function detailMemberPolymerLabel(memberId: string): string {
  return `${STRUCTURE_COMPONENT_LABELS.rcsbDetailMemberPrefix}${memberId}`;
}

export function isDetailMemberPolymerComponentLabel(label: string): boolean {
  return label.startsWith(STRUCTURE_COMPONENT_LABELS.rcsbDetailMemberPrefix);
}

export function detailMemberIdFromComponentLabel(label: string): string | null {
  return isDetailMemberPolymerComponentLabel(label)
    ? label.slice(STRUCTURE_COMPONENT_LABELS.rcsbDetailMemberPrefix.length)
    : null;
}

export function detailChainPolymerLabel(chainTargetId: string): string {
  return `${STRUCTURE_COMPONENT_LABELS.rcsbDetailChainPrefix}${chainTargetId}`;
}

export function isDetailChainPolymerComponentLabel(label: string): boolean {
  return label.startsWith(STRUCTURE_COMPONENT_LABELS.rcsbDetailChainPrefix);
}

export function detailChainIdFromComponentLabel(label: string): string | null {
  return isDetailChainPolymerComponentLabel(label)
    ? label.slice(STRUCTURE_COMPONENT_LABELS.rcsbDetailChainPrefix.length)
    : null;
}

export function detailContextChainPolymerLabel(chainTargetId: string): string {
  return `${STRUCTURE_COMPONENT_LABELS.rcsbDetailContextChainPrefix}${chainTargetId}`;
}

export function isDetailContextChainPolymerComponentLabel(label: string): boolean {
  return label.startsWith(STRUCTURE_COMPONENT_LABELS.rcsbDetailContextChainPrefix);
}

export function detailContextChainIdFromComponentLabel(label: string): string | null {
  return isDetailContextChainPolymerComponentLabel(label)
    ? label.slice(STRUCTURE_COMPONENT_LABELS.rcsbDetailContextChainPrefix.length)
    : null;
}
