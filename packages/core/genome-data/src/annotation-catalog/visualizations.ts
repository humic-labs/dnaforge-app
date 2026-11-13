import type { VisualizationId } from './ids';
import type { FeatureKind } from './records';

export interface AnnotationVisualizationDefinition {
  readonly id: VisualizationId;
  readonly label: string;
  readonly description: string;
  readonly accepts: readonly [FeatureKind, ...FeatureKind[]];
}

export interface AnnotationVisualizationCatalog {
  get(id: VisualizationId): AnnotationVisualizationDefinition | undefined;
  list(): readonly AnnotationVisualizationDefinition[];
  forKind(kind: FeatureKind): readonly AnnotationVisualizationDefinition[];
}

export function createAnnotationVisualizationCatalog(
  definitions: readonly AnnotationVisualizationDefinition[]
): AnnotationVisualizationCatalog {
  const byId = new Map<VisualizationId, AnnotationVisualizationDefinition>();
  for (const definition of definitions) {
    if (byId.has(definition.id)) {
      throw new Error(`Duplicate annotation visualization id "${definition.id}"`);
    }
    byId.set(definition.id, definition);
  }
  const ordered = Object.freeze([...definitions]);
  return {
    get: (id) => byId.get(id),
    list: () => ordered,
    forKind: (kind) => ordered.filter((d) => d.accepts.includes(kind)),
  };
}
