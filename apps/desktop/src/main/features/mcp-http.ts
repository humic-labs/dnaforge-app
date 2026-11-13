import { app } from 'electron';
import { startExternalMcpRegistration } from '../external-mcp-registration';
import { getDb } from '../ipc/database';
import {
  mcpHttpAllowedHostsFile,
  mcpHttpInternalPort,
  startMcpHttpListener,
} from '../mcp-http-listener';

export function startMcpHttpServices(): void {
  startMcpHttpListener({
    allowed: app.isPackaged || process.env.WAYPOINT_TEST === '1',
    database: getDb,
    allowedHostsFile: mcpHttpAllowedHostsFile(),
    sidecarPort: mcpHttpInternalPort,
  });
  const stopExternalRegistration = startExternalMcpRegistration({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  });
  app.once('will-quit', stopExternalRegistration);
}
