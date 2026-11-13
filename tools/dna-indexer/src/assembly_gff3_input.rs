
pub use crate::assembly_fasta_input::ASSEMBLY_CONTIG_MAP_CONTRACT;
use crate::assembly_fasta_input::{
    for_each_assembly_fasta_record, open_maybe_gzip, read_contig_map, AssemblyContigMapping,
};
use crate::gff3_input::{
    normalize_record_coordinates, parse_gff3_for_sequence_with_manifest,
    repair_reversed_circular_virtual_interval, validate_row,
};
use crate::gff_emit::EmitOpts;
use crate::model::Topology;
use crate::output::{write_bundle_with_opts, BundleOutcome};
use anyhow::{anyhow, Context, Result};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    mpsc::{channel, sync_channel},
    Arc, Mutex,
};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_OPEN_SPOOL_FILES: usize = 32;
const MAX_SEMANTIC_CANDIDATES: usize = 65_536;
const MAX_CONTIG_FINALIZE_WORKERS: usize = 2;
struct ContigFinalizeJob {
    mapping: AssemblyContigMapping,
    sequence: Vec<u8>,
}

#[derive(Debug)]
pub struct AssemblyIngestOutcome {
    pub bundles: Vec<AssemblyBundleOutcome>,
    pub total_length: u64,
    pub total_features: u64,
    pub semantic_candidates: Vec<AssemblySemanticCandidate>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssemblySemanticCandidate {
    pub source_seq_id: String,
    #[serde(rename = "type")]
    pub feature_type: String,
    pub start: u64,
    pub end: u64,
}

#[derive(Debug)]
pub struct AssemblyBundleOutcome {
    pub source_seq_id: String,
    pub name: String,
    pub length: u64,
    pub feature_count: u64,
    pub paths: BundleOutcome,
}

pub fn ingest_assembly_gff3(
    gff3_path: &Path,
    fasta_path: &Path,
    contig_map_path: &Path,
    out_dir: &Path,
    indexer_version: &str,
) -> Result<AssemblyIngestOutcome> {
    let plan = read_contig_map(contig_map_path)?;
    ensure_output_targets_absent(out_dir, &plan.contigs)?;
    fs::create_dir_all(out_dir)
        .with_context(|| format!("could not create output directory {}", out_dir.display()))?;
    let split_root = out_dir.join(format!(
        ".assembly-gff3-split-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0)
    ));
    fs::create_dir(&split_root)
        .with_context(|| format!("could not create split directory {}", split_root.display()))?;

    let split_done = SplitGate::default();
    let result = thread::scope(|scope| {
        let split = scope.spawn(|| {
            let _t = crate::timing::span("split_gff3");
            let semantic_candidates = split_gff3_once(gff3_path, &plan.contigs, &split_root);
            split_done.open(semantic_candidates.is_ok());
            semantic_candidates
        });
        let fasta = {
            let _t = crate::timing::span("fasta_and_finalize");
            ingest_fasta_once(
                fasta_path,
                gff3_path,
                &plan.contigs,
                &split_root,
                out_dir,
                indexer_version,
                &split_done,
            )
        };
        let semantic_candidates = split.join().map_err(|_| anyhow!("GFF3 split panicked"))??;
        let mut outcome = fasta?;
        outcome.semantic_candidates = semantic_candidates;
        Ok(outcome)
    });

    let split_cleanup = fs::remove_dir_all(&split_root);
    match result {
        Ok(outcome) => match split_cleanup {
            Ok(()) => Ok(outcome),
            Err(error) => {
                cleanup_output_targets(out_dir, &plan.contigs);
                Err(error).with_context(|| {
                    format!("could not remove split directory {}", split_root.display())
                })
            }
        },
        Err(error) => {
            let _ = split_cleanup;
            cleanup_output_targets(out_dir, &plan.contigs);
            Err(error)
        }
    }
}

fn split_gff3_once(
    gff3_path: &Path,
    contigs: &[AssemblyContigMapping],
    split_root: &Path,
) -> Result<Vec<AssemblySemanticCandidate>> {
    let by_source: HashMap<&str, &AssemblyContigMapping> = contigs
        .iter()
        .map(|contig| (contig.source_seq_id.as_str(), contig))
        .collect();
    let mut reader = BufReader::new(open_maybe_gzip(gff3_path)?);
    let mut line = String::new();
    let mut line_number = 0usize;
    let mut saw_version = false;
    let mut seen_seqids = HashSet::new();
    let mut sequence_regions = HashSet::new();
    let mut writers = SpoolWriterPool::new(MAX_OPEN_SPOOL_FILES);
    let mut semantic_candidates = Vec::new();
    let mut spool_paths: HashMap<&str, std::path::PathBuf> = HashMap::new();

    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        line_number += 1;
        let raw = line.trim_end_matches(['\r', '\n']);
        if raw.is_empty() {
            continue;
        }
        if !saw_version {
            if raw != "##gff-version 3" {
                return Err(anyhow!(
                    "{}:{line_number}: first non-empty line must be ##gff-version 3",
                    gff3_path.display()
                ));
            }
            saw_version = true;
            continue;
        }
        if raw == "##FASTA" {
            return Err(anyhow!(
                "{}:{line_number}: embedded FASTA is ambiguous when an external manifest FASTA is supplied",
                gff3_path.display()
            ));
        }
        if let Some(region) = raw.strip_prefix("##sequence-region ") {
            let fields: Vec<&str> = region.split_ascii_whitespace().collect();
            if fields.len() != 3 {
                return Err(anyhow!(
                    "{}:{line_number}: malformed ##sequence-region",
                    gff3_path.display()
                ));
            }
            let mapping = by_source.get(fields[0]).ok_or_else(|| {
                anyhow!(
                    "{}:{line_number}: sequence-region {} is absent from the contig map",
                    gff3_path.display(),
                    fields[0]
                )
            })?;
            if seen_seqids.contains(fields[0]) {
                return Err(anyhow!(
                    "{}:{line_number}: ##sequence-region for {} must precede feature rows for that sequence",
                    gff3_path.display(),
                    fields[0]
                ));
            }
            let start: u64 = fields[1].parse().with_context(|| {
                format!(
                    "{}:{line_number}: invalid sequence-region start",
                    gff3_path.display()
                )
            })?;
            let end: u64 = fields[2].parse().with_context(|| {
                format!(
                    "{}:{line_number}: invalid sequence-region end",
                    gff3_path.display()
                )
            })?;
            if start != 1 || end != mapping.expected_length_bp {
                return Err(anyhow!(
                    "{}:{line_number}: sequence-region {}..{} does not match manifest length {}",
                    gff3_path.display(),
                    start,
                    end,
                    mapping.expected_length_bp
                ));
            }
            if !sequence_regions.insert(fields[0].to_string()) {
                return Err(anyhow!(
                    "{}:{line_number}: duplicate sequence-region for {}",
                    gff3_path.display(),
                    fields[0]
                ));
            }
            continue;
        }
        if raw.starts_with('#') {
            continue;
        }

        let repaired_line;
        let row = match validate_row(raw) {
            Ok(row) => row,
            Err(error) => {
                let seqid = raw.split('\t').next().unwrap_or("");
                repaired_line = by_source.get(seqid).and_then(|mapping| {
                    repair_reversed_circular_virtual_interval(
                        raw,
                        if mapping.circular == Some(true) {
                            Topology::Circular
                        } else {
                            Topology::Linear
                        },
                        Some(&mapping.expected_length_bp),
                    )
                });
                match repaired_line.as_deref().map(validate_row) {
                    Some(Ok(row)) => row,
                    _ => {
                        return Err(error)
                            .context(format!("{}:{line_number}", gff3_path.display()));
                    }
                }
            }
        };
        let mapping = by_source.get(row.seqid).ok_or_else(|| {
            anyhow!(
                "{}:{line_number}: GFF3 sequence {} is absent from the contig map",
                gff3_path.display(),
                row.seqid
            )
        })?;
        if is_semantic_candidate_type(row.feature_type) {
            if semantic_candidates.len() >= MAX_SEMANTIC_CANDIDATES {
                return Err(anyhow!(
                    "{}:{line_number}: semantic candidate count exceeds bounded limit {MAX_SEMANTIC_CANDIDATES}",
                    gff3_path.display()
                ));
            }
            semantic_candidates.push(AssemblySemanticCandidate {
                source_seq_id: row.seqid.to_string(),
                feature_type: row.feature_type.to_string(),
                start: row.start,
                end: row.end,
            });
        }
        if !seen_seqids.contains(row.seqid) {
            seen_seqids.insert(row.seqid.to_string());
        }
        let spool_path = spool_paths
            .entry(mapping.name.as_str())
            .or_insert_with(|| split_root.join(format!("{}.gff3", mapping.name)));
        writers.write_line(&mapping.name, spool_path, raw)?;
    }
    writers.finish()?;
    if !saw_version {
        return Err(anyhow!("{}: missing ##gff-version 3", gff3_path.display()));
    }
    for contig in contigs {
        if !seen_seqids.contains(&contig.source_seq_id) {
            return Err(anyhow!(
                "{}: contig {} has no GFF3 feature rows; manifest v1 has no annotationCoverage:none policy",
                gff3_path.display(),
                contig.source_seq_id
            ));
        }
    }
    Ok(semantic_candidates)
}

