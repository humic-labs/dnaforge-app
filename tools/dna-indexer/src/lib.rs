
pub mod assembly_fasta_input;
pub mod assembly_gff3_input;
pub mod cluster_id;
pub mod error;
pub mod exon_derive;
pub mod fasta_input;
pub mod fasta_inspect;
pub mod genbank;
pub mod gff3_input;
pub mod gff_emit;
pub mod inference;
pub mod lane_assign;
pub mod model;
pub mod output;
pub mod timing;

pub(crate) const ORIGIN_SPANNING_ATTR: &str = "_dnaforge_origin_spanning";
