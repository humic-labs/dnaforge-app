import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  portableToolSchema,
  wrapRendererOutputSchema,
  rendererInputSchema,
} from '../src/features/agent-bridge/tool-json-schema';
import { JSDOM } from 'jsdom';
import { format, resolveConfig } from 'prettier';
import type { RendererToolDefinition } from '../src/features/agent-bridge/renderer-tools';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(
  scriptDir,
  '../../../packages/core/agent-tools/renderer-tool-manifest.json'
);

function installDomGlobals(): void {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
  });
  const window = dom.window;
  window.HTMLCanvasElement.prototype.getContext = () =>
    ({
      fillStyle: '',
      globalCompositeOperation: 'source-over',
      fillRect: () => undefined,
      getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 0]) }),
    }) as unknown as CanvasRenderingContext2D;
  Object.assign(globalThis, {
    window,
    document: window.document,
    location: window.location,
    history: window.history,
    HTMLElement: window.HTMLElement,
    HTMLCanvasElement: window.HTMLCanvasElement,
    XMLHttpRequest: window.XMLHttpRequest,
    FormData: window.FormData,
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
  });
}

function stableManifest(
  catalog: Readonly<Record<string, RendererToolDefinition>>
): Record<string, unknown> {
  const definitions = Object.values(catalog);
  const providerToolNames = Object.fromEntries(
    definitions.flatMap((definition) =>
      definition.providerAlias ? [[definition.name, definition.providerAlias]] : []
    )
  );
  const historyTools = Object.fromEntries(
    definitions.flatMap((definition) =>
      definition.historyPresentation ? [[definition.name, definition.historyPresentation]] : []
    )
  );
  return {
    schemaVersion: 1,
    providerToolNames,
    historyPolicy: {
      defaultMode: 'inspect-only',
      tools: historyTools,
    },
    tools: definitions.map((definition) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: rendererInputSchema(definition),
      outputSchema: wrapRendererOutputSchema(portableToolSchema(definition.outputSchema)),
      shape: definition.shape,
      effects: [...definition.effects],
      required_capabilities: [...definition.required_capabilities],
      audit_required: definition.audit_required,
      ...(definition.conditional_required_capabilities.length > 0
        ? {
            conditional_required_capabilities: [...definition.conditional_required_capabilities],
          }
        : {}),
      requiresWorkspace: definition.requiresWorkspace,
      ...(definition.conditionallyRequiresWorkspace
        ? { conditionallyRequiresWorkspace: true }
        : {}),
      ...(definition.emptyInputReason ? { emptyInputReason: definition.emptyInputReason } : {}),
      ...(definition.workspaceGrounding
        ? { workspaceGrounding: definition.workspaceGrounding }
        : {}),
      ...(definition.mcpAnnotations ? { mcpAnnotations: definition.mcpAnnotations } : {}),
      ...(definition.sidecarOrchestrated ? { sidecarOrchestrated: true } : {}),
      exposure: definition.exposure,
    })),
  };
}

installDomGlobals();
const { ALLOWED_RENDERER_TOOLS, rendererToolSdkInputSchema } =
  await import('../src/features/agent-bridge/renderer-tools');
const prettierConfig = (await resolveConfig(manifestPath)) ?? {};
const generated = await format(JSON.stringify(stableManifest(ALLOWED_RENDERER_TOOLS)), {
  ...prettierConfig,
  filepath: manifestPath,
});
const checkOnly = process.argv.includes('--check');

if (checkOnly) {
  const current = await readFile(manifestPath, 'utf8');
  if (current !== generated) {
    console.error('renderer-tool-manifest.json is stale. Run `pnpm agent-tools:generate`.');
    process.exitCode = 1;
  } else {
    console.log('renderer-tool-manifest.json is current.');
  }
} else {
  await writeFile(manifestPath, generated);
  console.log(`Generated ${Object.keys(ALLOWED_RENDERER_TOOLS).length} renderer tools.`);
}
