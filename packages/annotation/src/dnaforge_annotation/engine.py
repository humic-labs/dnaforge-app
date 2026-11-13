# SPDX-License-Identifier: GPL-3.0-only
# Licensed under the GNU General Public License v3.0 as part of pLannotate v1.2.2 (https://github.com/barricklab/pLannotate); modified by DNAForge in 2026.
"""Vendored annotate module from pLannotate v1.2.2.

Streamlit dependency removed. Caching removed (sidecar requests are independent).
UI progress bars removed. Error handling converted to exceptions/safe defaults.
"""

import glob
import os
import signal
import shutil
import subprocess
import sys
import tempfile

import numpy as np
import pandas as pd

from .contract import AnnotationRuntime
from .infernal import parse_infernal
from .iupac import reverse_complement
from .resources import DF_COLS, get_yaml, get_yaml_path

RFAM_FULL_SENSITIVITY_MAX_LEN = 50_000


def _should_drop_rfam(true_length: int) -> bool:
    """Whether to DROP cmscan's --rfam speed filter (→ full sensitivity).

    Drop for inputs at or below the cutoff (full sensitivity, bounded runtime);
    keep the filter above it so genome-scale queries stay within budget. Callers
    MUST pass the EFFECTIVE cmscan query length — i.e. the DOUBLED length for a
    circular whole-sequence annotate (the budget the cutoff protects sees the 2x
    query), the plain length for linear inputs and subranges.
    """
    return true_length <= RFAM_FULL_SENSITIVITY_MAX_LEN


def _build_cmscan_args(
    cmscan_exe,
    drop_rfam,
    param_args,
    tmp_name,
    safe_clanin,
    safe_cm,
    query_name,
):
    """Assemble the cmscan argument list.

    `--rfam` (the speed-vs-sensitivity lever,  is included only when
    ``drop_rfam`` is False. `--cut_ga` (Rfam GA reporting thresholds) and
    `--nohmmonly` (force CM scoring) are kept in BOTH branches — only `--rfam`
    is conditional. Flag order matches the original vendored invocation, with
    ``*param_args`` (from db["parameters"]) landing last so yaml overrides win.
    """
    return [
        cmscan_exe,
        "--cut_ga",
        *(() if drop_rfam else ("--rfam",)),
        "--noali",
        "--nohmmonly",
        "--fmt",
        "2",
        *param_args,
        "--tblout",
        tmp_name,
        "--clanin",
        safe_clanin,
        safe_cm,
        query_name,
    ]


def _annotation_debug_enabled(env=None):
    if os.environ.get("DNAFORGE_ANNOTATION_DEBUG_ERRORS") == "1":
        return True
    return bool(env and env.get("DNAFORGE_ANNOTATION_DEBUG_ERRORS") == "1")


def _debug_frame(label, frame, columns):
    available = [col for col in columns if col in frame.columns]
    preview = frame[available].head(5).to_json(orient="records") if available else "[]"
    print(
        f"[annotate:debug] {label} rows={len(frame)} preview={preview}",
        file=sys.stderr,
    )


def _debug_tblout_preview(path):
    rows = []
    try:
        with open(path, "r") as handle:
            for line in handle:
                stripped = line.rstrip()
                if stripped.startswith("#idx") or stripped.startswith("#---"):
                    rows.append(stripped)
                elif stripped and not stripped.startswith("#"):
                    rows.append(stripped)
                if len(rows) >= 8:
                    break
    except OSError as exc:
        rows.append(f"<unable to read tblout: {exc}>")
    return " | ".join(rows)


def _new_temp_path(suffix: str = "", temp_dir=None) -> str:
    """Create a temp file and return its path with the OS handle CLOSED.

    Windows-safe replacement for ``NamedTemporaryFile().name`` : a
    NamedTemporaryFile keeps its handle open, and Windows refuses a second open
    of that path — so ``SeqIO.write(..., tmp.name)`` or a BLAST/Diamond/Infernal
    subprocess writing to ``tmp.name`` fails with ``PermissionError`` (works on
    POSIX, breaks on Windows). ``mkstemp`` hands back the path with the fd
    already closed, so the name is free for the next opener. Caller unlinks.
    """
    fd, name = tempfile.mkstemp(suffix=suffix, dir=temp_dir)
    os.close(fd)
    return name


