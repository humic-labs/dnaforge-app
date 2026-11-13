export interface AssistantRouteCapabilities {
  inlineReferenceDeclarations: boolean;
  terminalReferenceFallbackSupported: boolean;
}

export type InlineReferenceAssistantRouteKind = 'provider' | 'hosted' | 'cli';

export const ASSISTANT_ROUTE_CAPABILITIES: Readonly<
  Record<InlineReferenceAssistantRouteKind, AssistantRouteCapabilities>
> = {
  provider: {
    inlineReferenceDeclarations: true,
    terminalReferenceFallbackSupported: true,
  },
  hosted: {
    inlineReferenceDeclarations: true,
    terminalReferenceFallbackSupported: false,
  },
  cli: {
    inlineReferenceDeclarations: true,
    terminalReferenceFallbackSupported: false,
  },
};
