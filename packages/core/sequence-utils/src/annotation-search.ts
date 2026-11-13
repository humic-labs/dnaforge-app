import type { Annotation } from './types';
import { resolveFeaturesByName } from './feature-aliases';

export function searchAnnotations(annotations: Annotation[], query: string): Annotation[] {
  if (!query) return [];
  return resolveFeaturesByName(annotations, query).map((match) => match.feature);
}
