
use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use dna_indexer::{
    assembly_fasta_input, assembly_gff3_input,
    error::{self, IndexerError},
    fasta_input, genbank, gff3_input,
    model::Topology,
    output::{
        compress_plain_fasta_file, write_bundle, write_bundle_with_opts, write_sequence_bundle,
        BundleOutcome, SequenceBundleOutcome,
    },
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

const SCHEMA_VERSION: u32 = 2;

#[derive(Parser, Debug)]
#[command(
    name = "dna-indexer",
    version = concat!(env!("CARGO_PKG_VERSION"), " schema 2"),
    about = "DNAForge genome indexer — converts GenBank/FASTA to indexed format for the chromosome-scale renderer",
    long_about = None,
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Index a GenBank (.gb, .gbff, .gbk) or FASTA (.fa, .fasta, .fna) file.
    Index {
        /// Input file path (GenBank or FASTA).
        #[arg(long = "in")]
        input: PathBuf,
        /// Output directory for the BGZF FASTA bundle plus GFF3/tabix when annotated.
        #[arg(long = "out-dir")]
        out_dir: PathBuf,
        /// Output basename (e.g. "chr11" produces chr11.fa.gz, chr11.fa.gz.fai, ...).
        #[arg(long)]
        name: String,
    },
    /// Ingest a pre-built GFF3 + FASTA pair (e.g. authoritative NCBI/Ensembl
    /// data). Skips inference; trusts the existing Parent= edges.
    IngestGff3 {
        /// Input GFF3 file path.
        #[arg(long = "in")]
        input_gff3: PathBuf,
        /// Input FASTA file path (paired with the GFF3).
        #[arg(long = "in-fasta")]
        input_fasta: PathBuf,
        /// Required source sequence id for manifest-driven preparation.
        #[arg(long = "source-seqid")]
        source_seqid: Option<String>,
        /// Output directory.
        #[arg(long = "out-dir")]
        out_dir: PathBuf,
        /// Output basename.
        #[arg(long)]
        name: String,
    },
    /// Ingest one whole-assembly GFF3 + FASTA pair in a single source pass,
    /// emitting one indexed quartet for every exact contig-map entry.
    IngestGff3Assembly {
        /// Whole-assembly GFF3 file path.
        #[arg(long = "in")]
        input_gff3: PathBuf,
        /// Whole-assembly FASTA file path.
        #[arg(long = "in-fasta")]
        input_fasta: PathBuf,
        /// Versioned source-sequence-id → canonical-name JSON plan.
        #[arg(long = "contig-map")]
        contig_map: PathBuf,
        /// Empty staging directory for the emitted quartets.
        #[arg(long = "out-dir")]
        out_dir: PathBuf,
    },
    /// Ingest one whole-assembly FASTA in a single source pass, emitting one
    /// indexed FASTA/FAI pair for every exact contig-map entry.
    IngestFastaAssembly {
        /// Whole-assembly FASTA file path.
        #[arg(long = "in")]
        input_fasta: PathBuf,
        /// Versioned source-sequence-id → canonical-name JSON plan.
        #[arg(long = "contig-map")]
        contig_map: PathBuf,
        /// Empty staging directory for the emitted sequence pairs.
        #[arg(long = "out-dir")]
        out_dir: PathBuf,
    },
    /// BGZF-compress an existing uncompressed FASTA without rewriting layout.
    /// Copies the sibling `.fai` onto `.fa.gz.fai` and writes `.fa.gz.gzi`.
    /// Does not delete the source files.
    CompressFasta {
        /// Uncompressed FASTA path (`.fa`, `.fasta`, or `.fna`).
        #[arg(long = "in")]
        input: PathBuf,
    },
    /// Print the planning identity of a whole-assembly FASTA (plain or gzip)
    /// as one JSON object: raw-file SHA-256 and per-record normalized
    /// sequence SHA-256, or a fallback for files the planner must inspect.
    InspectFasta {
        #[arg(long = "in")]
        input: PathBuf,
    },
    /// Hold the machine-local reference-asset writer lock and commit its
    /// publication pointer on command. This private protocol lets the Node
    /// asset tool use the OS file lock without a native Node addon.
    #[command(hide = true)]
    ReferenceAssetLock {
        /// Stable lock-file path inside the machine-local assembly cache.
        #[arg(long)]
        lock_path: PathBuf,
    },
}

