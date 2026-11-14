import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));

const generate = String.raw`
import hashlib, json, pathlib, sys, zipfile
import pysam

root = pathlib.Path(sys.argv[1])
accession = 'GCF_900000042.1'
contigs = [('NC_900001.1', 320000), ('NC_900002.1', 280000)]
fasta_path = f'ncbi_dataset/data/{accession}/{accession}_dense_genomic.fna'
sequences = {name: ('ACGT' * ((length + 3) // 4))[:length] for name, length in contigs}
fasta = ''.join(f'>{name} synthetic chromosome, complete sequence\n' + '\n'.join(sequence[i:i+80] for i in range(0, len(sequence), 80)) + '\n' for name, sequence in sequences.items()).encode()
zip_path = root / 'dense-reference.zip'
with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as archive:
    archive.writestr(fasta_path, fasta)
    archive.writestr('ncbi_dataset/data/assembly_data_report.jsonl', json.dumps({'accession': accession, 'organism': {'organismName': 'Synthetic dense alignment fixture'}, 'assemblyInfo': {'assemblyName': 'dense-alignment-performance'}}) + '\n')
    archive.writestr('ncbi_dataset/data/dataset_catalog.json', json.dumps({'assemblies': [{'accession': accession, 'files': [{'fileType': 'GENOMIC_NUCLEOTIDE_FASTA', 'filePath': fasta_path}]}]}))
    archive.writestr('md5sum.txt', hashlib.md5(fasta).hexdigest() + '  ./' + fasta_path + '\n')
bam_path = root / 'dense-80x.bam'
header = {'HD': {'VN': '1.6', 'SO': 'coordinate'}, 'SQ': [{'SN': name, 'LN': length} for name, length in contigs]}
with pysam.AlignmentFile(str(bam_path), 'wb', header=header) as bam:
    for index in range(120000):
        start = 20000 + index * 150 // 80
        read = pysam.AlignedSegment()
        read.query_name = f'dense-read-{index:06d}'
        read.query_sequence = sequences[contigs[0][0]][start:start+150]
        read.flag = 16 if index % 2 else 0
        read.reference_id = 0
        read.reference_start = start
        read.mapping_quality = 60
        read.cigar = [(0, 150)]
        read.query_qualities = pysam.qualitystring_to_array('I' * 150)
        bam.write(read)
pysam.index(str(bam_path))
with pysam.AlignmentFile(str(bam_path), 'rb') as bam:
    observed_count = bam.count(contigs[0][0])
assert observed_count == 120000, observed_count
print(json.dumps({'fixtureId': 'synthetic-two-contig-80x-120000x150-v1', 'referencePath': str(zip_path), 'bamPath': str(bam_path), 'indexPath': str(bam_path) + '.bai', 'readLengthBp': 150, 'readCount': observed_count, 'nominalDepth': 80, 'locusStart': 60000, 'source': {'assemblyLengthBp': sum(length for _, length in contigs), 'chromosomeCount': len(contigs), 'bamSizeBytes': bam_path.stat().st_size}, 'contigs': [{'name': name, 'length': length} for name, length in contigs]}))
`;

export async function createDensePileupFixture(directory) {
  assert.ok(path.isAbsolute(directory), 'The fixture directory must be absolute.');
  await mkdir(directory, { recursive: true });
  directory = await realpath(directory);
  const python = path.join(
    repository,
    'apps/api/.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
  );
  const fixture = await new Promise((resolve, reject) => {
    const child = spawn(python, ['-c', generate, directory], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(`Dense BAM creation failed (${code}): ${stderr}`));
      else {
        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(error);
        }
      }
    });
  });
  const result = { ...fixture, workspaceRoot: directory, coldScope: 'fresh-view-prepared-source' };
  await writeFile(path.join(directory, 'fixture.json'), JSON.stringify(result, null, 2));
  return result;
}
