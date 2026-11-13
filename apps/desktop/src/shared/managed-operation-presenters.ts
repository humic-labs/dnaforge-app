import type {
  OperationCatalog,
  OperationRecordedArtifact,
  OperationSnapshot,
} from '@waypoint/api-client';

export type ManagedOperationReviewState =
  | 'not-required'
  | 'not-checked'
  | 'awaiting-review'
  | 'in-review'
  | 'applied'
  | 'dismissed'
  | 'blocked';

export interface ManagedOperationReviewProjection {
  readonly state: ManagedOperationReviewState;
  readonly reason?: string;
}

type OperationKindDescription = OperationCatalog['kinds'][number];

export type ManagedOperationKind = Extract<
  OperationKindDescription,
  { registration: 'executable' }
>['kind'];

export interface ManagedOperationPresenter {
  readonly title: (operation: OperationSnapshot) => string;
  readonly targetLabel: (operation: OperationSnapshot) => string | undefined;
  readonly review: (operation: OperationSnapshot) => ManagedOperationReviewProjection;
  readonly canOpenResult: (operation: OperationSnapshot) => boolean;
  readonly openResult: ((operation: OperationSnapshot) => Promise<void>) | null;
}

export type ManagedOperationPresenterRegistry = Readonly<
  Partial<Record<ManagedOperationKind, ManagedOperationPresenter>>
>;

export function registeredOperationPresenter(
  kind: string,
  registry: ManagedOperationPresenterRegistry
): ManagedOperationPresenter | undefined {
  return (registry as Readonly<Record<string, ManagedOperationPresenter>>)[kind];
}

export function operationKindTitle(
  kind: string,
  descriptor: OperationKindDescription | undefined
): string {
  if (descriptor?.title.trim()) return descriptor.title.trim();
  const label = kind.split(/[-_]/).filter(Boolean).join(' ');
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}` || 'Operation';
}

export function primaryRecordedInput(
  operation: OperationSnapshot
): OperationRecordedArtifact | undefined {
  const inputs = operation.provenance?.inputs ?? [];
  return inputs.find((artifact) => artifact.role === 'primary') ?? inputs[0];
}