fn main() {
    let cli = Cli::parse();

    if let Some(Command::ReferenceAssetLock { lock_path }) = &cli.command {
        match run_reference_asset_lock(lock_path) {
            Ok(ReferenceAssetLockOutcome::Released) => std::process::exit(0),
            Ok(ReferenceAssetLockOutcome::Busy) => std::process::exit(3),
            Err(error) => {
                eprintln!("reference-asset lock failed: {error:#}");
                std::process::exit(1);
            }
        }
    }

    if let Some(Command::InspectFasta { input }) = &cli.command {
        match dna_indexer::fasta_inspect::inspect_fasta(input) {
            Ok(inspection) => {
                println!("{}", serde_json::to_string(&inspection).expect("inspection serializes"));
                std::process::exit(0);
            }
            Err(error) => {
                eprintln!("inspect-fasta failed: {error:#}");
                std::process::exit(1);
            }
        }
    }

    let outcome = match cli.command {
        Some(Command::Index {
            input,
            out_dir,
            name,
        }) => run_index(&input, &out_dir, &name),
        Some(Command::IngestGff3 {
            input_gff3,
            input_fasta,
            source_seqid,
            out_dir,
            name,
        }) => run_ingest_gff3(
            &input_gff3,
            &input_fasta,
            source_seqid.as_deref(),
            &out_dir,
            &name,
        ),
        Some(Command::IngestGff3Assembly {
            input_gff3,
            input_fasta,
            contig_map,
            out_dir,
        }) => run_ingest_gff3_assembly(&input_gff3, &input_fasta, &contig_map, &out_dir),
        Some(Command::IngestFastaAssembly {
            input_fasta,
            contig_map,
            out_dir,
        }) => run_ingest_fasta_assembly(&input_fasta, &contig_map, &out_dir),
        Some(Command::CompressFasta { input }) => run_compress_fasta(&input),
        Some(Command::ReferenceAssetLock { .. }) | Some(Command::InspectFasta { .. }) => {
            unreachable!("handled above")
        }
        None => {
            Cli::parse_from(["dna-indexer", "--help"]);
            std::process::exit(0);
        }
    };

    match outcome {
        Ok(status) => {
            emit_terminal_status(&status);
            std::process::exit(0);
        }
        Err(e) => {
            let mut ctx = BTreeMap::new();
            ctx.insert(
                "details".to_string(),
                serde_json::Value::String(format!("{:#}", e)),
            );
            let typed = e
                .downcast_ref::<IndexerError>()
                .cloned()
                .unwrap_or_else(|| IndexerError::GenbankParseFailed(format!("{:#}", e)));
            error::to_json_stderr(&typed, &ctx);

            emit_terminal_status(&TerminalStatus {
                ok: false,
                code: Some(typed.code().to_string()),
                message: Some(typed.message().to_string()),
                length: 0,
                feature_count: 0,
                topology: None,
                paths: None,
                bundles: None,
                semantic_candidates: None,
                annotation_rows: None,
            });
            std::process::exit(1);
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "command", rename_all = "kebab-case")]
enum ReferenceAssetLockCommand {
    CommitPointer {
        temporary_path: PathBuf,
        pointer_path: PathBuf,
    },
    Release,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReferenceAssetLockOutcome {
    Released,
    Busy,
}

fn run_reference_asset_lock(lock_path: &Path) -> Result<ReferenceAssetLockOutcome> {
    if let Some(parent) = lock_path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("while creating lock parent {}", parent.display()))?;
    }
    let lock_file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(lock_path)
        .with_context(|| format!("while opening lock {}", lock_path.display()))?;
    match lock_file.try_lock() {
        Ok(()) => {}
        Err(std::fs::TryLockError::WouldBlock) => {
            emit_reference_asset_lock_event("busy");
            return Ok(ReferenceAssetLockOutcome::Busy);
        }
        Err(std::fs::TryLockError::Error(error)) => {
            return Err(error).with_context(|| format!("while locking {}", lock_path.display()));
        }
    }

    emit_reference_asset_lock_event("locked");
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let line = line.context("while reading reference-asset lock command")?;
        let command: ReferenceAssetLockCommand =
            serde_json::from_str(&line).context("invalid reference-asset lock command")?;
        match command {
            ReferenceAssetLockCommand::CommitPointer {
                temporary_path,
                pointer_path,
            } => {
                commit_reference_asset_pointer(&temporary_path, &pointer_path)?;
                emit_reference_asset_lock_event("committed");
            }
            ReferenceAssetLockCommand::Release => {
                File::unlock(&lock_file).context("while releasing reference-asset lock")?;
                emit_reference_asset_lock_event("released");
                return Ok(ReferenceAssetLockOutcome::Released);
            }
        }
    }

    File::unlock(&lock_file).context("while releasing reference-asset lock after parent exit")?;
    Ok(ReferenceAssetLockOutcome::Released)
}

