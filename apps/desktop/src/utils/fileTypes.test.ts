// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  getExtension,
  getFilename,
  getTabTypeForFile,
  getFileIconCategory,
  isBiologyFile,
  isImageFile,
  isTextFile,
  isHtmlFile,
  isTabularDataFile,
  isBinaryContent,
  getLanguageForFile,
  getFileBrowserDisplayName,
  getStructureFileFormat,
  isStructureFile,
  stripDisplayExtension,
} from './fileTypes';

describe('stripDisplayExtension', () => {
  it('hides structure coordinate extensions ', () => {
    expect(stripDisplayExtension('1FS0.pdb')).toBe('1FS0');
    expect(stripDisplayExtension('1FS0.cif')).toBe('1FS0');
    expect(stripDisplayExtension('1FS0.bcif')).toBe('1FS0');
  });
  it('hides a single extension', () => {
    expect(stripDisplayExtension('pUC19.gb')).toBe('pUC19');
    expect(stripDisplayExtension('reads.fastq')).toBe('reads');
    expect(stripDisplayExtension('data.csv')).toBe('data');
  });
  it('hides a compound DNAForge-artifact extension whole', () => {
    expect(stripDisplayExtension('assembly.wpdesign.json')).toBe('assembly');
    expect(stripDisplayExtension('notes.wpnote.json')).toBe('notes');
    expect(stripDisplayExtension('qPCR_F1.primer.json')).toBe('qPCR_F1');
  });
  it('leaves extensionless names and titles untouched', () => {
    expect(stripDisplayExtension('Chat')).toBe('Chat');
    expect(stripDisplayExtension('EGFP subcloning into pUC19')).toBe('EGFP subcloning into pUC19');
  });
  it('only strips the final extension (an inner dot is preserved)', () => {
    expect(stripDisplayExtension('My notes v2.1.gb')).toBe('My notes v2.1');
  });
  it('does not strip a leading-dot dotfile name', () => {
    expect(stripDisplayExtension('.gitignore')).toBe('.gitignore');
  });
  it('does NOT strip a dotted segment that is not a recognized file extension (entity names)', () => {
    expect(stripDisplayExtension('E. coli MG1655')).toBe('E. coli MG1655');
    expect(stripDisplayExtension('Construct v2.1')).toBe('Construct v2.1');
    expect(stripDisplayExtension('pENTR L1-mScarlet-L2')).toBe('pENTR L1-mScarlet-L2');
  });
  it('does not strip a trailing dot (no extension, matches getExtension)', () => {
    expect(stripDisplayExtension('sample.')).toBe('sample.');
  });
  it('still strips a recognized extension even when the stem contains dots', () => {
    expect(stripDisplayExtension('My notes v2.1.gb')).toBe('My notes v2.1');
    expect(stripDisplayExtension('backup.tar.gz')).toBe('backup.tar');
  });
});

describe('getExtension', () => {
  it('extracts extension from simple filename', () => {
    expect(getExtension('file.txt')).toBe('txt');
    expect(getExtension('document.pdf')).toBe('pdf');
  });

  it('extracts extension from path with directories', () => {
    expect(getExtension('/path/to/file.txt')).toBe('txt');
    expect(getExtension('/Users/lab/sequences/plasmid.gb')).toBe('gb');
  });

  it('returns lowercase extension', () => {
    expect(getExtension('FILE.TXT')).toBe('txt');
    expect(getExtension('Document.PDF')).toBe('pdf');
    expect(getExtension('Sequence.FASTA')).toBe('fasta');
  });

  it('returns null for files without extension', () => {
    expect(getExtension('Makefile')).toBe(null);
    expect(getExtension('README')).toBe(null);
    expect(getExtension('/path/to/Dockerfile')).toBe(null);
  });

  it('returns null for dotfiles without extension', () => {
    expect(getExtension('.gitignore')).toBe(null);
    expect(getExtension('.env')).toBe(null);
    expect(getExtension('/path/.hidden')).toBe(null);
  });

  it('returns null for files ending with dot', () => {
    expect(getExtension('file.')).toBe(null);
    expect(getExtension('/path/to/file.')).toBe(null);
  });

  it('handles multiple dots correctly', () => {
    expect(getExtension('file.test.ts')).toBe('ts');
    expect(getExtension('archive.tar.gz')).toBe('gz');
    expect(getExtension('component.spec.tsx')).toBe('tsx');
  });

  it('handles empty string', () => {
    expect(getExtension('')).toBe(null);
  });
});

