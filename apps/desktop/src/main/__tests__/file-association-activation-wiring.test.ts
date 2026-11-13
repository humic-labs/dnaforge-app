import { readFileSync } from 'node:fs';
import path from 'node:path';

const desktopRoot = path.resolve(__dirname, '../../..');
const mainSource = readFileSync(path.join(desktopRoot, 'src/main/index.ts'), 'utf8');
const featureSource = readFileSync(
  path.join(desktopRoot, 'src/main/features/file-associations.ts'),
  'utf8'
);
const bootstrapSource = readFileSync(path.join(desktopRoot, 'src/main/bootstrap.ts'), 'utf8');
const earlyAssociationSource = readFileSync(
  path.join(desktopRoot, 'src/main/early-file-association.ts'),
  'utf8'
);
const preloadSource = readFileSync(path.join(desktopRoot, 'src/preload/index.ts'), 'utf8');
const contractSource = readFileSync(
  path.join(desktopRoot, 'src/shared/ipc/file-associations.contract.ts'),
  'utf8'
);

describe(' activation wiring', () => {
  it('loads the native event buffer before the heavyweight startup graph', () => {
    expect(
      mainSource.startsWith(
        "import { installAssociationPathRouter, installProtocolUrlRouter } from './early-file-association';"
      )
    ).toBe(true);
    const backgroundCwdImport = mainSource.indexOf("import './background-launch-cwd';");
    expect(backgroundCwdImport).toBeGreaterThan(0);
    expect(backgroundCwdImport).toBeLessThan(mainSource.indexOf("from './ipc/shell-readiness';"));
    expect(bootstrapSource.startsWith("import './early-file-association';")).toBe(true);
    expect(earlyAssociationSource).toContain("app.on('open-file'");
    expect(earlyAssociationSource).toContain('earlyAssociationPaths.push');
    expect(earlyAssociationSource).toContain("app.on('open-url'");
    expect(earlyAssociationSource).toContain('earlyProtocolUrls.push');
    expect(mainSource).toContain('installAssociationPathRouter(routeAssociationPaths)');
    expect(mainSource).toContain('installProtocolUrlRouter(routeProtocolUrl)');
  });

  it('captures cold argv and warm second-instance argv with its working directory', () => {
    expect(mainSource).toContain(
      'const startupAssociationPaths = extractAssociationPathsFromArgv(process.argv, process.cwd())'
    );
    expect(mainSource).toContain('routeAssociationPaths(startupAssociationPaths)');
    expect(mainSource).toMatch(
      /const startupProtocolUrl =[^;]*\bfindCallbackUrlInArgv\(process\.argv\)/
    );
    expect(mainSource).toContain('if (startupProtocolUrl) routeProtocolUrl(startupProtocolUrl)');
    expect(mainSource).toMatch(
      /app\.on\('second-instance',[\s\S]*extractAssociationPathsFromArgv\(argv, workingDirectory\)/
    );
  });

  it('uses a renderer-ready take/drain invocation and a typed later-event subscription', () => {
    expect(featureSource).toContain(
      'takePendingAndMarkReady: () => activationQueue.takePendingAndMarkReady()'
    );
    expect(mainSource).toContain('fileAssociations.activationQueue.enqueue(paths)');
    expect(preloadSource).toContain('fileAssociations: createClient(fileAssociationsContract)');
    expect(contractSource).toContain(
      'takePendingActivations: invoke<[], FileActivationDelivery[]>()'
    );
    expect(contractSource).toMatch(
      /onOpenFiles: event<\[deliveries: FileActivationDelivery\[\]\]>\(\)\.channel\(\s*'file-association:open-files'\s*\)/
    );
  });

  it('exposes effective-handler query and explicit default-request IPC', () => {
    expect(contractSource).toContain('queryHandlers: invoke<[], FileAssociationHandlerStatus[]>()');
    expect(contractSource).toMatch(
      /requestDefault: invoke<\s*\[familyId: FileAssociationFamilyId\]/
    );
    expect(featureSource).toContain('defaultHandler: createDefaultHandlerService(');
    expect(featureSource).toMatch(/takePendingAndMarkReady[^\n]*\n\s*defaultHandler,/);
  });

  it('runs package recovery before destination-workspace cleanup during startup', () => {
    const quickLookRecovery = mainSource.indexOf('await fileAssociations.recoverPromotions();');
    const packageRecovery = featureSource.indexOf(
      'await recoverQuickLookPackagePromotions(promotionJournalRoot'
    );
    const workspaceRecovery = featureSource.indexOf(
      'await recoverQuickLookDestinationWorkspaces({'
    );
    const replicaRecovery = mainSource.indexOf(
      'await workspaceSync.recoverReplicaPullsBeforeRenderer()'
    );
    const trashPurge = mainSource.indexOf(
      'await purgeExpiredTrashedWorkspaces(getDb(), managedRootDir())'
    );

    expect(quickLookRecovery).toBeGreaterThan(replicaRecovery);
    expect(trashPurge).toBeGreaterThan(quickLookRecovery);
    expect(packageRecovery).toBeGreaterThan(-1);
    expect(workspaceRecovery).toBeGreaterThan(packageRecovery);
  });
});
