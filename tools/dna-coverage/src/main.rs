use std::path::PathBuf;

use clap::{Parser, Subcommand};
use dna_coverage::{
    build_base_layer_from_bam, coverage_tile_from_bam, coverage_tile_from_bam_with_bin_size,
};

const SCHEMA_VERSION: u32 = 2;

#[derive(Debug, Parser)]
#[command(name = "dna-coverage")]
#[command(about = "Exact-window BAM/CRAM coverage helper for DNAForge")]
#[command(version = env!("CARGO_PKG_VERSION"))]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Emit one max-pooled coverage tile as JSON.
    Tile {
        #[arg(long)]
        bam: PathBuf,
        #[arg(long)]
        index: Option<PathBuf>,
        #[arg(long = "reference-fasta")]
        reference_fasta: Option<PathBuf>,
        #[arg(long)]
        chrom: String,
        #[arg(long)]
        start: i64,
        #[arg(long)]
        end: i64,
        #[arg(long)]
        bins: usize,
        #[arg(long = "bin-size")]
        bin_size: Option<usize>,
    },
    /// Build a resident per-chromosome base layer and write it as `.npy`.
    BuildBase {
        #[arg(long)]
        bam: PathBuf,
        #[arg(long)]
        index: Option<PathBuf>,
        #[arg(long = "reference-fasta")]
        reference_fasta: Option<PathBuf>,
        #[arg(long)]
        chrom: String,
        #[arg(long)]
        out: PathBuf,
        #[arg(long = "base-bins", default_value_t = 131_072)]
        base_bins: usize,
        #[arg(long = "window-bp", default_value_t = 1_000_000)]
        window_bp: i64,
        /// HTSlib BGZF decode threads assigned to this chromosome build.
        #[arg(long, default_value_t = 1)]
        threads: usize,
    },
    /// Print the stdout version line consumed by the Python sidecar.
    SchemaVersion,
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Tile {
            bam,
            index,
            reference_fasta,
            chrom,
            start,
            end,
            bins,
            bin_size,
        } => {
            let tile = match bin_size {
                Some(size) => coverage_tile_from_bam_with_bin_size(
                    &bam,
                    index.as_deref(),
                    reference_fasta.as_deref(),
                    &chrom,
                    start,
                    end,
                    size,
                )?,
                None => coverage_tile_from_bam(
                    &bam,
                    index.as_deref(),
                    reference_fasta.as_deref(),
                    &chrom,
                    start,
                    end,
                    bins,
                )?,
            };
            println!("{}", serde_json::to_string(&tile)?);
        }
        Command::BuildBase {
            bam,
            index,
            reference_fasta,
            chrom,
            out,
            base_bins,
            window_bp,
            threads,
        } => {
            let summary = build_base_layer_from_bam(
                &bam,
                index.as_deref(),
                reference_fasta.as_deref(),
                &chrom,
                base_bins,
                window_bp,
                threads,
                &out,
            )?;
            println!("{}", serde_json::to_string(&summary)?);
        }
        Command::SchemaVersion => {
            println!(
                "dna-coverage {} schema {}",
                env!("CARGO_PKG_VERSION"),
                SCHEMA_VERSION
            );
        }
    }
    Ok(())
}