describe('getFilename', () => {
  it('extracts filename from path', () => {
    expect(getFilename('/path/to/file.txt')).toBe('file.txt');
    expect(getFilename('/Users/lab/sequences/plasmid.gb')).toBe('plasmid.gb');
  });

  it('returns filename when no path', () => {
    expect(getFilename('file.txt')).toBe('file.txt');
    expect(getFilename('Makefile')).toBe('Makefile');
  });

  it('handles trailing slash', () => {
    expect(getFilename('/path/to/')).toBe('');
  });

  it('returns original for empty string', () => {
    expect(getFilename('')).toBe('');
  });
});

describe('getTabTypeForFile', () => {
  describe('workspace artifacts', () => {
    it('returns entity tab types for DNAForge artifact sidecars and notebook packages', () => {
      expect(getTabTypeForFile('Untitled.wpnote.json')).toBe('page');
      expect(getTabTypeForFile('/lab/Lab notes/.forge/notebook.json')).toBe('page');
      expect(getTabTypeForFile('/lab/PCR/.forge/protocol.json')).toBe('scientific-document');
      expect(getTabTypeForFile('/lab/PCR run/.forge/protocol-run.json')).toBe(
        'scientific-document'
      );
      expect(getTabTypeForFile('/lab/New Design.wpdesign.json')).toBe('design');
      expect(getTabTypeForFile('/lab/oligos/qPCR_F1.primer.json')).toBe('primer');
    });
  });

  describe('sequence files', () => {
    it('returns sequence for GenBank files', () => {
      expect(getTabTypeForFile('plasmid.gb')).toBe('sequence');
      expect(getTabTypeForFile('plasmid.gbk')).toBe('sequence');
      expect(getTabTypeForFile('chromosome.gbff')).toBe('sequence');
      expect(getTabTypeForFile('plasmid.genbank')).toBe('sequence');
    });

    it('returns sequence for FASTA files', () => {
      expect(getTabTypeForFile('sequence.fasta')).toBe('sequence');
      expect(getTabTypeForFile('sequence.fa')).toBe('sequence');
      expect(getTabTypeForFile('sequence.fas')).toBe('sequence');
      expect(getTabTypeForFile('sequence.fna')).toBe('sequence');
      expect(getTabTypeForFile('sequence.ffn')).toBe('sequence');
      expect(getTabTypeForFile('sequence.faa')).toBe('protein');
    });

    it('uses the native protein view for every amino-acid FASTA', () => {
      expect(getTabTypeForFile('/lab/Benchling Imports/Proteins/GFP.faa')).toBe('protein');
      expect(getTabTypeForFile('/lab/proteins/GFP.faa')).toBe('protein');
    });

    it('returns sequence for other biology formats', () => {
      expect(getTabTypeForFile('sequence.seq')).toBe('sequence');
      expect(getTabTypeForFile('trace.ab1')).toBe('sequence');
      expect(getTabTypeForFile('trace.abi')).toBe('sequence');
      expect(getTabTypeForFile('construct.dna')).toBe('sequence');
    });
  });

  describe('PDF files', () => {
    it('opens PDFs in the literal PDF reader', () => {
      expect(getTabTypeForFile('paper.pdf')).toBe('pdf');
      expect(getTabTypeForFile('/lab/Papers/METHODS.PDF')).toBe('pdf');
    });
  });

  describe('standalone structure files', () => {
    it('routes legacy PDB, PDBx/mmCIF, and BinaryCIF to the structure viewer', () => {
      for (const path of [
        '1FS0.pdb',
        '1FS0.cif',
        '1FS0.mmcif',
        '1FS0.mcif',
        '1FS0.bcif',
        '/lab/structures/COMPLEX.PDB',
      ]) {
        expect(getTabTypeForFile(path)).toBe('structure');
      }
    });

    it('does not broaden routing to related but unsupported formats', () => {
      expect(getTabTypeForFile('docking.pdbqt')).toBe('text');
      expect(getTabTypeForFile('trajectory.xtc')).toBe('text');
      expect(getTabTypeForFile('density.map')).toBe('text');
      expect(getTabTypeForFile('1FS0.cif.gz')).toBe('text');
    });
  });

  describe('image files', () => {
    it('returns image for common image formats', () => {
      expect(getTabTypeForFile('photo.png')).toBe('image');
      expect(getTabTypeForFile('photo.jpg')).toBe('image');
      expect(getTabTypeForFile('photo.jpeg')).toBe('image');
      expect(getTabTypeForFile('animation.gif')).toBe('image');
      expect(getTabTypeForFile('icon.svg')).toBe('image');
      expect(getTabTypeForFile('image.webp')).toBe('image');
      expect(getTabTypeForFile('image.bmp')).toBe('image');
      expect(getTabTypeForFile('favicon.ico')).toBe('image');
    });

    it('returns image for scientific imaging formats', () => {
      expect(getTabTypeForFile('gel.tiff')).toBe('image');
      expect(getTabTypeForFile('microscopy.tif')).toBe('image');
    });
  });

  describe('text files', () => {
    it('returns text for plain text files', () => {
      expect(getTabTypeForFile('notes.txt')).toBe('text');
      expect(getTabTypeForFile('output.log')).toBe('text');
    });

    it('returns text for markdown files', () => {
      expect(getTabTypeForFile('README.md')).toBe('text');
      expect(getTabTypeForFile('docs.markdown')).toBe('text');
    });

    it('returns text for data formats', () => {
      expect(getTabTypeForFile('config.json')).toBe('text');
      expect(getTabTypeForFile('config.yaml')).toBe('text');
      expect(getTabTypeForFile('config.yml')).toBe('text');
      expect(getTabTypeForFile('config.toml')).toBe('text');
      expect(getTabTypeForFile('data.xml')).toBe('text');
    });

    it('returns table for CSV and TSV files', () => {
      expect(getTabTypeForFile('data.csv')).toBe('table');
      expect(getTabTypeForFile('data.tsv')).toBe('table');
      expect(getTabTypeForFile('/lab/results/Sample Sheet.CSV')).toBe('table');
    });

    it('returns text for programming languages', () => {
      expect(getTabTypeForFile('script.py')).toBe('text');
      expect(getTabTypeForFile('app.js')).toBe('text');
      expect(getTabTypeForFile('app.ts')).toBe('text');
      expect(getTabTypeForFile('component.tsx')).toBe('text');
      expect(getTabTypeForFile('component.jsx')).toBe('text');
      expect(getTabTypeForFile('main.rs')).toBe('text');
      expect(getTabTypeForFile('main.go')).toBe('text');
    });

    it('returns text for shell scripts', () => {
      expect(getTabTypeForFile('script.sh')).toBe('text');
      expect(getTabTypeForFile('script.bash')).toBe('text');
      expect(getTabTypeForFile('script.zsh')).toBe('text');
    });

    it('returns html for HTML files  — rendered in a sandboxed viewer)', () => {
      expect(getTabTypeForFile('index.html')).toBe('html');
      expect(getTabTypeForFile('report.htm')).toBe('html');
      expect(getTabTypeForFile('/lab/results/QC Report.HTML')).toBe('html');
    });

    it('returns text for non-HTML web files', () => {
      expect(getTabTypeForFile('styles.css')).toBe('text');
      expect(getTabTypeForFile('styles.scss')).toBe('text');
    });

    it('returns text for config files', () => {
      expect(getTabTypeForFile('settings.ini')).toBe('text');
      expect(getTabTypeForFile('settings.cfg')).toBe('text');
      expect(getTabTypeForFile('settings.conf')).toBe('text');
    });

    it('returns text for special filenames without extensions', () => {
      expect(getTabTypeForFile('Makefile')).toBe('text');
      expect(getTabTypeForFile('Dockerfile')).toBe('text');
      expect(getTabTypeForFile('README')).toBe('text');
      expect(getTabTypeForFile('LICENSE')).toBe('text');
      expect(getTabTypeForFile('.gitignore')).toBe('text');
      expect(getTabTypeForFile('.env')).toBe('text');
    });
  });

  describe('fallback behavior', () => {
    it('returns text for unknown extensions', () => {
      expect(getTabTypeForFile('file.xyz')).toBe('text');
      expect(getTabTypeForFile('data.unknown')).toBe('text');
    });

    it('returns text for files without extension', () => {
      expect(getTabTypeForFile('somefile')).toBe('text');
    });
  });

  it('handles full paths correctly', () => {
    expect(getTabTypeForFile('/Users/lab/data/plasmid.gb')).toBe('sequence');
    expect(getTabTypeForFile('/path/to/image.png')).toBe('image');
    expect(getTabTypeForFile('/home/user/code/app.ts')).toBe('text');
  });
});

