import { app } from 'electron';

type AssociationPathRouter = (paths: readonly string[]) => void;
type ProtocolUrlRouter = (url: string) => void;

let associationPathRouter: AssociationPathRouter | null = null;
const earlyAssociationPaths: string[] = [];
let protocolUrlRouter: ProtocolUrlRouter | null = null;
const earlyProtocolUrls: string[] = [];

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (associationPathRouter) associationPathRouter([filePath]);
  else earlyAssociationPaths.push(filePath);
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  if (protocolUrlRouter) protocolUrlRouter(url);
  else earlyProtocolUrls.push(url);
});

export function installAssociationPathRouter(router: AssociationPathRouter): string[] {
  associationPathRouter = router;
  return earlyAssociationPaths.splice(0);
}

export function installProtocolUrlRouter(router: ProtocolUrlRouter): string[] {
  protocolUrlRouter = router;
  return earlyProtocolUrls.splice(0);
}