fn is_semantic_candidate_type(feature_type: &str) -> bool {
    matches!(
        feature_type,
        "centromere" | "SO:0000577" | "origin_of_replication" | "SO:0000296"
    )
}

#[derive(Default)]
struct SplitGate {
    state: Mutex<Option<bool>>,
    opened: std::sync::Condvar,
}

impl SplitGate {
    fn open(&self, succeeded: bool) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *state = Some(succeeded);
        self.opened.notify_all();
    }

    fn wait(&self) -> bool {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        loop {
            if let Some(succeeded) = *state {
                return succeeded;
            }
            state = self
                .opened
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }
}

fn ingest_fasta_once(
    fasta_path: &Path,
    gff3_path: &Path,
    contigs: &[AssemblyContigMapping],
    split_root: &Path,
    out_dir: &Path,
    indexer_version: &str,
    split_done: &SplitGate,
) -> Result<AssemblyIngestOutcome> {
    thread::scope(|scope| {
        let worker_count = thread::available_parallelism()
            .map(|parallelism| parallelism.get())
            .unwrap_or(1)
            .min(
                std::env::var("DNA_INDEXER_FINALIZE_WORKERS")
                    .ok()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(MAX_CONTIG_FINALIZE_WORKERS),
            )
            .min(contigs.len());
        let (job_sender, job_receiver) = sync_channel::<ContigFinalizeJob>(0);
        let job_receiver = Arc::new(Mutex::new(job_receiver));
        let (result_sender, result_receiver) = channel::<(String, Result<AssemblyBundleOutcome>)>();
        let mut workers = Vec::with_capacity(worker_count);
        for _ in 0..worker_count {
            let job_receiver = Arc::clone(&job_receiver);
            let result_sender = result_sender.clone();
            workers.push(scope.spawn(move || -> Result<()> {
                loop {
                    let job = {
                        let receiver = job_receiver
                            .lock()
                            .map_err(|_| anyhow!("contig finalization queue lock was poisoned"))?;
                        receiver.recv()
                    };
                    let Ok(job) = job else {
                        break;
                    };
                    if !split_done.wait() {
                        return Err(anyhow!("GFF3 split failed"));
                    }
                    let source_id = job.mapping.source_seq_id.clone();
                    let outcome = finalize_contig(
                        &job.mapping,
                        job.sequence,
                        gff3_path,
                        split_root,
                        out_dir,
                        indexer_version,
                    );
                    result_sender.send((source_id, outcome)).map_err(|_| {
                        anyhow!("contig finalization result receiver closed unexpectedly")
                    })?;
                }
                Ok(())
            }));
        }
        drop(result_sender);

        let fasta_timer = crate::timing::span("fasta_read_including_waits");
        let mut waiting = std::time::Duration::ZERO;
        let parse_result =
            for_each_assembly_fasta_record(fasta_path, contigs, |mapping, sequence| {
                let started = std::time::Instant::now();
                let sent = job_sender
                    .send(ContigFinalizeJob {
                        mapping: mapping.clone(),
                        sequence,
                    })
                    .map_err(|_| anyhow!("contig finalization workers stopped early"));
                waiting += started.elapsed();
                sent
            });
        drop(job_sender);
        drop(fasta_timer);
        if let Some(_t) = crate::timing::span("fasta_reader_waiting_on_workers") {
            eprintln!(
                "{{\"timing\":\"fasta_reader_waiting_on_workers_total\",\"ms\":{:.1}}}",
                waiting.as_secs_f64() * 1000.0
            );
        }

        let mut worker_error = None;
        for worker in workers {
            match worker.join() {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    worker_error.get_or_insert(error);
                }
                Err(_) => {
                    worker_error.get_or_insert_with(|| anyhow!("contig finalization panicked"));
                }
            };
        }
        let submitted = parse_result?;
        if let Some(error) = worker_error {
            return Err(error);
        }

        let mut outcomes: BTreeMap<String, AssemblyBundleOutcome> = BTreeMap::new();
        for _ in 0..submitted {
            let (source_id, outcome) = result_receiver
                .recv()
                .map_err(|_| anyhow!("contig finalization omitted a result"))?;
            outcomes.insert(source_id, outcome?);
        }

        let mut bundles = Vec::with_capacity(contigs.len());
        for contig in contigs {
            bundles.push(
                outcomes
                    .remove(contig.source_seq_id.as_str())
                    .expect("every manifest contig produced one outcome"),
            );
        }
        let total_length = bundles.iter().map(|bundle| bundle.length).sum();
        let total_features = bundles.iter().map(|bundle| bundle.feature_count).sum();
        Ok(AssemblyIngestOutcome {
            bundles,
            total_length,
            total_features,
            semantic_candidates: Vec::new(),
        })
    })
}