describe('getFileIconCategory  — file-tree icon resolver)', () => {
  it('uses the reference genome icon for a saved genome view', () => {
    expect(getFileIconCategory('My locus.dnaforge-track-view.json')).toBe('genome');
  });

  it('classifies every supported coordinate format as a structure', () => {
    for (const path of ['1FS0.pdb', '1FS0.cif', '1FS0.mmcif', '1FS0.mcif', '1FS0.bcif']) {
      expect(getFileIconCategory(path)).toBe('structure');
    }
  });

  it('classifies biology/sequence files', () => {
    expect(getFileIconCategory('plasmid.gb')).toBe('biology');
    expect(getFileIconCategory('chromosome.gbff')).toBe('biology');
    expect(getFileIconCategory('seq.fasta')).toBe('biology');
    expect(getFileIconCategory('trace.ab1')).toBe('biology');
  });

  it('classifies HTML as web (above text/code)', () => {
    expect(getFileIconCategory('index.html')).toBe('web');
    expect(getFileIconCategory('report.htm')).toBe('web');
  });

  it('classifies images — the core  bug (a .jpg must NOT read as a document)', () => {
    expect(getFileIconCategory('a-very-long-microscopy-capture-name.jpg')).toBe('image');
    expect(getFileIconCategory('photo.jpeg')).toBe('image');
    expect(getFileIconCategory('figure.png')).toBe('image');
    expect(getFileIconCategory('icon.svg')).toBe('image');
    expect(getFileIconCategory('gel.tiff')).toBe('image');
  });

  it('classifies PDFs', () => {
    expect(getFileIconCategory('paper.pdf')).toBe('pdf');
  });

  it('classifies archives', () => {
    expect(getFileIconCategory('data.zip')).toBe('archive');
    expect(getFileIconCategory('backup.tar.gz')).toBe('archive');
    expect(getFileIconCategory('reads.tgz')).toBe('archive');
    expect(getFileIconCategory('export.7z')).toBe('archive');
  });

  it('classifies spreadsheets / tabular data (above code)', () => {
    expect(getFileIconCategory('results.csv')).toBe('spreadsheet');
    expect(getFileIconCategory('counts.tsv')).toBe('spreadsheet');
    expect(getFileIconCategory('plate.xlsx')).toBe('spreadsheet');
  });

  it('classifies code / structured config', () => {
    expect(getFileIconCategory('app.ts')).toBe('code');
    expect(getFileIconCategory('script.py')).toBe('code');
    expect(getFileIconCategory('config.json')).toBe('code');
    expect(getFileIconCategory('styles.css')).toBe('code');
    expect(getFileIconCategory('run.sh')).toBe('code');
  });

  it('classifies readable text / docs', () => {
    expect(getFileIconCategory('notes.txt')).toBe('text');
    expect(getFileIconCategory('README.md')).toBe('text');
    expect(getFileIconCategory('output.log')).toBe('text');
    expect(getFileIconCategory('Makefile')).toBe('text');
  });

  it('does not mis-classify DNAForge note/design artifacts as code (compound extension)', () => {
    expect(getFileIconCategory('Experiment.wpnote.json')).not.toBe('code');
    expect(getFileIconCategory('Experiment.wpnote.json')).toBe('generic');
    expect(getFileIconCategory('/lab/New Design.wpdesign.json')).toBe('design');
    expect(getFileIconCategory('config.json')).toBe('code');
  });

  it('falls back to generic for unknown / extensionless files', () => {
    expect(getFileIconCategory('mystery.xyz')).toBe('generic');
    expect(getFileIconCategory('data.unknown')).toBe('generic');
    expect(getFileIconCategory('somefile')).toBe('generic');
  });

  it('is case-insensitive and path-aware', () => {
    expect(getFileIconCategory('/lab/imaging/SCAN.PNG')).toBe('image');
    expect(getFileIconCategory('/repo/src/Main.PY')).toBe('code');
  });
});

