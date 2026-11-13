import type {
  DeepShareArtifactType,
  DeepShareManifestArtifact,
  DeepShareOmission,
  DeepShareRelationshipV1,
} from '@waypoint/share-bundle';
import { isDeepShareRelation } from './relationship-policy';

export interface DeepShareClosureEntity {
  id: string;
  type: DeepShareArtifactType;
  name: string;
}

export interface DeepShareClosureLink {
  sourceArtifactId: string;
  relation: string;
  targetArtifactId: string;
  confidence: 'suggested' | 'confirmed' | 'rejected';
}

export interface DeepShareArtifactClosureInput {
  rootArtifactId: string;
  entities: readonly DeepShareClosureEntity[];
  links: readonly DeepShareClosureLink[];
}

export interface DeepShareArtifactClosure {
  rootArtifactId: string;
  artifacts: DeepShareManifestArtifact[];
  relationships: DeepShareRelationshipV1[];
  omissions: DeepShareOmission[];
}

export type DeepShareClosureErrorCode = 'ROOT_NOT_FOUND' | 'DUPLICATE_ENTITY';

export class DeepShareClosureError extends Error {
  constructor(
    readonly code: DeepShareClosureErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'DeepShareClosureError';
  }
}

export function buildDeepShareArtifactClosure(
  input: DeepShareArtifactClosureInput
): DeepShareArtifactClosure {
  const entities = new Map<string, DeepShareClosureEntity>();
  for (const entity of input.entities) {
    if (entities.has(entity.id)) {
      throw new DeepShareClosureError(
        'DUPLICATE_ENTITY',
        `Deep Share catalog entity is duplicated: ${entity.id}`
      );
    }
    entities.set(entity.id, entity);
  }
  if (!entities.has(input.rootArtifactId)) {
    throw new DeepShareClosureError('ROOT_NOT_FOUND', 'Deep Share root was not found.');
  }

  const links = [...input.links].sort((left, right) => linkKey(left).localeCompare(linkKey(right)));
  const included = new Set<string>([input.rootArtifactId]);
  const queue = [input.rootArtifactId];
  const relationships = new Map<string, DeepShareRelationshipV1>();
  const omissions = new Map<string, DeepShareOmission>();

  while (queue.length > 0) {
    const currentId = queue.shift();
    if (!currentId) continue;

    for (const link of links) {
      const otherId = linkedArtifactId(link, currentId);
      if (!otherId) continue;

      if (!isDeepShareRelation(link.relation)) {
        addOmission(omissions, {
          code: 'UNSUPPORTED_RELATION',
          subject: link.relation,
          detail: `Relation ${link.relation} is not portable and was not followed.`,
        });
        continue;
      }
      if (link.confidence !== 'confirmed') {
        addOmission(omissions, {
          code: 'UNCONFIRMED_RELATION',
          subject: otherId,
          detail: `${link.relation} is ${link.confidence} and was not followed.`,
        });
        continue;
      }
      if (!entities.has(otherId)) {
        addOmission(omissions, {
          code: 'UNRESOLVED_TARGET',
          subject: otherId,
          detail: `${link.relation} points to an artifact that is not in the workspace catalog.`,
        });
        continue;
      }

      relationships.set(linkKey(link), {
        sourceArtifactId: link.sourceArtifactId,
        relation: link.relation,
        targetArtifactId: link.targetArtifactId,
      });
      if (!included.has(otherId)) {
        included.add(otherId);
        queue.push(otherId);
      }
    }
  }

  const artifacts = [...included]
    .map((id) => entities.get(id))
    .filter((entity): entity is DeepShareClosureEntity => entity !== undefined)
    .map((entity) => ({
      id: entity.id,
      type: entity.type,
      name: entity.name,
      required: entity.id === input.rootArtifactId,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    rootArtifactId: input.rootArtifactId,
    artifacts,
    relationships: [...relationships.values()].sort((left, right) =>
      linkKey(left).localeCompare(linkKey(right))
    ),
    omissions: [...omissions.values()].sort((left, right) =>
      omissionKey(left).localeCompare(omissionKey(right))
    ),
  };
}

function linkedArtifactId(link: DeepShareClosureLink, currentId: string): string | null {
  if (link.sourceArtifactId === currentId) return link.targetArtifactId;
  if (link.targetArtifactId === currentId) return link.sourceArtifactId;
  return null;
}

function linkKey(link: {
  sourceArtifactId: string;
  relation: string;
  targetArtifactId: string;
}): string {
  return `${link.sourceArtifactId}\u0000${link.relation}\u0000${link.targetArtifactId}`;
}

function addOmission(omissions: Map<string, DeepShareOmission>, omission: DeepShareOmission): void {
  omissions.set(omissionKey(omission), omission);
}

function omissionKey(omission: DeepShareOmission): string {
  return `${omission.code}\u0000${omission.subject}\u0000${omission.detail}`;
}
