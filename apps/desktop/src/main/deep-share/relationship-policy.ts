import { DEEP_SHARE_RELATIONS, type DeepShareRelation } from '@waypoint/share-bundle';

const ALLOWED_RELATIONS = new Set<string>(DEEP_SHARE_RELATIONS);

export function isDeepShareRelation(value: string): value is DeepShareRelation {
  return ALLOWED_RELATIONS.has(value);
}
