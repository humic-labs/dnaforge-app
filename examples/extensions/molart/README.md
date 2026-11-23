# MolArt Klimt protein extension

Build with `npm install && npm run build` in this directory, or run `node examples/extensions/molart/build.mjs` in a DNAForge checkout with dependencies installed. Open a protein in DNAForge, then choose **Advanced settings → View → Install protein extension…** and select `dist/klimt.dnaforge-extension.json`. Choose **MolArt · Klimt** in the View menu to apply it.

The files in `upstream/` come unmodified from [Martin Steinegger’s MolArt](https://github.com/martin-steinegger/molart/tree/712b984b42b51b314badd869155f0d1842e34822). The standalone worker uses MolArt’s PDB/mmCIF parser and ribbon builder with its original Klimt parameters. DNAForge draws that geometry in the existing Mol* viewer using MolArt’s original Klimt surface shader and lighting helpers. Mol* owns scene composition, depth and picking. MolArt’s separate ink compositing pass and optional geometry-deforming Art mode are outside this prototype.

The installable package includes MolArt’s MIT license and copyright notice.
