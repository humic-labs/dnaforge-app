import { StructureSelection } from 'molstar/lib/mol-model/structure';
import { MolScriptBuilder as MS } from 'molstar/lib/mol-script/language/builder';
import { Script } from 'molstar/lib/mol-script/script';
import { PluginContext } from 'molstar/lib/mol-plugin/context';
import { DefaultPluginSpec } from 'molstar/lib/mol-plugin/spec';

type DefaultMolstarControl = {
  host: HTMLDivElement;
  plugin: PluginContext;
};

let activeControl: DefaultMolstarControl | null = null;

export type DefaultMolstarControlDiagnostics = {
  canvasTestId: string;
  antialiasing: unknown;
  transparency: unknown;
  markerAverage: number | null;
  renderObjectMarkerAverages: number[];
  selectionElementCount: number | null;
};

export async function disposeDefaultMolstarControl(): Promise<void> {
  const current = activeControl;
  activeControl = null;
  if (!current) return;
  current.plugin.dispose();
  current.host.remove();
}

export async function mountDefaultMolstarControl(
  pdb: string,
  chain: string,
  authSeqId: number
): Promise<DefaultMolstarControlDiagnostics> {
  await disposeDefaultMolstarControl();

  const host = document.createElement('div');
  host.dataset.testid = 'default-molstar-control';
  Object.assign(host.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    background: '#ffffff',
  });

  const canvas = document.createElement('canvas');
  canvas.dataset.testid = 'default-molstar-control-canvas';
  Object.assign(canvas.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
  });
  host.appendChild(canvas);
  document.body.appendChild(host);

  const plugin = new PluginContext(DefaultPluginSpec());
  activeControl = { host, plugin };
  await plugin.init();
  const initialized = await plugin.initViewerAsync(canvas, host);
  if (!initialized) {
    throw new Error('Raw default Mol* control failed to initialize');
  }

  const data = await plugin.builders.data.rawData(
    { data: pdb, label: 'Raw default Mol* control' },
    { state: { isGhost: true } }
  );
  const trajectory = await plugin.builders.structure.parseTrajectory(data, 'pdb');
  await plugin.builders.structure.hierarchy.applyPreset(trajectory, 'default');

  const structure = plugin.managers.structure.hierarchy.current.structures[0]?.cell?.obj?.data;
  if (!structure) {
    throw new Error('Raw default Mol* control did not create a structure');
  }
  const expression = MS.struct.generator.atomGroups({
    'chain-test': MS.core.rel.eq([MS.struct.atomProperty.macromolecular.auth_asym_id(), chain]),
    'residue-test': MS.core.rel.eq([
      MS.struct.atomProperty.macromolecular.auth_seq_id(),
      authSeqId,
    ]),
  });
  const selection = Script.getStructureSelection(expression, structure);
  const loci = StructureSelection.toLociWithSourceUnits(selection);
  plugin.managers.interactivity.lociSelects.select({ loci });
  plugin.managers.camera.focusLoci(loci, { durationMs: 0 });
  plugin.canvas3d?.requestDraw();
  plugin.canvas3d?.commit(true);

  const canvas3d = plugin.canvas3d as
    | (NonNullable<PluginContext['canvas3d']> & {
        scene?: {
          markerAverage?: number;
          renderObjects?: Array<{
            values?: { markerAverage?: { ref?: { value?: unknown } } };
          }>;
        };
      })
    | undefined;
  const renderObjectMarkerAverages =
    canvas3d?.scene?.renderObjects
      ?.map((renderObject) => renderObject.values?.markerAverage?.ref?.value)
      .filter((value): value is number => typeof value === 'number') ?? [];

  return {
    canvasTestId: 'default-molstar-control-canvas',
    antialiasing: canvas3d?.props?.postprocessing?.antialiasing ?? null,
    transparency: plugin.canvas3dContext?.props?.transparency ?? null,
    markerAverage:
      typeof canvas3d?.scene?.markerAverage === 'number' ? canvas3d.scene.markerAverage : null,
    renderObjectMarkerAverages,
    selectionElementCount:
      typeof plugin.managers.structure.selection.elementCount === 'function'
        ? plugin.managers.structure.selection.elementCount()
        : null,
  };
}
