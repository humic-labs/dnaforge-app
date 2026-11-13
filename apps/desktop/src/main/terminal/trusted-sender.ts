import { isTrustedRendererUrl } from '../security';

interface TerminalSender {
  sender: { mainFrame: { url: string }; isDestroyed(): boolean };
  senderFrame: { url: string } | null;
}

export function assertTerminalSender(event: TerminalSender, trustedUrl: string | null): void {
  if (
    !trustedUrl ||
    event.sender.isDestroyed() ||
    !event.senderFrame ||
    event.senderFrame !== event.sender.mainFrame ||
    !isTrustedRendererUrl(event.senderFrame.url, trustedUrl)
  ) {
    throw new Error('Terminal access requires the trusted application main frame.');
  }
}
