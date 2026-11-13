import type { CapabilityStatus, ComponentStatus, ToolboxStatusResponse } from './types';

const TOOL_METADATA: Record<string, { version: string; path: string }> = {
  blastn: { version: '2.13.0', path: '/usr/local/bin/blastn' },
  diamond: { version: '2.1.8', path: '/usr/local/bin/diamond' },
  cmscan: { version: '1.1.5', path: '/usr/local/bin/cmscan' },
  databases: { version: '2024.1', path: '/data/annotation-db' },
};

const TOOL_SIZES: Record<string, number> = {
  blastn: 45.0,
  diamond: 32.0,
  cmscan: 28.0,
  databases: 1200.0,
};

function readyComponent(id: string, overrides?: Partial<ComponentStatus>): ComponentStatus {
  const meta = TOOL_METADATA[id];
  return {
    id,
    label: id,
    status: 'ready',
    source: 'downloaded',
    ...(meta ? { version: meta.version, path: meta.path } : {}),
    ...overrides,
  };
}

function downloadingComponent(
  id: string,
  percent = 0,
  overrides?: Partial<ComponentStatus>
): ComponentStatus {
  return {
    id,
    label: id,
    status: 'downloading',
    source: 'downloaded',
    progress: { phase: 'downloading', percent, detail: '' },
    size_mb: TOOL_SIZES[id],
    ...overrides,
  };
}

function errorComponent(id: string, overrides?: Partial<ComponentStatus>): ComponentStatus {
  return { id, label: id, status: 'error', source: 'downloaded', ...overrides };
}

function unavailableComponent(id: string, overrides?: Partial<ComponentStatus>): ComponentStatus {
  return {
    id,
    label: id,
    status: 'unavailable',
    source: 'downloaded',
    ...overrides,
  };
}

const ANNOTATION_TOOLS = ['blastn', 'diamond', 'cmscan'] as const;

export function deriveStatus(components: ComponentStatus[]): CapabilityStatus['status'] {
  if (components.length === 0) return 'unavailable';
  const statuses = components.map((c) => c.status);
  if (statuses.every((s) => s === 'ready')) return 'ready';
  if (statuses.some((s) => s === 'downloading')) return 'downloading';
  if (statuses.some((s) => s === 'error')) return 'error';
  return 'unavailable';
}

function annotationCapability(
  toolStatus: ComponentStatus['status'],
  dbStatus: ComponentStatus['status'],
  toolPct = 0,
  dbPct = 0
): CapabilityStatus {
  const factory = {
    ready: (id: string) => readyComponent(id),
    downloading: (id: string) => downloadingComponent(id, toolPct),
    error: (id: string) => errorComponent(id),
    unavailable: (id: string) => unavailableComponent(id),
  };
  const dbFactory = {
    ready: (id: string) => readyComponent(id, { label: 'Annotation Databases' }),
    downloading: (id: string) => downloadingComponent(id, dbPct, { label: 'Annotation Databases' }),
    error: (id: string) => errorComponent(id, { label: 'Annotation Databases' }),
    unavailable: (id: string) => unavailableComponent(id, { label: 'Annotation Databases' }),
  };

  const components = [
    ...ANNOTATION_TOOLS.map((t) => factory[toolStatus](t)),
    dbFactory[dbStatus]('databases'),
  ];

  return {
    id: 'annotation',
    label: 'Annotation Engine',
    status: deriveStatus(components),
    source: 'builtin',
    tier: 'base',
    auto_install: true,
    components,
  };
}

function builtinCapabilities(mafftReady = true): CapabilityStatus[] {
  return [
    {
      id: 'alignment',
      label: 'Sequence Alignment',
      status: mafftReady ? 'ready' : 'unavailable',
      source: 'builtin',
      tier: 'base',
      auto_install: true,
      components: [
        mafftReady
          ? readyComponent('mafft', { label: 'MAFFT', source: 'system' })
          : unavailableComponent('mafft', { label: 'MAFFT', source: 'system' }),
      ],
    },
    {
      id: 'primer_design',
      label: 'Primer Design',
      status: 'ready',
      source: 'builtin',
      tier: 'base',
      auto_install: true,
      components: [readyComponent('primer3', { label: 'Primer3', source: 'builtin' })],
    },
    {
      id: 'restriction_analysis',
      label: 'Restriction Analysis',
      status: 'ready',
      source: 'builtin',
      tier: 'base',
      auto_install: true,
      components: [
        readyComponent('restriction-sites', {
          label: 'Built-in restriction engine',
          source: 'builtin',
        }),
      ],
    },
  ];
}