describe('standalone structure file presentation', () => {
  it('reports the explicit parser and byte-read family case-insensitively', () => {
    expect(getStructureFileFormat('1FS0.pdb')).toEqual({ parser: 'pdb', encoding: 'text' });
    expect(getStructureFileFormat('1FS0.CIF')).toEqual({ parser: 'mmcif', encoding: 'text' });
    expect(getStructureFileFormat('1FS0.mmcif')).toEqual({ parser: 'mmcif', encoding: 'text' });
    expect(getStructureFileFormat('1FS0.mcif')).toEqual({ parser: 'mmcif', encoding: 'text' });
    expect(getStructureFileFormat('1FS0.BCIF')).toEqual({ parser: 'mmcif', encoding: 'binary' });
    expect(getStructureFileFormat('1FS0.pdbqt')).toBeNull();
  });

  it('hides exactly one recognized structure suffix only in the browser label', () => {
    expect(getFileBrowserDisplayName('1FS0.pdb')).toBe('1FS0');
    expect(getFileBrowserDisplayName('1FS0.MMCIF')).toBe('1FS0');
    expect(getFileBrowserDisplayName('complex.v2.bcif')).toBe('complex.v2');
    expect(getFileBrowserDisplayName('notes.txt')).toBe('notes.txt');
    expect(getFileBrowserDisplayName('1FS0.pdb.gz')).toBe('1FS0.pdb.gz');
    expect(getFileBrowserDisplayName('.pdb')).toBe('.pdb');
  });

  it('keeps structure files out of the generic text-file predicate', () => {
    expect(isStructureFile('1FS0.pdb')).toBe(true);
    expect(isStructureFile('1FS0.bcif')).toBe(true);
    expect(isStructureFile('notes.txt')).toBe(false);
    expect(isTextFile('1FS0.pdb')).toBe(false);
  });
});