def _windows_short_path(path: str) -> str | None:
    """Return an existing Windows directory's short path when 8.3 names are available."""
    if os.name != "nt":
        return None
    try:
        import ctypes

        get_short_path = ctypes.windll.kernel32.GetShortPathNameW
        required = get_short_path(path, None, 0)
        if required <= 0:
            return None
        output = ctypes.create_unicode_buffer(required)
        written = get_short_path(path, output, required)
        return output.value if 0 < written < required else None
    except (AttributeError, OSError):
        return None


def _space_free_alias_root(
    temp_dir=None,
    *,
    platform_name=None,
    system_temp_dir=None,
    windows_shortener=None,
) -> str:
    """Choose an existing scratch path that BLAST can use for database aliases.

    Query and output files continue to use ``AnnotationRuntime.temp_dir``. Only
    the transient database alias may escape that directory because BLAST cannot
    memory-map an index through a path containing whitespace.
    """
    platform_name = os.name if platform_name is None else platform_name
    system_temp_dir = (
        tempfile.gettempdir() if system_temp_dir is None else system_temp_dir
    )
    windows_shortener = windows_shortener or _windows_short_path
    candidates = (temp_dir, system_temp_dir)

    for candidate in candidates:
        if candidate is None:
            continue
        path = os.fspath(candidate)
        if not any(character.isspace() for character in path):
            return path
        if platform_name == "nt":
            shortened = windows_shortener(path)
            if shortened and not any(character.isspace() for character in shortened):
                return shortened

    raise RuntimeError(
        "BLAST database aliases require a whitespace-free temporary directory; "
        "neither AnnotationRuntime.temp_dir nor the system temporary directory "
        "has a usable path. Configure a space-free temporary directory"
        + (" or enable Windows short path names." if platform_name == "nt" else ".")
    )


def _safe_db_path(db_loc, temp_dir=None):
    """Return a space-free path to a BLAST/Diamond database.

    BLAST+ cannot memory-map database files whose paths contain spaces
    (e.g. macOS "Application Support"). When a space is detected we create
    symlinks in a temp directory that point back to the real files. On Windows,
    non-admin users often cannot create symlinks, so copy the small database file
    set instead.

    Returns (resolved_path, cleanup_dir_or_None).
    Caller must clean up the temp dir when done.
    """
    if " " not in str(db_loc):
        return str(db_loc), None

    alias_root = _space_free_alias_root(temp_dir)
    tmpdir = tempfile.mkdtemp(prefix="blast_db_", dir=alias_root)
    base = os.path.basename(str(db_loc))
    link_prefix = os.path.join(tmpdir, base)

    for real_file in glob.glob(str(db_loc) + "*"):
        ext = real_file[len(str(db_loc)) :]
        dest = link_prefix + ext
        if os.name == "nt":
            shutil.copy2(real_file, dest)
        else:
            os.symlink(real_file, dest)

    return link_prefix, tmpdir


def _env_path_value(env):
    """Return PATH from an env dict, accepting Windows' usual ``Path`` casing."""
    if not env:
        return None
    for key, value in env.items():
        if key.upper() == "PATH":
            return value
    return None


def _resolve_executable(name, env=None):
    """Resolve a CLI executable against the prepared subprocess env."""
    path = _env_path_value(env)
    resolved = shutil.which(name, path=path) if path is not None else shutil.which(name)
    return resolved or name


def _raise_for_process_failure(result, label):
    if result.returncode == 0:
        return
    detail = (result.stderr or result.stdout or "").strip()
    raise RuntimeError(
        f"{label} failed with exit code {result.returncode}"
        + (f": {detail}" if detail else "")
    )


def _terminate_process_tree(process):
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            capture_output=True,
            text=True,
            check=False,
        )
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def _run_external(args, *, env=None, owned=False):
    if not owned:
        return subprocess.run(args, capture_output=True, text=True, env=env)
    options = {}
    if os.name == "nt":
        options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        options["start_new_session"] = True
    process = subprocess.Popen(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
        **options,
    )
    try:
        stdout, stderr = process.communicate()
    except BaseException:
        _terminate_process_tree(process)
        process.wait()
        raise
    return subprocess.CompletedProcess(args, process.returncode, stdout, stderr)


