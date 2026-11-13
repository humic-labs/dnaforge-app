import { createServiceCallLogger, type ServiceCallLogger } from './service-call-logger';
import { platformFileOps, getLogFilePath } from './platform-file-ops';

let loggerInstance: ServiceCallLogger | null = null;
let logFilePath: string | null = null;

export async function getServiceLogger(): Promise<ServiceCallLogger> {
  if (!loggerInstance) {
    logFilePath = await getLogFilePath();
    loggerInstance = createServiceCallLogger({
      logFilePath,
      maxEntries: 50,
      fileOps: platformFileOps,
    });
  }
  return loggerInstance;
}
