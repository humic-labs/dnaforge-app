export const HOSTED_BROWSER_ASSERTION_ISSUER = 'https://dnaforge.com/hosted-browser';
export const HOSTED_BROWSER_ASSERTION_AUDIENCE = 'hosted-ai-browser';
export const HOSTED_BROWSER_ASSERTION_ALGORITHM = 'EdDSA';

export interface HostedBrowserAssertionClaims {
  readonly accountId: string;
  readonly browserSessionId: string;
  readonly tokenId: string;
}