describe('isTabularDataFile', () => {
  it('detects file-backed tabular data formats routed to the table viewer/editor', () => {
    expect(isTabularDataFile('samples.csv')).toBe(true);
    expect(isTabularDataFile('/lab/runs/reads.TSV')).toBe(true);
    expect(isTabularDataFile('workbook.xlsx')).toBe(true);
    expect(isTabularDataFile('sheet.XLS')).toBe(true);
    expect(isTabularDataFile('notes.txt')).toBe(false);
  });

  it('routes .xlsx / .xls to the table tab type ', () => {
    expect(getTabTypeForFile('plate.xlsx')).toBe('table');
    expect(getTabTypeForFile('legacy.xls')).toBe('table');
  });
});

describe('isHtmlFile', () => {
  it('is true only for .html / .htm', () => {
    expect(isHtmlFile('index.html')).toBe(true);
    expect(isHtmlFile('report.HTM')).toBe(true);
    expect(isHtmlFile('styles.css')).toBe(false);
    expect(isHtmlFile('notes.txt')).toBe(false);
    expect(isHtmlFile('plasmid.gb')).toBe(false);
  });
});

describe('isBiologyFile', () => {
  it('returns true for biology files', () => {
    expect(isBiologyFile('plasmid.gb')).toBe(true);
    expect(isBiologyFile('sequence.fasta')).toBe(true);
    expect(isBiologyFile('trace.ab1')).toBe(true);
  });

  it('returns false for non-biology files', () => {
    expect(isBiologyFile('image.png')).toBe(false);
    expect(isBiologyFile('document.txt')).toBe(false);
    expect(isBiologyFile('Makefile')).toBe(false);
  });
});