fn finalize_contig(
    mapping: &AssemblyContigMapping,
    sequence: Vec<u8>,
    source_gff3_path: &Path,
    split_root: &Path,
    out_dir: &Path,
    indexer_version: &str,
) -> Result<AssemblyBundleOutcome> {
    let actual_length = sequence.len() as u64;
    if actual_length != mapping.expected_length_bp {
        return Err(anyhow!(
            "{} FASTA length {actual_length} does not match expectedLengthBp {}",
            mapping.source_seq_id,
            mapping.expected_length_bp
        ));
    }
    let spool_path = split_root.join(format!("{}.gff3", mapping.name));
    let parse_timer = crate::timing::span(format!("{}:parse_gff3", mapping.name));
    let mut parsed = parse_gff3_for_sequence_with_manifest(
        &spool_path,
        &mapping.source_seq_id,
        mapping.expected_length_bp,
        mapping.circular,
    )?;
    if let Some(circular) = mapping.circular {
        if !circular && parsed.record.topology == Topology::Circular {
            return Err(anyhow!(
                "{} manifest declares circular=false but GFF3 declares Is_circular=true",
                mapping.source_seq_id
            ));
        }
        parsed.record.topology = if circular {
            Topology::Circular
        } else {
            Topology::Linear
        };
    }
    normalize_record_coordinates(&mut parsed, actual_length, source_gff3_path)?;
    let crate::gff3_input::ParsedGff3 {
        mut record,
        parent_ids,
        source_ids,
        source_phases,
        source_strands,
        source_interval_qualifiers,
        source_origin_spanning,
    } = parsed;
    record.length = actual_length;
    record.sequence = sequence;
    let feature_count = record.features.len() as u64;
    let emit_opts = EmitOpts {
        source_ids: Some(source_ids),
        explicit_parent_source_ids: Some(parent_ids),
        source_phases: Some(source_phases),
        source_strands: Some(source_strands),
        source_interval_qualifiers: Some(source_interval_qualifiers),
        source_origin_spanning: Some(source_origin_spanning),
    };
    drop(parse_timer);
    let _write_timer = crate::timing::span(format!("{}:write_bundle", mapping.name));
    let paths =
        write_bundle_with_opts(&record, out_dir, &mapping.name, indexer_version, &emit_opts)
            .with_context(|| format!("while writing bundle for {}", mapping.source_seq_id))?;
    Ok(AssemblyBundleOutcome {
        source_seq_id: mapping.source_seq_id.clone(),
        name: mapping.name.clone(),
        length: actual_length,
        feature_count,
        paths,
    })
}