export const sidecarScenarios = {
  freshInstall: (): ToolboxStatusResponse => ({
    capabilities: [
      annotationCapability('unavailable', 'unavailable'),
      ...builtinCapabilities(false),
    ],
  }),

  downloadingTools: (percent = 0): ToolboxStatusResponse => ({
    capabilities: [
      annotationCapability('downloading', 'unavailable', percent),
      ...builtinCapabilities(),
    ],
  }),

  downloadingDatabases: (percent = 0): ToolboxStatusResponse => ({
    capabilities: [
      annotationCapability('ready', 'downloading', 0, percent),
      ...builtinCapabilities(),
    ],
  }),

  downloadingAll: (toolPct = 0, dbPct = 0): ToolboxStatusResponse => ({
    capabilities: [
      annotationCapability('downloading', 'downloading', toolPct, dbPct),
      ...builtinCapabilities(),
    ],
  }),

  fullyReady: (): ToolboxStatusResponse => ({
    capabilities: [annotationCapability('ready', 'ready'), ...builtinCapabilities()],
  }),

  toolsError: (): ToolboxStatusResponse => ({
    capabilities: [annotationCapability('error', 'unavailable'), ...builtinCapabilities()],
  }),

  partialReady: (readyTools: string[]): ToolboxStatusResponse => {
    const components = ANNOTATION_TOOLS.map((t) =>
      readyTools.includes(t) ? readyComponent(t) : unavailableComponent(t)
    );
    const dbReady =
      ANNOTATION_TOOLS.every((t) => readyTools.includes(t)) && readyTools.includes('databases');
    components.push(
      dbReady
        ? readyComponent('databases', { label: 'Annotation Databases' })
        : unavailableComponent('databases', { label: 'Annotation Databases' })
    );

    return {
      capabilities: [
        {
          id: 'annotation',
          label: 'Annotation Engine',
          status: deriveStatus(components),
          source: 'builtin',
          tier: 'base',
          auto_install: true,
          components,
        },
        ...builtinCapabilities(),
      ],
    };
  },

  mixedComponentStatus: (): ToolboxStatusResponse => {
    const components: ComponentStatus[] = [
      readyComponent('blastn'),
      downloadingComponent('diamond', 45),
      unavailableComponent('cmscan'),
      unavailableComponent('databases', { label: 'Annotation Databases' }),
    ];
    return {
      capabilities: [
        {
          id: 'annotation',
          label: 'Annotation Engine',
          status: deriveStatus(components),
          source: 'builtin',
          tier: 'base',
          auto_install: true,
          components,
        },
        ...builtinCapabilities(),
      ],
    };
  },
} as const;

export function withMafft(scenario: ToolboxStatusResponse): ToolboxStatusResponse {
  return {
    capabilities: scenario.capabilities.map((cap) =>
      cap.id === 'alignment'
        ? {
            ...cap,
            status: 'ready' as const,
            components: [readyComponent('mafft', { label: 'MAFFT', source: 'system' })],
          }
        : cap
    ),
  };
}

export function withPlugin(
  scenario: ToolboxStatusResponse,
  pluginId: string,
  opts: { label?: string; status?: ComponentStatus['status']; url?: string } = {}
): ToolboxStatusResponse {
  const { label = pluginId, status = 'ready', url = 'http://localhost:9000' } = opts;
  return {
    capabilities: [
      ...scenario.capabilities,
      {
        id: pluginId,
        label,
        status,
        source: 'plugin',
        tier: 'optional',
        auto_install: false,
        components: [{ id: pluginId, label, status, source: 'plugin', path: url }],
      },
    ],
  };
}
