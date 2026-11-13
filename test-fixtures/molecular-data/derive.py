"""Derive measurements from unchanged deposited coordinates, never invented signals.

This independent fixture verifier supports the single-line loops in the pinned
mmCIF files. It deliberately refuses other layouts instead of guessing. It is
not supplied to the live agent, which must write and execute its own analysis.
B_iso is a deposited atomic displacement parameter, not mutation enrichment.
"""
import argparse
import csv
import hashlib
import json
import math
from pathlib import Path
import shlex


def cif_loop(path, category):
    lines = Path(path).read_text().splitlines()
    prefix = category + "."
    for index, line in enumerate(lines):
        if not line.startswith(prefix):
            continue
        headers = []
        while index < len(lines) and lines[index].startswith(prefix):
            headers.append(lines[index].strip())
            index += 1
        rows = []
        while index < len(lines):
            line = lines[index].strip()
            index += 1
            if line == "#":
                return rows
            if not line:
                continue
            cells = shlex.split(line)
            if len(cells) != len(headers):
                raise ValueError(f"Unsupported {category} row: {len(cells)} cells for {len(headers)} headers")
            rows.append(dict(zip(headers, cells)))
        return rows
    raise ValueError(f"Missing {category} loop in {path}")


def read_sites(path, model=1):
    if Path(path).suffix.lower() in (".cif", ".mmcif"):
        sites = []
        for row in cif_loop(path, "_atom_site"):
            if int(row["_atom_site.pdbx_PDB_model_num"]) != model:
                continue
            position = row["_atom_site.label_seq_id"]
            sites.append({
                "chain": row["_atom_site.label_asym_id"],
                "position": None if position in (".", "?") else int(position),
                "component": row["_atom_site.label_comp_id"],
                "b_iso": float(row["_atom_site.B_iso_or_equiv"]),
                "occupancy": float(row["_atom_site.occupancy"]),
            })
        return sites
    sites = []
    current_model = 1
    for line in Path(path).read_text().splitlines():
        if line.startswith("MODEL "):
            current_model = int(line[10:14])
        if current_model == model and line.startswith(("ATOM  ", "HETATM")):
            sites.append({"chain": line[21].strip(), "position": int(line[22:26]),
                          "component": line[17:20].strip(), "b_iso": float(line[60:66]),
                          "occupancy": float(line[54:60])})
    if not sites:
        raise ValueError(f"No atomic coordinates for model {model} in {path}")
    return sites


def weighted_b(sites):
    occupied = [site for site in sites if site["occupancy"] > 0]
    if any(not math.isfinite(site[key]) for site in sites for key in ("b_iso", "occupancy")):
        raise ValueError("Non-finite deposited atomic value")
    if not occupied:
        return None
    return math.fsum(site["b_iso"] * site["occupancy"] for site in occupied) / math.fsum(site["occupancy"] for site in occupied)


def derive_records(path, level="residues", chains=("A", "D", "H"), model=1):
    sites = [site for site in read_sites(path, model) if site["chain"] in chains]
    by_chain = {chain: [site for site in sites if site["chain"] == chain] for chain in chains}

    classes = {"A": "rna", "D": "protein", "H": "glycerol"} if Path(path).stem.upper() == "1URN" else {}
    if level == "chains":
        pooled = weighted_b(sites)
        return [{"chain": chain, "atom_count": len(atoms), "mean_b_iso": weighted_b(atoms),
                 "b_iso_log2_ratio": math.log2(weighted_b(atoms) / pooled) if weighted_b(atoms) and pooled else None,
                 "molecule_class": classes.get(chain, "")} for chain, atoms in by_chain.items()]
    addresses = []
    if Path(path).suffix.lower() in (".cif", ".mmcif"):
        entities = {row["_struct_asym.id"]: row["_struct_asym.entity_id"] for row in cif_loop(path, "_struct_asym")}
        sequence = cif_loop(path, "_entity_poly_seq")
        for chain in chains:
            encoded = [row for row in sequence if row["_entity_poly_seq.entity_id"] == entities[chain]]
            if encoded:
                addresses.extend((chain, int(row["_entity_poly_seq.num"]), row["_entity_poly_seq.mon_id"]) for row in encoded)
            else:
                addresses.extend(dict.fromkeys((site["chain"], site["position"], site["component"]) for site in by_chain[chain]))
    else:
        addresses = list(dict.fromkeys((site["chain"], site["position"], site["component"]) for site in sites))
    records = []
    for chain, position, component in addresses:
        atoms = [site for site in by_chain[chain] if site["position"] == position and site["component"] == component]
        mean = weighted_b(atoms)
        baseline = weighted_b(by_chain[chain])
        records.append({"chain": chain, "position": position, "component": component,
                        "atom_count": len(atoms), "mean_b_iso": mean,
                        "b_iso_log2_ratio": math.log2(mean / baseline) if mean and baseline else None,
                        "molecule_class": classes.get(chain, "")})
    return records


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("coordinates", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--level", choices=("residues", "chains"), default="residues")
    parser.add_argument("--chains", nargs="+", default=["A", "D", "H"])
    parser.add_argument("--model", type=int, default=1)
    parser.add_argument("--selectors", action="store_true", help="Retain real per-row native addresses in a JSON selector column")
    args = parser.parse_args()
    records = derive_records(args.coordinates, args.level, args.chains, args.model)
    if not records:
        raise ValueError("No deposited records selected")
    if args.selectors:
        for row in records:
            selector = {"label_asym_id": row["chain"]}
            if args.level == "residues":
                selector["label_comp_id"] = row["component"]
                if row["position"] is not None:
                    selector["label_seq_id"] = row["position"]
            row["native_target"] = json.dumps(selector, separators=(",", ":"))
    with args.output.open("w", newline="", encoding="utf-8") as output:
        writer = csv.DictWriter(output, fieldnames=list(records[0]))
        writer.writeheader()
        writer.writerows(records)
    print(json.dumps({"source": str(args.coordinates),
                      "sha256": hashlib.sha256(args.coordinates.read_bytes()).hexdigest(),
                      "model": args.model, "records": len(records),
                      "missingRows": [index for index, row in enumerate(records) if row["mean_b_iso"] is None]}))


if __name__ == "__main__":
    main()
