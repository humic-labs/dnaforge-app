export interface MetadataEditingCoordinator {
  activate: (session: { id: string; finish: () => void }) => void;
  finish: () => void;
  release: (id: string) => void;
}

export function createMetadataEditingCoordinator(): MetadataEditingCoordinator {
  let active: { id: string; finish: () => void } | null = null;
  return {
    activate(session) {
      if (active?.id === session.id) return;
      active?.finish();
      active = session;
    },
    finish() {
      active?.finish();
    },
    release(id) {
      if (active?.id === id) active = null;
    },
  };
}