def BLAST(seq, db, env=None, drop_rfam=False, runtime=None):
    """Run one database search, guaranteeing temp-file cleanup even on error.

    Windows-safe: temp paths come from _new_temp_path (closed handles) and are
    unlinked in this wrapper's finally, so a raised FileNotFoundError (e.g. a
    missing cmscan on Windows, caught upstream in get_raw_hits) never leaks.
    """
    temp_dir = runtime.temp_dir if runtime is not None else None
    query_name = _new_temp_path(suffix=".fasta", temp_dir=temp_dir)
    tmp_name = _new_temp_path(temp_dir=temp_dir)
    try:
        return _run_blast(
            seq,
            db,
            query_name,
            tmp_name,
            env=env,
            drop_rfam=drop_rfam,
            runtime=runtime,
        )
    finally:
        for _path in (query_name, tmp_name):
            try:
                os.unlink(_path)
            except OSError:
                pass


def _run_blast(seq, db, query_name, tmp_name, env=None, drop_rfam=False, runtime=None):
    task = db["method"]
    parameters = db["parameters"]
    db_loc = db["db_loc"]
    with open(query_name, "w", encoding="utf-8", newline="\n") as query_file:
        query_file.write(">temp\n")
        for offset in range(0, len(seq), 80):
            query_file.write(seq[offset : offset + 80] + "\n")

    param_args = parameters.split() if parameters else []

    if task == "blastn":
        safe_loc, tmpdir = _safe_db_path(
            db_loc, runtime.temp_dir if runtime is not None else None
        )
        flags = (
            "qstart qend sseqid sframe pident slen qseq length sstart send qlen evalue"
        )
        args = [
            db.get("executable") or _resolve_executable("blastn", env),
            "-task",
            "blastn-short",
            "-query",
            query_name,
            "-out",
            tmp_name,
            "-db",
            safe_loc,
            *param_args,
            "-outfmt",
            f"6 {flags}",
        ]
        try:
            result = _run_external(args, env=env, owned=runtime is not None)
            _raise_for_process_failure(result, "BLAST search")
        finally:
            if tmpdir:
                shutil.rmtree(tmpdir, ignore_errors=True)

    elif task == "diamond":
        safe_loc, tmpdir = _safe_db_path(
            db_loc, runtime.temp_dir if runtime is not None else None
        )
        flags = "qstart qend sseqid pident slen qseq length sstart send qlen evalue"
        args = [
            db.get("executable") or _resolve_executable("diamond", env),
            "blastx",
            "-d",
            safe_loc,
            "-q",
            query_name,
            "-o",
            tmp_name,
            *param_args,
            "--outfmt",
            "6",
            *flags.split(),
        ]
        try:
            result = _run_external(args, env=env, owned=runtime is not None)
            _raise_for_process_failure(result, "Diamond search")
        finally:
            if tmpdir:
                shutil.rmtree(tmpdir, ignore_errors=True)

    elif task == "infernal":
        clanin_path, cm_path = db_loc
        temp_dir = runtime.temp_dir if runtime is not None else None
        safe_clanin, tmpdir1 = _safe_db_path(clanin_path, temp_dir)
        safe_cm, tmpdir2 = _safe_db_path(cm_path, temp_dir)
        args = _build_cmscan_args(
            db.get("executable") or _resolve_executable("cmscan", env),
            drop_rfam,
            param_args,
            tmp_name,
            safe_clanin,
            safe_cm,
            query_name,
        )
        try:
            result = _run_external(args, env=env, owned=runtime is not None)
            _raise_for_process_failure(result, "Infernal cmscan")
        finally:
            if tmpdir1:
                shutil.rmtree(tmpdir1, ignore_errors=True)
            if tmpdir2:
                shutil.rmtree(tmpdir2, ignore_errors=True)
        inDf = parse_infernal(tmp_name)

        if _annotation_debug_enabled(env):
            _debug_frame(
                "infernal.parse",
                inDf,
                [
                    "sseqid",
                    "Feature",
                    "Description",
                    "qstart",
                    "qend",
                    "sstart",
                    "send",
                    "score",
                    "evalue",
                    "length",
                    "slen",
                ],
            )
            if inDf.empty:
                print(
                    "[annotate:debug] infernal.tblout "
                    + _debug_tblout_preview(tmp_name),
                    file=sys.stderr,
                )

        inDf["qlen"] = len(seq)

        if not inDf.empty:
            inDf["qseq"] = inDf.apply(
                lambda x: (seq)[int(x["qstart"]) - 1 : int(x["qend"])].upper(),
                axis=1,
            )

        return inDf

    with open(tmp_name, "r") as file_handle:
        align = file_handle.readlines()

    inDf = pd.DataFrame([ele.split() for ele in align], columns=flags.split())
    string_cols = {"sseqid", "qseq"}
    for col in inDf.columns:
        if col in string_cols:
            continue
        try:
            inDf[col] = pd.to_numeric(inDf[col])
        except (ValueError, TypeError):
            pass

    if task == "diamond":
        try:
            inDf["sseqid"] = inDf["sseqid"].str.split("|", n=2, expand=True)[1]
        except (ValueError, KeyError):
            pass
        inDf["sframe"] = (inDf["qstart"] < inDf["qend"]).astype(int).replace(0, -1)
        inDf["slen"] = inDf["slen"] * 3
        inDf["length"] = abs(inDf["qend"] - inDf["qstart"]) + 1

    return inDf