describe('isImageFile', () => {
  it('returns true for image files', () => {
    expect(isImageFile('photo.png')).toBe(true);
    expect(isImageFile('photo.jpg')).toBe(true);
    expect(isImageFile('gel.tiff')).toBe(true);
  });

  it('returns false for non-image files', () => {
    expect(isImageFile('plasmid.gb')).toBe(false);
    expect(isImageFile('document.txt')).toBe(false);
    expect(isImageFile('Makefile')).toBe(false);
  });
});

describe('isTextFile', () => {
  it('returns true for explicit text files', () => {
    expect(isTextFile('notes.txt')).toBe(true);
    expect(isTextFile('README.md')).toBe(true);
    expect(isTextFile('app.ts')).toBe(true);
  });

  it('returns true for special filenames', () => {
    expect(isTextFile('Makefile')).toBe(true);
    expect(isTextFile('Dockerfile')).toBe(true);
    expect(isTextFile('.gitignore')).toBe(true);
  });

  it('returns false for non-text files', () => {
    expect(isTextFile('image.png')).toBe(false);
    expect(isTextFile('plasmid.gb')).toBe(false);
  });

  it('returns false for unknown extensions', () => {
    expect(isTextFile('file.xyz')).toBe(false);
  });
});

describe('isBinaryContent', () => {
  it('returns true for content with null bytes', () => {
    const buffer = new Uint8Array([72, 101, 108, 108, 111, 0, 87, 111, 114, 108, 100]);
    expect(isBinaryContent(buffer)).toBe(true);
  });

  it('returns true for content with many non-printable characters', () => {
    const buffer = new Uint8Array(100);
    for (let i = 0; i < 100; i++) {
      buffer[i] = i < 15 ? 1 : 65;
    }
    expect(isBinaryContent(buffer)).toBe(true);
  });

  it('returns false for plain ASCII text', () => {
    const text = 'Hello, World!\nThis is a test file.\n';
    const buffer = new TextEncoder().encode(text);
    expect(isBinaryContent(buffer)).toBe(false);
  });

  it('returns false for text with common whitespace', () => {
    const text = 'Line 1\n\tIndented\r\nWindows line\n';
    const buffer = new TextEncoder().encode(text);
    expect(isBinaryContent(buffer)).toBe(false);
  });

  it('returns false for empty buffer', () => {
    const buffer = new Uint8Array(0);
    expect(isBinaryContent(buffer)).toBe(false);
  });

  it('respects sample size parameter', () => {
    const buffer = new Uint8Array(200);
    buffer.fill(65);
    buffer[100] = 0;

    expect(isBinaryContent(buffer, 50)).toBe(false);
    expect(isBinaryContent(buffer, 200)).toBe(true);
  });

  it('detects binary PNG header', () => {
    const pngHeader = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(isBinaryContent(pngHeader)).toBe(true);
  });

  it('detects binary ELF header', () => {
    const elfHeader = new Uint8Array([127, 69, 76, 70, 0, 0, 0, 0]);
    expect(isBinaryContent(elfHeader)).toBe(true);
  });
});

