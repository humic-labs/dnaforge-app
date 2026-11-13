
use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use dna_assembly::{bind_one_target, Binding, Primer};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

mod genbank;

const SCHEMA_VERSION: u32 = 1;

#[derive(Parser, Debug)]
#[command(
    name = "dna-assembly",
    version = concat!(env!("CARGO_PKG_VERSION"), " schema 1"),
    about = "DNAForge assembly-graph compute (primer binding; GenBank parse to follow)",
    long_about = None,
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Bulk primer binding over a pooled target/primer library. Reads a JSON
    /// `{targets:[{name,sequence}], primers:[{name,sequence}]}` from --input or stdin.
    Bind {
        /// Input JSON path; omit or use "-" to read stdin.
        #[arg(long)]
        input: Option<String>,
    },
    /// Parse GenBank files via gb-io (replaces biopython SeqIO.read). Reads a
    /// JSON `{paths:[...]}` from --input or stdin; emits one ParsedRecord per
    /// path (parse failures are surfaced per-record, never dropped).
    ParseGenbank {
        /// Input JSON path; omit or use "-" to read stdin.
        #[arg(long)]
        input: Option<String>,
    },
    /// Print the schema-version handshake ({"schema_version": N}).
    SchemaVersion,
}

#[derive(Debug, Deserialize)]
struct ParseGenbankRequest {
    paths: Vec<String>,
}

#[derive(Debug, Serialize)]
struct ParseGenbankResponse {
    ok: bool,
    schema_version: u32,
    record_count: usize,
    records: Vec<genbank::ParsedRecord>,
}

#[derive(Debug, Deserialize)]
struct Target {
    name: String,
    sequence: String,
}

#[derive(Debug, Deserialize)]
struct BindRequest {
    max_edit: Option<u32>,
    targets: Vec<Target>,
    primers: Vec<Primer>,
}

#[derive(Debug, Serialize)]
struct BindResponse {
    bound_contract_version: u32,
    requested_max_edit: Option<u32>,
    applied_max_edit: u32,
    ok: bool,
    schema_version: u32,
    target_count: usize,
    primer_count: usize,
    binding_count: usize,
    deferred_short_primer_names: Vec<String>,
    bindings_by_target: BTreeMap<String, Vec<Binding>>,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::SchemaVersion => {
            println!("{{\"schema_version\": {SCHEMA_VERSION}}}");
        }
        Command::Bind { input } => run_bind(input)?,
        Command::ParseGenbank { input } => run_parse_genbank(input)?,
    }
    Ok(())
}

fn run_parse_genbank(input: Option<String>) -> Result<()> {
    let raw = read_input(input)?;
    let req: ParseGenbankRequest =
        serde_json::from_str(&raw).context("parse parse-genbank request JSON")?;
    let records: Vec<genbank::ParsedRecord> = req
        .paths
        .par_iter()
        .map(|path| genbank::parse_genbank_file(std::path::Path::new(path)))
        .collect();
    let resp = ParseGenbankResponse {
        ok: true,
        schema_version: SCHEMA_VERSION,
        record_count: records.len(),
        records,
    };
    println!("{}", serde_json::to_string(&resp)?);
    Ok(())
}

fn run_bind(input: Option<String>) -> Result<()> {
    let raw = read_input(input)?;
    let req: BindRequest = serde_json::from_str(&raw).context("parse bind request JSON")?;

    let per_target: Vec<(String, Vec<Binding>, Vec<usize>)> = req
        .targets
        .par_iter()
        .map(|t| {
            let (bindings, deferred) =
                bind_one_target(&t.sequence, &req.primers, req.max_edit.unwrap_or(2));
            (t.name.clone(), bindings, deferred)
        })
        .collect();

    let mut bindings_by_target: BTreeMap<String, Vec<Binding>> = BTreeMap::new();
    let mut binding_count = 0usize;
    let mut deferred_names: BTreeSet<String> = BTreeSet::new();
    for (name, bindings, deferred) in per_target {
        binding_count += bindings.len();
        for idx in deferred {
            deferred_names.insert(req.primers[idx].name.clone());
        }
        bindings_by_target.insert(name, bindings);
    }

    let resp = BindResponse {
        bound_contract_version: 1,
        requested_max_edit: req.max_edit,
        applied_max_edit: req.max_edit.unwrap_or(2).min(2),
        ok: true,
        schema_version: SCHEMA_VERSION,
        target_count: req.targets.len(),
        primer_count: req.primers.len(),
        binding_count,
        deferred_short_primer_names: deferred_names.into_iter().collect(),
        bindings_by_target,
    };
    println!("{}", serde_json::to_string(&resp)?);
    Ok(())
}

fn read_input(input: Option<String>) -> Result<String> {
    match input.as_deref() {
        None | Some("-") => {
            let mut buf = String::new();
            std::io::stdin()
                .read_to_string(&mut buf)
                .context("read stdin")?;
            Ok(buf)
        }
        Some(path) => std::fs::read_to_string(path).with_context(|| format!("read {path}")),
    }
}

#[cfg(test)]
mod bound_tests {
    use super::BindRequest;

    #[test]
    fn omitted_bound_preserves_legacy_ceiling_and_negative_is_rejected() {
        let omitted: BindRequest =
            serde_json::from_str(r#"{"targets":[],"primers":[]}"#).unwrap();
        assert_eq!(omitted.max_edit, None);
        assert_eq!(omitted.max_edit.unwrap_or(2).min(2), 2);
        assert!(serde_json::from_str::<BindRequest>(
            r#"{"targets":[],"primers":[],"max_edit":-1}"#
        )
        .is_err());
    }
}