def calculate(inDf, is_linear):
    inDf["qstart"] = inDf["qstart"] - 1
    inDf["qend"] = inDf["qend"] - 1

    inDf["qstart"], inDf["qend"] = (
        inDf[["qstart", "qend"]].min(axis=1),
        inDf[["qstart", "qend"]].max(axis=1),
    )
    inDf["percmatch"] = inDf["length"] / inDf["slen"] * 100
    inDf["abs percmatch"] = 100 - abs(100 - inDf["percmatch"])
    inDf["pi_permatch"] = (inDf["pident"] * inDf["abs percmatch"]) / 100
    inDf["score"] = (inDf["pi_permatch"] / 100) * inDf["length"]

    inDf["score"] = inDf["score"] * (2 ** (-1 * inDf["priority"].astype(float)) * 2)

    if is_linear is False:
        inDf["qlen"] = (inDf["qlen"] / 2).astype("int")

    bonus = (1 / inDf["priority"]) * 10
    inDf.loc[inDf["pi_permatch"] == 100, "score"] = (
        inDf.loc[inDf["pi_permatch"] == 100, "score"] * bonus
    )

    wiggleSize = 0.15
    inDf["wiggle"] = (inDf["length"] * wiggleSize).astype(int)
    inDf["wstart"] = inDf["qstart"] + inDf["wiggle"]
    inDf["wend"] = inDf["qend"] - inDf["wiggle"]

    return inDf


def clean(inDf):
    inDf["qstart_dup"] = inDf["qstart"]
    inDf["qend_dup"] = inDf["qend"]
    inDf["qstart"] = np.where(
        inDf["qstart"] >= inDf["qlen"], inDf["qstart"] - inDf["qlen"], inDf["qstart"]
    )
    inDf["qend"] = np.where(
        inDf["qend"] >= inDf["qlen"], inDf["qend"] - inDf["qlen"], inDf["qend"]
    )

    inDf["wstart"] = np.where(
        inDf["wstart"] >= inDf["qlen"], inDf["wstart"] - inDf["qlen"], inDf["wstart"]
    )
    inDf["wend"] = np.where(
        inDf["wend"] >= inDf["qlen"], inDf["wend"] - inDf["qlen"], inDf["wend"]
    )

    problem_hits = ["P03851", "P03845", "ISS", "P03846"]
    inDf = inDf.loc[~inDf["sseqid"].isin(problem_hits)]

    inDf = inDf.loc[inDf["evalue"] < 1]

    inDf = inDf.loc[inDf["pi_permatch"] > 3]

    inDf = inDf.drop_duplicates()
    inDf = inDf.reset_index(drop=True)

    if inDf.empty:
        inDf = pd.DataFrame(columns=DF_COLS)
        return inDf

    seqSpace = []
    end = int(inDf["qlen"][0])

    string_cols = {"sseqid", "qseq"}
    for col in inDf.columns:
        if col in string_cols:
            continue
        try:
            inDf[col] = pd.to_numeric(inDf[col], downcast="integer")
        except (ValueError, TypeError):
            pass

    for i in inDf.index:
        wstart = int(inDf.loc[i]["wstart"])
        wend = int(inDf.loc[i]["wend"])

        sseqid = [inDf.loc[i]["sseqid"]]

        if wend < wstart:
            left = (wend + 1) * [inDf.loc[i]["kind"]]
            center = (wstart - wend - 1) * [None]
            right = (end - wstart + 0) * [inDf.loc[i]["kind"]]
        else:
            left = wstart * [None]
            center = (wend - wstart + 1) * [inDf.loc[i]["kind"]]
            right = (end - wend - 1) * [None]

        seqSpace.append(sseqid + left + center + right)

    seqSpace = pd.DataFrame(seqSpace, columns=["sseqid"] + list(range(0, end)))
    seqSpace = seqSpace.set_index([seqSpace.index, "sseqid"])
    toDrop = set()
    for i in range(len(seqSpace)):
        if seqSpace.iloc[i].name in toDrop:
            continue

        end = int(inDf["qlen"][0])
        qstart = int(inDf.loc[seqSpace.iloc[i].name[0]]["qstart"])
        qend = int(inDf.loc[seqSpace.iloc[i].name[0]]["qend"])
        kind = inDf.loc[seqSpace.iloc[i].name[0]]["kind"]

        if qstart < qend:
            columnSlice = list(range(qstart + 1, qend + 1))
        else:
            columnSlice = list(range(0, qend + 1)) + list(range(qstart, end))

        rowSlice = (seqSpace[columnSlice] == kind).any(axis=1)
        toDrop = toDrop | set(seqSpace[rowSlice].loc[i + 1 :].index)

    seqSpace = seqSpace.drop(toDrop)
    inDf = inDf.loc[seqSpace.index.get_level_values(0)]
    inDf = inDf.reset_index(drop=True)

    return inDf