fn commit_reference_asset_pointer(temporary_path: &Path, pointer_path: &Path) -> Result<()> {
    let temporary_parent = temporary_path
        .parent()
        .context("temporary publication pointer has no parent")?;
    let pointer_parent = pointer_path
        .parent()
        .context("publication pointer has no parent")?;
    if temporary_parent != pointer_parent {
        anyhow::bail!("publication pointer temporary file must be a sibling of the pointer");
    }
    let pointer_name = pointer_path
        .file_name()
        .and_then(|name| name.to_str())
        .context("publication pointer has an invalid filename")?;
    let temporary_name = temporary_path
        .file_name()
        .and_then(|name| name.to_str())
        .context("temporary publication pointer has an invalid filename")?;
    if !temporary_name.starts_with(&format!("{pointer_name}.")) || !temporary_name.ends_with(".tmp")
    {
        anyhow::bail!("temporary publication pointer has an invalid name");
    }
    let metadata = std::fs::symlink_metadata(temporary_path)
        .with_context(|| format!("while inspecting {}", temporary_path.display()))?;
    if !metadata.file_type().is_file() {
        anyhow::bail!("temporary publication pointer must be a regular file");
    }
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(temporary_path)
        .with_context(|| format!("while opening {}", temporary_path.display()))?
        .sync_all()
        .with_context(|| format!("while syncing {}", temporary_path.display()))?;
    std::fs::rename(temporary_path, pointer_path).with_context(|| {
        format!(
            "while publishing {} to {}",
            temporary_path.display(),
            pointer_path.display()
        )
    })?;
    Ok(())
}

fn emit_reference_asset_lock_event(event: &str) {
    println!(
        "{}",
        serde_json::json!({
            "event": event,
        })
    );
    let _ = std::io::stdout().flush();
}

fn run_compress_fasta(input: &std::path::Path) -> Result<TerminalStatus> {
    emit_progress(0.1, "compress_fasta", 0);
    let outcome = compress_plain_fasta_file(input)
        .with_context(|| format!("while compressing {}", input.display()))?;
    emit_progress(1.0, "done", 0);
    Ok(TerminalStatus {
        ok: true,
        code: None,
        message: Some(format!(
            "wrote BGZF FASTA {} without rewriting uncompressed layout",
            outcome.fa_path.display()
        )),
        length: 0,
        feature_count: 0,
        topology: None,
        paths: Some(BundlePaths::from(&outcome)),
        bundles: None,
        semantic_candidates: None,
        annotation_rows: None,
    })
}

fn run_index(
    input: &std::path::Path,
    out_dir: &std::path::Path,
    name: &str,
) -> Result<TerminalStatus> {
    emit_progress(0.0, "parsing", 0);

    if fasta_input::looks_like_fasta(input)? {
        return run_index_fasta(input, out_dir, name);
    }

    let records = genbank::parse_genbank(input)
        .with_context(|| format!("while parsing {}", input.display()))?;
    if records.is_empty() {
        return Err(IndexerError::GenbankParseFailed(format!(
            "{} contained no records",
            input.display()
        ))
        .into());
    }
    if records.len() > 1 {
        return Err(IndexerError::UnsupportedInputFormat(format!(
            "multi-record GenBank not supported ({} records in {}); split before indexing",
            records.len(),
            input.display()
        ))
        .into());
    }
    let total_features: u64 = records[0].features.len() as u64;
    emit_progress(0.3, "gff_emit", total_features);

    let record = &records[0];
    let indexer_version = env!("CARGO_PKG_VERSION");

    emit_progress(0.6, "writing", total_features);
    let outcome = write_bundle(record, out_dir, name, indexer_version)
        .with_context(|| format!("while writing bundle to {}", out_dir.display()))?;
    emit_progress(0.95, "done", total_features);

    let topology = match record.topology {
        Topology::Circular => "circular",
        Topology::Linear => "linear",
    };

    Ok(TerminalStatus {
        ok: true,
        code: None,
        message: Some(format!(
            "wrote bundle for {} ({} bp, {} features)",
            name, record.length, total_features
        )),
        length: record.length,
        feature_count: total_features,
        topology: Some(topology.to_string()),
        paths: Some(BundlePaths::from(&outcome)),
        bundles: None,
        semantic_candidates: None,
        annotation_rows: Some(outcome.annotation_rows),
    })
}