fn ensure_output_targets_absent(out_dir: &Path, contigs: &[AssemblyContigMapping]) -> Result<()> {
    for contig in contigs {
        for path in output_paths(out_dir, &contig.name) {
            if path.exists() {
                return Err(anyhow!(
                    "assembly ingestion output already exists: {}",
                    path.display()
                ));
            }
        }
    }
    Ok(())
}

fn cleanup_output_targets(out_dir: &Path, contigs: &[AssemblyContigMapping]) {
    for contig in contigs {
        for path in output_paths(out_dir, &contig.name) {
            let _ = fs::remove_file(path);
        }
    }
}

fn output_paths(out_dir: &Path, name: &str) -> [PathBuf; 12] {
    [
        out_dir.join(format!("{name}.fa.gz")),
        out_dir.join(format!("{name}.fa.gz.fai")),
        out_dir.join(format!("{name}.fa.gz.gzi")),
        out_dir.join(format!("{name}.gff3.gz")),
        out_dir.join(format!("{name}.gff3.gz.tbi")),
        out_dir.join(format!("{name}.gff3.gz.csi")),
        out_dir.join(format!("{name}.fa.gz.tmp")),
        out_dir.join(format!("{name}.fa.gz.fai.tmp")),
        out_dir.join(format!("{name}.fa.gz.gzi.tmp")),
        out_dir.join(format!("{name}.gff3.gz.tmp")),
        out_dir.join(format!("{name}.gff3.gz.tbi.tmp")),
        out_dir.join(format!("{name}.gff3.gz.csi.tmp")),
    ]
}

