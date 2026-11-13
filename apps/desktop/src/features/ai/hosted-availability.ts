export const HOSTED_ASSISTANT_ROUTE_KIND = 'hosted';

const READY: string = 'ready';

const BLOCKED_BY_SIGN_IN: string = 'needs-login';

interface RouteOptionLike {
  readonly selection: { readonly kind: string };
}

interface RouteReadinessLike {
  readonly readiness: string;
}

export function selectHostedAssistantRouteOptions<T extends RouteOptionLike>(
  options: readonly T[]
): T[] {
  return options.filter((option) => option.selection.kind === HOSTED_ASSISTANT_ROUTE_KIND);
}

export function isHostedAssistantRouteAvailable(options: readonly RouteOptionLike[]): boolean {
  return selectHostedAssistantRouteOptions(options).length > 0;
}

export function isHostedRouteOptionReady(option: RouteReadinessLike): boolean {
  return option.readiness === READY;
}

export function isHostedRouteBlockedBySignIn(option: RouteReadinessLike): boolean {
  return option.readiness === BLOCKED_BY_SIGN_IN;
}