def parse_gz(sseqids, gz_loc):
    """Look up feature names from a gzip-compressed CSV."""
    import csv
    import gzip

    sseqid_set = set(sseqids)
    rows = []
    with gzip.open(gz_loc, "rt", encoding="utf-8", errors="replace") as fh:
        reader = csv.reader(fh)
        for row in reader:
            if row and row[0] in sseqid_set:
                rows.append(row[:3])
    gz_details = pd.DataFrame(rows, columns=["sseqid", "Feature", "Description"])
    return gz_details


def get_details(inDf, yaml_file_loc, runtime=None):
    databases = (
        get_yaml(yaml_file_loc, runtime=runtime)
        if runtime is not None
        else get_yaml(yaml_file_loc)
    )

    assert (
        len(set(inDf["db"].to_list())) == 1
    ), "All hits must be from the same database"
    database_name = inDf["db"].to_list()[0]

    database = databases[database_name]

    sseqids = inDf.loc[inDf["db"] == database_name]["sseqid"].tolist()
    sseqids = [_ for _ in sseqids if _]

    problem_name = r"pdb\|(.*)\|"
    inDf["sseqid"] = inDf["sseqid"].str.replace(problem_name, r"\1", regex=True)

    db_details = database["details"]

    if db_details["location"] == "None":
        feat_desc = inDf.loc[inDf["db"] == database_name][
            ["sseqid", "Feature", "Description"]
        ]

    else:
        if db_details["location"] == "Default":
            from .resources import get_details as get_details_path

            data_dir = runtime.data_dir if runtime is not None else None
            details_file_loc = (
                get_details_path(database_name, data_dir=data_dir) + ".csv"
            )
        else:
            details_file_loc = db_details["location"]

        if db_details["compressed"] is True:
            details_file_loc += ".gz"
            feat_desc = parse_gz(sseqids, details_file_loc)
        else:
            feat_desc = pd.read_csv(details_file_loc)

        if database_name == "swissprot":
            level = feat_desc["Description"].str.find("existence level") + 16
            feat_desc["s"] = level
            feat_desc["e"] = level + 1

            def calc_priority_mod(d, s, e):
                if s == 15 and e == 16:
                    return 0
                else:
                    return int(d[s:e]) - 1

            feat_desc["priority_mod"] = [
                calc_priority_mod(d, s, e)
                for d, s, e in zip(
                    feat_desc["Description"],
                    feat_desc["s"],
                    feat_desc["e"],
                    strict=False,
                )
            ]
            feat_desc = feat_desc.drop(columns=["s", "e"])

    if db_details["default_type"] != "None":
        feat_desc["Type"] = db_details["default_type"]
    else:
        pass

    return feat_desc