describe('getLanguageForFile', () => {
  describe('JavaScript/TypeScript', () => {
    it('maps JS/TS extensions correctly', () => {
      expect(getLanguageForFile('app.js')).toBe('javascript');
      expect(getLanguageForFile('app.jsx')).toBe('jsx');
      expect(getLanguageForFile('app.ts')).toBe('typescript');
      expect(getLanguageForFile('app.tsx')).toBe('tsx');
    });
  });

  describe('data formats', () => {
    it('maps data format extensions correctly', () => {
      expect(getLanguageForFile('config.json')).toBe('json');
      expect(getLanguageForFile('config.yaml')).toBe('yaml');
      expect(getLanguageForFile('config.yml')).toBe('yaml');
      expect(getLanguageForFile('config.toml')).toBe('toml');
      expect(getLanguageForFile('data.xml')).toBe('xml');
    });
  });

  describe('markup', () => {
    it('maps markup extensions correctly', () => {
      expect(getLanguageForFile('README.md')).toBe('markdown');
      expect(getLanguageForFile('docs.markdown')).toBe('markdown');
      expect(getLanguageForFile('index.html')).toBe('html');
      expect(getLanguageForFile('index.htm')).toBe('html');
    });
  });

  describe('styles', () => {
    it('maps style extensions correctly', () => {
      expect(getLanguageForFile('styles.css')).toBe('css');
      expect(getLanguageForFile('styles.scss')).toBe('scss');
      expect(getLanguageForFile('styles.sass')).toBe('sass');
      expect(getLanguageForFile('styles.less')).toBe('less');
    });
  });

  describe('shell', () => {
    it('maps shell extensions to bash', () => {
      expect(getLanguageForFile('script.sh')).toBe('bash');
      expect(getLanguageForFile('script.bash')).toBe('bash');
      expect(getLanguageForFile('script.zsh')).toBe('bash');
      expect(getLanguageForFile('script.fish')).toBe('bash');
    });
  });

  describe('systems languages', () => {
    it('maps systems language extensions correctly', () => {
      expect(getLanguageForFile('main.rs')).toBe('rust');
      expect(getLanguageForFile('main.go')).toBe('go');
      expect(getLanguageForFile('main.c')).toBe('c');
      expect(getLanguageForFile('main.cpp')).toBe('cpp');
      expect(getLanguageForFile('header.h')).toBe('c');
      expect(getLanguageForFile('header.hpp')).toBe('cpp');
      expect(getLanguageForFile('Main.java')).toBe('java');
    });
  });

  describe('special filenames', () => {
    it('handles Dockerfile', () => {
      expect(getLanguageForFile('Dockerfile')).toBe('docker');
      expect(getLanguageForFile('/path/to/Dockerfile')).toBe('docker');
    });

    it('handles Makefile', () => {
      expect(getLanguageForFile('Makefile')).toBe('makefile');
      expect(getLanguageForFile('/path/to/Makefile')).toBe('makefile');
    });

    it('handles dotfiles as plaintext', () => {
      expect(getLanguageForFile('.gitignore')).toBe('plaintext');
      expect(getLanguageForFile('.env')).toBe('plaintext');
      expect(getLanguageForFile('.hidden')).toBe('plaintext');
    });
  });

  describe('fallback', () => {
    it('returns plaintext for unknown extensions', () => {
      expect(getLanguageForFile('file.xyz')).toBe('plaintext');
      expect(getLanguageForFile('data.unknown')).toBe('plaintext');
    });

    it('returns plaintext for files without extension', () => {
      expect(getLanguageForFile('README')).toBe('plaintext');
      expect(getLanguageForFile('LICENSE')).toBe('plaintext');
    });
  });
});