fn run_index_fasta(
    input: &std::path::Path,
    out_dir: &std::path::Path,
    name: &str,
) -> Result<TerminalStatus> {
    let (_source_id, sequence) = fasta_input::read_single_fasta(input)
        .map_err(|e| IndexerError::UnsupportedInputFormat(format!("{e:#}")))?;
    emit_progress(0.6, "writing", 0);
    let outcome = write_sequence_bundle(&sequence, out_dir, name)
        .with_context(|| format!("while writing bundle to {}", out_dir.display()))?;
    emit_progress(0.95, "done", 0);
    Ok(TerminalStatus {
        ok: true,
        code: None,
        message: Some(format!(
            "wrote bundle for {} ({} bp, 0 features)",
            name,
            sequence.len()
        )),
        length: sequence.len() as u64,
        feature_count: 0,
        topology: Some("linear".to_string()),
        paths: Some(BundlePaths::from(&outcome)),
        bundles: None,
        semantic_candidates: None,
        annotation_rows: Some(0),
    })
}

fn run_ingest_gff3(
    input_gff3: &std::path::Path,
    input_fasta: &std::path::Path,
    expected_source_seqid: Option<&str>,
    out_dir: &std::path::Path,
    name: &str,
) -> Result<TerminalStatus> {
    emit_progress(0.0, "parsing", 0);

    let parsed = gff3_input::parse_gff3(input_gff3, Some(input_fasta)).with_context(|| {
        format!(
            "while parsing GFF3 {} (FASTA {})",
            input_gff3.display(),
            input_fasta.display()
        )
    })?;
    if let Some(expected) = expected_source_seqid {
        if parsed.record.name != expected {
            return Err(anyhow::anyhow!(
                "manifest sourceSeqId {expected} does not match input sequence ID {}",
                parsed.record.name
            ));
        }
    }

    let total_features: u64 = parsed.record.features.len() as u64;
    emit_progress(0.3, "gff_emit", total_features);

    let indexer_version = env!("CARGO_PKG_VERSION");
    let emit_opts = dna_indexer::gff_emit::EmitOpts {
        source_ids: Some(parsed.source_ids),
        explicit_parent_source_ids: Some(parsed.parent_ids),
        source_phases: Some(parsed.source_phases),
        source_strands: Some(parsed.source_strands),
        source_interval_qualifiers: Some(parsed.source_interval_qualifiers),
        source_origin_spanning: Some(parsed.source_origin_spanning),
    };

    emit_progress(0.6, "writing", total_features);
    let outcome =
        write_bundle_with_opts(&parsed.record, out_dir, name, indexer_version, &emit_opts)
            .with_context(|| format!("while writing bundle to {}", out_dir.display()))?;
    emit_progress(0.95, "done", total_features);

    let topology = match parsed.record.topology {
        Topology::Circular => "circular",
        Topology::Linear => "linear",
    };

    Ok(TerminalStatus {
        ok: true,
        code: None,
        message: Some(format!(
            "ingested GFF3 bundle for {} ({} bp, {} features) — Parent= edges preserved from source",
            name, parsed.record.length, total_features
        )),
        length: parsed.record.length,
        feature_count: total_features,
        topology: Some(topology.to_string()),
        paths: Some(BundlePaths::from(&outcome)),
        bundles: None,
        semantic_candidates: None,
        annotation_rows: Some(outcome.annotation_rows),
    })
}

fn run_ingest_gff3_assembly(
    input_gff3: &std::path::Path,
    input_fasta: &std::path::Path,
    contig_map: &std::path::Path,
    out_dir: &std::path::Path,
) -> Result<TerminalStatus> {
    emit_progress(0.0, "splitting_gff3", 0);
    let outcome = assembly_gff3_input::ingest_assembly_gff3(
        input_gff3,
        input_fasta,
        contig_map,
        out_dir,
        env!("CARGO_PKG_VERSION"),
    )
    .with_context(|| {
        format!(
            "while ingesting assembly GFF3 {} (FASTA {})",
            input_gff3.display(),
            input_fasta.display()
        )
    })?;
    emit_progress(0.95, "done", outcome.total_features);
    let bundle_count = outcome.bundles.len();
    let bundles = outcome
        .bundles
        .iter()
        .map(|bundle| AssemblyBundleStatus {
            source_seq_id: bundle.source_seq_id.clone(),
            name: bundle.name.clone(),
            length: bundle.length,
            feature_count: bundle.feature_count,
            paths: BundlePaths::from(&bundle.paths),
        })
        .collect();
    Ok(TerminalStatus {
        ok: true,
        code: None,
        message: Some(format!(
            "ingested {bundle_count} assembly contigs in one source pass"
        )),
        length: outcome.total_length,
        feature_count: outcome.total_features,
        topology: None,
        paths: None,
        bundles: Some(bundles),
        semantic_candidates: Some(AssemblySemanticCandidatesStatus {
            contract: "dna-indexer-semantic-candidates.v1",
            records: outcome.semantic_candidates,
        }),
        annotation_rows: None,
    })
}

