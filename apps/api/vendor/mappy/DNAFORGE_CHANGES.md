# DNAForge changes to mappy 2.31

The original archive, SHA-256, local package version and changed-file inventory
are recorded in `SOURCE_PROVENANCE.json`. The upstream MIT license remains in
`LICENSE.txt`. These changes preserve original scientific queries, scoring,
validity limits, ties, ordered results and reconstruction state.

## Request ownership and concurrency

The Python caller builds one index per request, uses one temporary buffer per
query worker and restores the caller's original record order. Queries are
scheduled longest first. `minimap.h` owns both concurrency limits and Cython
exports them to Python: the current request budget is 16 and the native per-map
limit is two. The caller divides the CPU-bounded request budget by that native
limit, allowing at most eight concurrent queries. There is no shared task queue.

Native scoring dispatches independent target/strand groups over disjoint arrays.
Each worker owns a reusable parent allocation arena and private child arenas.
The immutable scoring descriptor is separate from its atomic scheduling counter.
Workers join before serial reconstruction. Failed thread starts leave remaining
work to the caller and any successfully started worker.
Moderate batches retain the existing single worker while splitting independent
target groups for their existing compact indexing and exact state reuse. Batches
below 512 anchors keep the original combined path. Target boundaries within the
original active distance also keep that path, preserving original cross-boundary
maximum state for coordinate overflow cases.

Within one scoring call, groups with identical relative target and query
positions and original span, flag and segment payloads can reuse complete
scores, predecessors, skip tags and optional peak state. Hashes only select
candidates: every relative coordinate and original payload word is compared
before reuse. Constant target and query offsets require signed coordinate bounds
and a binary arithmetic certificate
that proves the original double priorities, ordering and ties remain exact.
The certificate bounds both the integer score and the coefficient product to
leave one mantissa bit for their addition. Unsupported precision, the index-zero
group, nonzero initial skip state and coordinate overflow keep independent
scoring. Copying happens after all workers join, with original global predecessor
and skip-tag indices restored. Allocation failure or unexpected state retains
independent scoring. The shared dispatcher applies this to both scoring stages;
every scientific query still runs.

## Exact candidate representations

Initial dynamic-programming scoring indexes eligible groups from 64 anchors by
query coordinate. Both representations use one helper to address bins relative
to the group's actual minimum query coordinate. The scientific coordinates and
validity interval remain absolute and unchanged. This avoids empty bins before
the first anchor and needless scalar fallback for a short region late in a long
query, while preserving the original allocation bound.
The original query interval touches at most two buckets.
Merging their linked lists in descending original anchor index preserves the
original scan order. Eligible single-segment groups also partition diagonal
coordinates using the original active target/query span. The table remains
bounded by four head slots per anchor; when space permits, its period exceeds
that span, avoiding redundant collision candidates. Remaining collisions retain
extra candidates for the original scorer to reject.
Original target windows, iteration limits, skip rules and maximum selection
remain in force. Checked allocation bounds and failed allocations retain the
original scalar scan.

The original scorer produces a bounded immutable integer penalty table for
eligible single-segment, non-cDNA, zero-skip mapping. Cached scoring retains all
original validity checks and exact arithmetic. Unsupported options, distances,
segments and failed allocations use the original calculation. Eligible large DP
groups use the existing 24-byte coordinate/score/predecessor/skip representation,
then export complete original arrays before reconstruction. Unsupported coordinate
bounds retain the existing index.
The same representation also serves eligible groups from 512 anchors, retaining
the original segment, coordinate, allocation and fallback checks. Complete frozen
state comparisons cover the new boundary and late-query coordinates; the full
original catalog deadline remains the performance acceptance criterion.

Second-pass range-query scoring keeps the canonical outer AVL selection and
original scoring. Eligible inner predecessor windows use coordinate lists and a
summary bitmap, with occupied-coordinate ranks for sparse ranges. Equal-query
anchors retain original order. Unsupported bounds, failed allocations and
inconsistent list operations use the original inner tree. Expiry uses the same
keyed eraser with an empty-root guard. Both scoring consumers share the original
band check and exact penalty helper; rejected scores are never consumed.

The tree iterator has an extra sentinel slot so its empty state stays inside the
allocated stack, retaining the original 64-node traversal capacity.

## Seed preparation, sorting and reconstruction

Eligible unnamed, unrestricted-strand seed preparation reuses exact query
payload fields and writes all original target postings in their original order.
Large batches may fill disjoint contiguous ranges on the caller and one added
worker after checking original retained counts against output capacity. Named,
restricted, small and unsupported inputs keep the original scalar path. Workers
join before descriptor release and sorting; no second anchor array is added.

Serial and parallel seed sorting share the canonical radix partition. Constant
digits perform no permutation, and parent-proven constant digits need no new
histogram scan. Original variable-digit cycle partitions, insertion thresholds,
recursive bucket order and tied-key payload order remain unchanged. Large seed
sorts may process disjoint child ranges on the caller and one added worker.
Small, single-core and failed-thread cases retain serial behavior.

Reconstruction walks the original sorted candidates once. Accepted descriptors
reuse already-processed temporary rows, then populate the original exact-sized
output in the same order. Reconstruction reads scores and predecessors, clears skip state and writes its
output index array. Earlier peak snapshots are not inputs. The output array is
allocated after scoring, avoiding unused peak storage and calculations. One
canonical projection supplies identical diagnostic peaks when requested.
Independent checks materialize them separately and poison the real output
buffer so instrumentation cannot supply data absent in ordinary execution.
No extra reconstruction array is introduced.

## Build, CLI and verification

The build cache tracks C, header, Cython and packaging inputs so edits rebuild the
actual installed extension. The packaged Python CLI forwards its intended
minimum-score option and retains the upstream interface.

Maintained native tests compile actual production source against frozen pre-change
routines. They compare complete score, predecessor, peak, skip, ordered chain,
anchor, sort and reconstruction arrays, including ties and fallback boundaries.
Address, undefined-behavior and thread checks cover their relevant owners.
Ordinary API tests exercise the installed locked extension. Complete catalog
inputs, all ordered public fields and the original runtime deadline must pass
together before performance qualification; smaller native comparisons do not
establish that result. Failed experiments remain in task evidence, outside the
production implementation description.
