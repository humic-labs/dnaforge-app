export type HostedBackgroundPreparationState =
  | Readonly<{ status: 'idle' }>
  | Readonly<{ status: 'preparing'; label: string }>
  | Readonly<{ status: 'retrying'; label: string }>
  | Readonly<{ status: 'failed'; message: string }>;

export function indexedAnnotationBadgeType(match: {
  featureType?: string | null;
  annotation?: { type?: string | null } | null;
}): string {
  return match.featureType?.trim() || match.annotation?.type?.trim() || 'default';
}