fn run_ingest_fasta_assembly(
    input_fasta: &std::path::Path,
    contig_map: &std::path::Path,
    out_dir: &std::path::Path,
) -> Result<TerminalStatus> {
    emit_progress(0.0, "parsing_fasta", 0);
    let outcome = assembly_fasta_input::ingest_assembly_fasta(input_fasta, contig_map, out_dir)
        .with_context(|| format!("while ingesting assembly FASTA {}", input_fasta.display()))?;
    emit_progress(0.95, "done", 0);
    let bundle_count = outcome.bundles.len();
    let bundles = outcome
        .bundles
        .iter()
        .map(|bundle| AssemblyBundleStatus {
            source_seq_id: bundle.source_seq_id.clone(),
            name: bundle.name.clone(),
            length: bundle.length,
            feature_count: 0,
            paths: BundlePaths::from(&bundle.paths),
        })
        .collect();
    Ok(TerminalStatus {
        ok: true,
        code: None,
        message: Some(format!(
            "ingested {bundle_count} assembly contigs from FASTA in one source pass"
        )),
        length: outcome.total_length,
        feature_count: 0,
        topology: None,
        paths: None,
        bundles: Some(bundles),
        semantic_candidates: None,
        annotation_rows: None,
    })
}

#[derive(Debug, Serialize)]
struct ProgressEvent<'a> {
    progress: f64,
    stage: &'a str,
    feature_count: u64,
}

fn emit_progress(progress: f64, stage: &str, feature_count: u64) {
    let event = ProgressEvent {
        progress,
        stage,
        feature_count,
    };
    if let Ok(line) = serde_json::to_string(&event) {
        println!("{}", line);
        let _ = std::io::stdout().flush();
    }
}

#[derive(Debug, Serialize)]
struct TerminalStatus {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    length: u64,
    feature_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    topology: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    paths: Option<BundlePaths>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bundles: Option<Vec<AssemblyBundleStatus>>,
    #[serde(rename = "semanticCandidates", skip_serializing_if = "Option::is_none")]
    semantic_candidates: Option<AssemblySemanticCandidatesStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    annotation_rows: Option<u64>,
}

impl TerminalStatus {
    fn not_implemented(msg: &str) -> Self {
        TerminalStatus {
            ok: false,
            code: Some("NOT_IMPLEMENTED".to_string()),
            message: Some(msg.to_string()),
            length: 0,
            feature_count: 0,
            topology: None,
            paths: None,
            bundles: None,
            semantic_candidates: None,
            annotation_rows: None,
        }
    }
}

#[derive(Debug, Serialize)]
struct AssemblySemanticCandidatesStatus {
    contract: &'static str,
    records: Vec<assembly_gff3_input::AssemblySemanticCandidate>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssemblyBundleStatus {
    source_seq_id: String,
    name: String,
    length: u64,
    feature_count: u64,
    paths: BundlePaths,
}

#[derive(Debug, Serialize)]
struct BundlePaths {
    fa: String,
    fai: String,
    gzi: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    gff3_gz: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tbi: Option<String>,
}

impl From<&BundleOutcome> for BundlePaths {
    fn from(o: &BundleOutcome) -> Self {
        BundlePaths {
            fa: o.fa_path.to_string_lossy().into(),
            fai: o.fai_path.to_string_lossy().into(),
            gzi: o.gzi_path.to_string_lossy().into(),
            gff3_gz: Some(o.gz_path.to_string_lossy().into()),
            tbi: Some(o.tbi_path.to_string_lossy().into()),
        }
    }
}

impl From<&SequenceBundleOutcome> for BundlePaths {
    fn from(o: &SequenceBundleOutcome) -> Self {
        BundlePaths {
            fa: o.fa_path.to_string_lossy().into(),
            fai: o.fai_path.to_string_lossy().into(),
            gzi: o.gzi_path.to_string_lossy().into(),
            gff3_gz: None,
            tbi: None,
        }
    }
}

fn emit_terminal_status(status: &TerminalStatus) {
    if let Ok(line) = serde_json::to_string(status) {
        println!("{}", line);
        let _ = std::io::stdout().flush();
    }
}

#[allow(dead_code)]
fn schema_version() -> u32 {
    SCHEMA_VERSION
}