def get_raw_hits(query, linear, yaml_file_loc, env=None, drop_rfam=False, runtime=None):
    databases = (
        get_yaml(yaml_file_loc, runtime=runtime)
        if runtime is not None
        else get_yaml(yaml_file_loc)
    )

    raw_hits = []
    for database_name in databases:
        database = databases[database_name]
        try:
            blast_options = {"env": env, "drop_rfam": drop_rfam}
            if runtime is not None:
                blast_options["runtime"] = runtime
            hits = BLAST(seq=query, db=database, **blast_options)
        except FileNotFoundError as exc:
            if runtime is not None:
                raise
            print(
                f"[annotate] Skipping database '{database_name}': required tool not found ({exc}).",
                file=sys.stderr,
            )
            continue

        if hits.empty:
            continue

        hits["db"] = database_name
        hits["sseqid"] = hits["sseqid"].astype(str)

        feat_descriptions = (
            get_details(hits, yaml_file_loc, runtime=runtime)
            if runtime is not None
            else get_details(hits, yaml_file_loc)
        )
        hits = hits.merge(
            feat_descriptions, on="sseqid", how="left", suffixes=("_x", None)
        )
        hits = hits[hits.columns.drop(list(hits.filter(regex="_x")))]

        hits = hits.loc[hits["Type"] != "primer_bind"]

        hits["priority"] = database["priority"]
        try:
            hits["priority"] = hits["priority"] + hits["priority_mod"]
            hits = hits.drop("priority_mod", axis=1)
        except KeyError:
            pass
        hits = calculate(hits, is_linear=linear)
        if database_name == "Rfam" and _annotation_debug_enabled(env):
            _debug_frame(
                "Rfam.calculate",
                hits,
                [
                    "sseqid",
                    "Feature",
                    "Description",
                    "qstart",
                    "qend",
                    "length",
                    "slen",
                    "percmatch",
                    "pi_permatch",
                    "score",
                    "wstart",
                    "wend",
                ],
            )

        raw_hits.append(hits)

    if len(raw_hits) == 0:
        return pd.DataFrame()

    blastDf = pd.concat(raw_hits)

    blastDf = blastDf.sort_values(
        by=["score", "length", "percmatch"], ascending=[False, False, False]
    )

    return blastDf


def annotate(
    inSeq,
    yaml_file=None,
    linear=False,
    is_detailed=False,
    env=None,
    runtime=None,
):
    if yaml_file is None:
        yaml_file = get_yaml_path()

    sequence = str(inSeq)

    effective_query_len = len(sequence) * (2 if linear is False else 1)
    drop_rfam = _should_drop_rfam(effective_query_len)

    if linear is False:
        query = sequence + sequence
    elif linear is True:
        query = sequence
    else:
        raise ValueError("Invalid linear parameter")

    raw_hit_options = {"env": env, "drop_rfam": drop_rfam}
    if runtime is not None:
        raw_hit_options["runtime"] = runtime
    blastDf = get_raw_hits(query, linear, yaml_file, **raw_hit_options)

    if blastDf.empty:
        blastDf = pd.DataFrame(columns=DF_COLS)
        return blastDf

    if is_detailed is True:
        blastDf["kind"] = blastDf["Type"]
    else:
        blastDf["kind"] = 1

    blastDf = clean(blastDf)
    if _annotation_debug_enabled(env):
        _debug_frame(
            "annotate.clean",
            blastDf,
            [
                "db",
                "sseqid",
                "Feature",
                "Description",
                "qstart",
                "qend",
                "score",
            ],
        )

    if blastDf.empty:
        blastDf = pd.DataFrame(columns=DF_COLS)
        return blastDf

    def is_fragment(feature):
        if feature["Type"] == "CDS":
            if feature["pi_permatch"] == 100:
                return False
            elif ((feature["length"] % 3) == 0) & (feature["percmatch"] > 95):
                return False
            else:
                return True
        elif feature["Type"] != "CDS":
            if feature["percmatch"] < 95:
                return True
            else:
                return False
        else:
            return True

    blastDf["fragment"] = blastDf.apply(is_fragment, axis=1)

    if blastDf.empty:
        blastDf = pd.DataFrame(columns=DF_COLS)
        return blastDf

    blastDf["qend"] = blastDf["qend"] + 1

    blastDf["qseq"] = blastDf.apply(
        lambda x: (
            reverse_complement(str(x["qseq"])) if x["sframe"] == -1 else x["qseq"]
        ),
        axis=1,
    )

    blastDf["Feature"] = blastDf["Feature"].fillna(blastDf["sseqid"])
    blastDf["Description"] = blastDf["Description"].fillna("")
    blastDf["Type"] = blastDf["Type"].fillna("misc_feature")

    return blastDf


def annotate_sequence(
    sequence: str, *, linear: bool, runtime: AnnotationRuntime
) -> list[dict[str, object]]:
    """Run the vendored engine with one explicit runtime and return plain rows."""
    if runtime.temp_dir is not None:
        runtime.temp_dir.mkdir(parents=True, exist_ok=True)
    result = annotate(
        sequence,
        yaml_file=str(runtime.database_config or get_yaml_path()),
        linear=linear,
        is_detailed=False,
        runtime=runtime,
    )
    return result.to_dict(orient="records")
