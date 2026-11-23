# Local protein representation extensions

The desktop prototype accepts a local JSON package from **Advanced settings → View → Install protein extension** in an open structure viewer. Installing applies the package to the current view. Use the same menu to switch back to a built-in drawing or uninstall the active extension. The [MolArt example](./molart/) builds a package independently of the Electron app.

## Package format

| Field | Meaning |
| --- | --- |
| `schemaVersion` | The integer `1`. |
| `kind` | `protein-representation`. |
| `id` | A stable dotted name such as `org.molart.klimt`. Components start with a lowercase letter and may include digits and hyphens. Installing a package with the same ID replaces its local copy. |
| `label` | The name shown in the viewer. |
| `workerSource` | Self-contained JavaScript for a classic Web Worker. Bundle dependencies and include applicable license notices. |

## Drawing and interaction

The worker receives one message containing `{ text, filename }` for the current text PDB or mmCIF coordinate source. Return `{ ok: true, result }` or `{ ok: false, error }`. The host ends the worker after the request. The current adapter accepts indexed triangle geometry for a ribbon. Positions, normals and tangents each occupy three floating-point values per vertex. The `surf`, `phys` and `info` buffers each contain four values per vertex. They describe the ribbon surface, its physical coordinates and its chain/residue mapping. Indices use a `Uint32Array`. See the [worker](./molart/worker.ts) and [ribbon data definition](./molart/upstream/src/geometry/ribbon.ts) for the exact layout.

The result supplies the shader helpers and `shadeSurface` implementation as GLSL strings, and a residue table containing author chain ID, residue number, insertion code and residue name. DNAForge registers the mesh in the existing Mol* canvas and uses that residue table to resolve native picks. The host owns the camera and the depth buffer. The prototype accepts **trusted local packages**. The isolated worker produces geometry, and its shader runs on the GPU used by the viewer.

## Saved state

Installation and the chosen representation are local to the desktop profile. Reopening the same view can restore its style. Switch to a built-in view to export a portable molecular scene. The prototype records no extension code in a shared molecular document.