struct SpoolWriterPool {
    max_open: usize,
    tick: u64,
    open: HashMap<String, OpenSpool>,
}

struct OpenSpool {
    writer: BufWriter<File>,
    last_used: u64,
}

impl SpoolWriterPool {
    fn new(max_open: usize) -> Self {
        Self {
            max_open,
            tick: 0,
            open: HashMap::new(),
        }
    }

    fn write_line(&mut self, key: &str, path: &Path, line: &str) -> Result<()> {
        self.tick += 1;
        if !self.open.contains_key(key) {
            if self.open.len() >= self.max_open {
                let evict = self
                    .open
                    .iter()
                    .min_by_key(|(_, spool)| spool.last_used)
                    .map(|(key, _)| key.clone())
                    .expect("non-empty writer pool");
                let mut spool = self.open.remove(&evict).expect("selected spool exists");
                spool.writer.flush()?;
            }
            let is_new = !path.exists();
            let file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .with_context(|| format!("could not open GFF3 spool {}", path.display()))?;
            let mut writer = BufWriter::new(file);
            if is_new {
                writer.write_all(b"##gff-version 3\n")?;
            }
            self.open.insert(
                key.to_string(),
                OpenSpool {
                    writer,
                    last_used: self.tick,
                },
            );
        }
        let spool = self.open.get_mut(key).expect("spool was opened");
        spool.last_used = self.tick;
        spool.writer.write_all(line.as_bytes())?;
        spool.writer.write_all(b"\n")?;
        Ok(())
    }

    fn finish(mut self) -> Result<()> {
        for (_, mut spool) in self.open.drain() {
            spool.writer.flush()?;
        }
        Ok(())
    }
}
