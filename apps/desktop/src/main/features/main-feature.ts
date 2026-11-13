import type { BrowserWindow } from 'electron';
import type { AgentToolsBridgeServer } from '../agent-tools-bridge';
import type { SidecarSessionAuthority } from '../sidecar-session-authority';

export interface MainAgentToolsContext {
  readonly authority: SidecarSessionAuthority;
  readonly getApiUrl: () => string;
  readonly getBridge: () => AgentToolsBridgeServer | null;
  readonly startBridge: () => Promise<void>;
}

export interface MainFeatureContext {
  readonly getMainWindow: () => BrowserWindow | null;
}

export interface MainFeatureProfileContext {
  readonly isolated: boolean;
}

export interface MainProtocolRoute {
  readonly matches: (url: string) => boolean;
  readonly open: (url: string, context: MainFeatureContext) => void;
}

export interface MainFeatureShutdownStep {
  readonly name: string;
  readonly run: () => void | Promise<void>;
}

export interface MainProtocolUrlContext {
  readonly window: BrowserWindow | null;
  readonly activate: () => void;
}

export interface MainFeature {
  readonly id: string;
  readonly configureProfile?: (context: MainFeatureProfileContext) => void;
  readonly prepareProfile?: (profilePath: string) => void;
  readonly prepare?: (context: MainFeatureContext) => void | Promise<void>;
  readonly startAgentTools?: (context: MainAgentToolsContext) => Promise<void>;
  readonly registerIpc?: () => () => void;
  readonly onMainWindow?: (window: BrowserWindow, context: MainFeatureContext) => void;
  readonly onProtocolUrl?: (url: string, context: MainProtocolUrlContext) => boolean;
  readonly findProtocolUrlInArgv?: (argv: readonly string[]) => string | null;
  readonly protocolRoutes?: readonly MainProtocolRoute[];
  readonly onSignedIn?: (context: MainFeatureContext) => void;
  readonly willQuit?: () => void;
  readonly shutdown?: MainFeatureShutdownStep;
}
