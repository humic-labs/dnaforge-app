import type { ResidueLocation } from '../types';

function stringAttr(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberDataAttr(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

export function residueFromContextMenuTarget(target: EventTarget | null): ResidueLocation | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest<HTMLElement>('[data-chain-id][data-position]');
  if (!element) return null;
  const position = Number(element.dataset.position);
  const chain = element.dataset.chainId;
  if (!chain || !Number.isInteger(position) || position < 1) return null;

  const labelSeqId = numberDataAttr(element.dataset.labelSeqId);
  const labelCompId = stringAttr(element.dataset.residueName3);
  const compId = stringAttr(element.dataset.compId);
  return {
    chain,
    position,
    ...(compId ? { compId } : {}),
    ...(labelCompId ? { labelCompId } : {}),
    ...(stringAttr(element.dataset.baseChain)
      ? { baseChain: stringAttr(element.dataset.baseChain) }
      : {}),
    ...(stringAttr(element.dataset.labelAsymId)
      ? { labelAsymId: stringAttr(element.dataset.labelAsymId) }
      : {}),
    ...(stringAttr(element.dataset.authAsymId)
      ? { authAsymId: stringAttr(element.dataset.authAsymId) }
      : {}),
    ...(stringAttr(element.dataset.entityId)
      ? { entityId: stringAttr(element.dataset.entityId) }
      : {}),
    ...(labelSeqId !== undefined ? { labelSeqId } : {}),
    ...(stringAttr(element.dataset.operator)
      ? { operator: stringAttr(element.dataset.operator) }
      : {}),
  };
}
