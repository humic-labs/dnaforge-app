# SPDX-License-Identifier: GPL-3.0-only
# Licensed under the GNU General Public License v3.0 as part of pLannotate v1.2.2 (https://github.com/barricklab/pLannotate); modified by DNAForge in 2026.
"""Vendored infernal parser from pLannotate v1.2.2.

Parses cmscan (Infernal) output into a pandas DataFrame.
Empty-result handling built in (no runtime patching needed).
"""

import pandas as pd

INFERNAL_COLUMNS = [
    "sseqid",
    "Feature",
    "accession",
    "qstart",
    "qend",
    "sstart",
    "send",
    "sframe",
    "score",
    "evalue",
    "Description",
    "qseq",
    "length",
    "slen",
    "pident",
]


def _empty_infernal_frame():
    return pd.DataFrame(columns=INFERNAL_COLUMNS)


def _parse_tblout_rows(lines):
    rows = []
    for line in lines:
        if not line.strip() or line.startswith("#"):
            continue

        parts = line.split(maxsplit=28)
        if len(parts) < 29:
            continue

        rows.append(
            {
                "#idx": parts[0],
                "target name": parts[1],
                "accession": parts[2],
                "clan name": parts[5],
                "seq from": parts[9],
                "seq to": parts[10],
                "mdl from": parts[7],
                "mdl to": parts[8],
                "strand": parts[11],
                "score": parts[16],
                "E-value": parts[17],
                "inc": parts[18],
                "description of target": parts[28],
            }
        )

    return pd.DataFrame(rows)


def parse_infernal(file_loc):
    with open(file_loc) as file_handle:
        lines = file_handle.readlines()

    if len(lines) < 2:
        return _empty_infernal_frame()

    infernal = _parse_tblout_rows(lines)
    if infernal.empty:
        return _empty_infernal_frame()

    columns = [
        "#idx",
        "target name",
        "accession",
        "clan name",
        "seq from",
        "seq to",
        "mdl from",
        "mdl to",
        "strand",
        "score",
        "E-value",
        "inc",
        "description of target",
    ]
    infernal = infernal[columns]
    infernal = infernal.loc[:, ~infernal.columns.duplicated()]
    replacements = {
        "#idx": "sseqid",
        "seq from": "qstart",
        "seq to": "qend",
        "mdl from": "sstart",
        "mdl to": "send",
        "E-value": "evalue",
        "strand": "sframe",
    }
    infernal = infernal.rename(columns=replacements)
    infernal["accession"] = infernal["accession"].str.replace("-", " ")
    infernal["clan name"] = infernal["clan name"].str.replace("-", " ")

    infernal = infernal.rename(
        columns={"target name": "Feature", "description of target": "Description"}
    )
    infernal["Feature"] = infernal["Feature"].str.replace("_", " ")
    infernal["Description"] = (
        "Accession: " + infernal["accession"] + " - " + infernal["Description"]
    )

    for col in infernal.columns:
        try:
            infernal[col] = pd.to_numeric(infernal[col])
        except (ValueError, TypeError):
            pass

    included = infernal["inc"] == "!"
    infernal.loc[included & (infernal["evalue"] >= 1), "evalue"] = 0

    coordinate_columns = ["qstart", "qend", "sstart", "send"]
    for col in coordinate_columns:
        infernal[col] = pd.to_numeric(infernal[col]).astype("int64")

    infernal["qseq"] = ""
    to_swap = infernal["qend"] < infernal["qstart"]
    infernal.loc[to_swap, ["qstart", "qend"]] = infernal.loc[
        to_swap, ["qend", "qstart"]
    ].values
    infernal[["qstart", "qend"]] = infernal[["qstart", "qend"]].apply(pd.to_numeric)
    infernal["sframe"] = infernal["sframe"].replace(["-", "+"], [-1, 1])
    infernal["length"] = abs(infernal["qend"] - infernal["qstart"]) + 1
    infernal["slen"] = abs(infernal["send"] - infernal["sstart"]) + 1
    infernal["pident"] = 100

    infernal = infernal.drop(columns=["accession", "clan name", "inc"])

    return infernal
