static uint64_t random_state = 0x6a12bd9ce541f083ULL;
static uint32_t next_random(void)
{
    random_state ^= random_state << 13;
    random_state ^= random_state >> 7;
    random_state ^= random_state << 17;
    return (uint32_t)random_state;
}

static int iterator_boundaries_exact(void)
{
    krmq_itr_t(lc_elem) itr;
    krmq_itr_first(lc_elem, 0, &itr);
    if (krmq_at(&itr) || krmq_itr_next(lc_elem, &itr) || krmq_itr_prev(lc_elem, &itr)) return 0;
    lc_elem_t nodes[3] = {{0}}, *root = 0;
    for (int i = 0; i < 3; ++i) {
        nodes[i].y = (i + 1) * 10;
        nodes[i].i = i;
        nodes[i].pri = i;
        krmq_insert(lc_elem, &root, &nodes[i], 0);
    }
    krmq_itr_first(lc_elem, root, &itr);
    for (int i = 0; i < 3; ++i) {
        if (krmq_at(&itr) != &nodes[i]) return 0;
        if (!!krmq_itr_next(lc_elem, &itr) != (i < 2)) return 0;
    }
    if (krmq_at(&itr) || krmq_itr_next(lc_elem, &itr)) return 0;
    if (!krmq_itr_find(lc_elem, root, &nodes[2], &itr)) return 0;
    for (int i = 2; i >= 0; --i) {
        if (krmq_at(&itr) != &nodes[i]) return 0;
        if (!!krmq_itr_prev(lc_elem, &itr) != (i > 0)) return 0;
    }
    return !krmq_at(&itr) && !krmq_itr_prev(lc_elem, &itr);
}

static int shifted_predecessor_intervals_exact(void)
{
    static const uint32_t edges[] = {0, 1, 63, 64, 65, 4095, 4096, 65535};
    const uint32_t offset = 1000000;
    mm128_t anchors[512] = {{0}};
    for (int i = 0; i < 512; ++i) anchors[i].y = offset + edges[i % 8];
    dnaforge_inner_index_t index = dnaforge_inner_index_init(0, anchors, 0, 512, 1000, 1000);
    if (!index.enabled) return 0;
    for (int i = 0; i < 512; ++i)
        if (!dnaforge_inner_index_insert(&index, (int32_t)anchors[i].y, i)) return 0;
    if (dnaforge_inner_index_predecessor(&index, offset - 1) != -1 ||
        dnaforge_inner_index_predecessor(&index, offset) != 504 ||
        dnaforge_inner_index_predecessor(&index, offset + 62) != 505 ||
        dnaforge_inner_index_predecessor(&index, offset + 63) != 506 ||
        dnaforge_inner_index_predecessor(&index, offset + 65535) != 511 ||
        dnaforge_inner_index_predecessor(&index, offset + 65536) != 511 ||
        dnaforge_inner_index_previous(&index, anchors, 511) != 503) return 0;
    for (int i = 0; i < 512; ++i)
        if (!dnaforge_inner_index_erase(&index, (int32_t)anchors[i].y, i)) return 0;
    if (index.count || dnaforge_inner_index_predecessor(&index, offset + 65535) != -1) return 0;
    kfree(0, index.head); kfree(0, index.tail);
    kfree(0, index.previous); kfree(0, index.next);
    kfree(0, index.bits); kfree(0, index.summary);
    kfree(0, index.coordinates); kfree(0, index.ranks);
    index = dnaforge_inner_index_init(0, anchors, 0, 511, 1000, 1000);
    if (!index.enabled) return 0;
    kfree(0, index.head); kfree(0, index.tail);
    kfree(0, index.previous); kfree(0, index.next);
    kfree(0, index.bits); kfree(0, index.summary);
    kfree(0, index.coordinates); kfree(0, index.ranks);
    if (dnaforge_inner_index_init(0, anchors, 0, 63, 1000, 1000).enabled) return 0;
    anchors[511].y = offset + 65536;
    index = dnaforge_inner_index_init(0, anchors, 0, 512, 1000, 1000);
    if (!index.enabled || !index.coordinates || index.slots != 9) return 0;
    for (int i = 0; i < 512; ++i)
        if (!dnaforge_inner_index_insert(&index, (int32_t)anchors[i].y, i)) return 0;
    if (dnaforge_inner_index_predecessor(&index, offset + 65536) != 511) return 0;
    kfree(0, index.head); kfree(0, index.tail);
    kfree(0, index.previous); kfree(0, index.next);
    kfree(0, index.bits); kfree(0, index.summary);
    kfree(0, index.coordinates); kfree(0, index.ranks);
    anchors[0].y = UINT32_MAX;
    if (dnaforge_inner_index_init(0, anchors, 0, 512, 1000, 1000).enabled) return 0;
    return 1;
}

static int compressed_predecessor_intervals_exact(void)
{
    static const uint32_t edges[] = {0, 1, 63, 64, 65, 4095, 4096, 1000000000};
    const uint32_t offset = 1000000000;
    const int begin = 17, count = 512;
    mm128_t anchors[529] = {{0}};
    for (int i = 0; i < count; ++i) anchors[begin + i].y = offset + edges[i % 8];
    anchors[begin + count - 1].y = INT32_MAX;
    dnaforge_inner_index_t index = dnaforge_inner_index_init(0, anchors, begin, begin + count, 1000, 1000);
    if (!index.enabled || !index.coordinates || !index.ranks || index.slots != 9 || index.words != 1 || index.summaries != 1) return 0;
    for (int i = begin; i < begin + count; ++i)
        if (!dnaforge_inner_index_insert(&index, (int32_t)anchors[i].y, i)) return 0;
    if (dnaforge_inner_index_predecessor(&index, offset - 1) != -1 ||
        dnaforge_inner_index_predecessor(&index, offset) != begin + 504 ||
        dnaforge_inner_index_predecessor(&index, offset + 62) != begin + 505 ||
        dnaforge_inner_index_predecessor(&index, offset + 4096) != begin + 510 ||
        dnaforge_inner_index_predecessor(&index, INT32_MAX - 1) != begin + 503 ||
        dnaforge_inner_index_predecessor(&index, INT32_MAX) != begin + 511 ||
        dnaforge_inner_index_previous(&index, anchors, begin + 511) != begin + 503) return 0;
    for (int i = begin; i < begin + count; ++i)
        if (!dnaforge_inner_index_erase(&index, (int32_t)anchors[i].y, i)) return 0;
    if (index.count || dnaforge_inner_index_predecessor(&index, INT32_MAX) != -1) return 0;
    kfree(0, index.head); kfree(0, index.tail);
    kfree(0, index.previous); kfree(0, index.next);
    kfree(0, index.bits); kfree(0, index.summary);
    kfree(0, index.coordinates); kfree(0, index.ranks);
    return 1;
}

static int simple_cached_scores_exact(void)
{
    const int widths[] = {0, 1, 7, 500, 32768, 32769, 500, 500};
    const float gaps[] = {0.0f, 0.088f, 0.11f, 0.45f, 0.001f, 0.088f, -0.1f, 0.088f};
    for (int scenario = 0; scenario < 8; ++scenario) {
        const float skip = scenario == 7 ? 0.01f : 0.0f;
        dnaforge_chain_work_t work = { .n_seg = 1, .bw = widths[scenario], .chn_pen_gap = gaps[scenario], .chn_pen_skip = skip };
        int32_t *penalties = dnaforge_prepare_chain_penalties(&work);
        if ((penalties != 0) != (scenario < 5)) return 0;
        for (int test = 0; test < 250000; ++test) {
            const int32_t dq = (int32_t)(next_random() % 70001) - 35000;
            const int32_t dr = test < 12 ? dq + (test % 3) + widths[scenario] - 1 : (int32_t)(next_random() % 70001) - 35000;
            const uint32_t span = next_random() & 255;
            const mm128_t previous = { .x = 1000000, .y = ((uint64_t)span << 32) | 1000000 };
            const mm128_t current = { .x = (uint64_t)(1000000 + dr), .y = (uint32_t)(1000000 + dq) };
            int32_t exact[2] = {123, 123}, width[2] = {123, 123};
            int32_t *actual_exact = test & 1 ? &exact[0] : 0;
            int32_t *reference_exact = test & 1 ? &exact[1] : 0;
            const int32_t actual = dnaforge_comput_simple_cached_sc(&current, &previous, gaps[scenario], skip, actual_exact, &width[0], penalties, widths[scenario]);
            const int32_t reference = dnaforge_reference_comput_sc_simple(&current, &previous, gaps[scenario], skip, reference_exact, &width[1]);
            if (actual != reference || exact[0] != exact[1] || width[0] != width[1]) {
                printf("{\"simpleScenario\":%d,\"scoreCase\":%d,\"rawScoreAndFlagsExact\":false}\n", scenario, test);
                return 0;
            }
            int32_t band_score = 123456, band_exact = 123, band_width = 123;
            const int accepted = dnaforge_comput_simple_in_band(&current, &previous, gaps[scenario], skip, test & 1 ? &band_exact : 0, &band_width, penalties, widths[scenario], &band_score);
            if (accepted != (width[1] <= widths[scenario]) || band_exact != exact[1] || band_width != width[1] || (accepted ? band_score != reference : band_score != 123456)) return 0;
        }
        free(penalties);
    }
    const mm128_t previous = { .x = 0, .y = 20ULL << 32 };
    const mm128_t current = { .x = 10, .y = 10 };
    int32_t score = 123456, exact = 123, width = 123;
    if (dnaforge_comput_simple_in_band(&current, &previous, 0.088f, 0.0f, &exact, &width, 0, -1, &score)) return 0;
    if (score != 123456 || exact != 1 || width != 0) return 0;
    return 1;
}

int main(void)
{
    if (!iterator_boundaries_exact()) return 23;
    if (!shifted_predecessor_intervals_exact()) return 25;
    if (!compressed_predecessor_intervals_exact()) return 26;
    uint64_t anchors = 0;
    for (int test = 0; test < 120; ++test) {
        const int64_t n = test >= 104 ? (int[]){63, 64, 65, 127, 128, 129, 511, 512}[(test - 104) % 8] : test >= 96 ? (test % 2 ? 8192 : 60000) : test >= 88 ? 1024 + (test - 88) * 256 : test >= 82 ? 8192 : test >= 64 ? 60000 : test % 8 == 0 ? 60000 : 512 + next_random() % 2048;
        const int groups = 1 + test % 7;
        const int64_t group_size = (n + groups - 1) / groups;
        mm128_t *a[2];
        for (int copy = 0; copy < 2; ++copy) {
            a[copy] = malloc((size_t)n * sizeof(mm128_t));
            if (!a[copy]) return 20;
        }
        uint32_t target = 256;
        for (int64_t i = 0; i < n; ++i) {
            if (i % group_size == 0) target = 256;
            target += next_random() % 12;
            const uint64_t group = ((test / 8) % 2 ? 0x80000000ULL : 3) + i / group_size;
            uint32_t q = test % 3 == 0 ? target + next_random() % 100 : 256 + next_random() % 40000;
            if (test >= 64) {
                static const uint32_t edges[] = {0, 1, 63, 64, 65, 4095, 4096, 65535};
                q = i % 3 == 0 ? edges[i % 8] : next_random() % 65536;
            }
            if (test >= 80) q += 1000000 + (test - 80) * 200000;
            if (test >= 96) q = 1000000000U + (next_random() % 64) * 10000000U + target % 4096;
            a[0][i].x = (group << 32) | target;
            a[0][i].y = ((uint64_t)(next_random() % 3) << MM_SEED_SEG_SHIFT) | ((uint64_t)(1 + next_random() % 31) << 32) | q;
            if (test >= 64) a[0][i].y = (a[0][i].y & ~(0xffULL << 32)) | ((uint64_t)(1 + q % 31) << 32);
        }
        memcpy(a[1], a[0], (size_t)n * sizeof(mm128_t));
        const int max_dist = 100 + next_random() % 5000;
        const int inner = test % 4 == 0 ? 1000 : (int)(next_random() % (max_dist * 2)) - 1;
        const int bw = test % 5 == 0 ? 20000 : 50 + next_random() % 500;
        const int skip = test % 3 == 0 ? 0 : 1 + next_random() % 25;
        const int cap = test >= 64 ? (int[]){1, 2, 63, 64, 65, 1000, 100000}[(test - 64) % 7] : test % 8 == 0 ? 100000 : 1 + next_random() % 1024;
        const float gap = test % 11 == 0 ? 0.0f : 0.088f;
        const float penalty_skip = test % 2 == 0 ? 0.0f : 0.01f;
        int n_u[2] = {0, 0};
        uint64_t *u[2] = {0, 0};
        observed_slot = 0;
        observed_root_arenas = 0;
        mm128_t *out[2];
        out[0] = mg_lchain_rmq(max_dist, inner, bw, skip, cap, 1, 5, gap, penalty_skip, n, a[0], &n_u[0], &u[0], 0);
        if (observed_root_arenas < 1 || observed_root_arenas > 2) {
            printf("{\"case\":%d,\"rootArenas\":%d,\"boundedWorkerStorage\":false}\n", test, observed_root_arenas);
            return 24;
        }
        out[1] = dnaforge_reference_mg_lchain_rmq(max_dist, inner, bw, skip, cap, 1, 5, gap, penalty_skip, n, a[1], &n_u[1], &u[1], 0);
        if (observed_slot != 2) return 21;
        for (int64_t i = 0; i < n; ++i) {
            if (observed[0].f[i] != observed[1].f[i] || observed[0].p[i] != observed[1].p[i] || observed[0].v[i] != observed[1].v[i] || observed[0].t[i] != observed[1].t[i]) {
                printf("{\"case\":%d,\"anchor\":%lld,\"stateExact\":false}\n", test, (long long)i);
                return 1;
            }
        }
        if (n_u[0] != n_u[1] || (n_u[0] > 0 && memcmp(u[0], u[1], (size_t)n_u[0] * sizeof(uint64_t)))) return 2;
        int64_t used = 0;
        for (int i = 0; i < n_u[0]; ++i) used += (uint32_t)u[0][i];
        if (used > 0 && memcmp(out[0], out[1], (size_t)used * sizeof(mm128_t))) return 3;
        for (int copy = 0; copy < 2; ++copy) {
            free(out[copy]); free(u[copy]);
            free(observed[copy].f); free(observed[copy].p);
            free(observed[copy].v); free(observed[copy].t);
        }
        anchors += n;
    }
    if (!simple_cached_scores_exact()) return 27;
    printf("{\"cases\":120,\"anchors\":%llu,\"scorePredecessorPeakSkipArraysExact\":true,\"orderedChainsAndAnchorsExact\":true,\"iteratorBoundariesExact\":true,\"shiftedPredecessorIntervalsExact\":true,\"compressedSparseIntervalsExact\":true,\"boundedWorkerStorage\":true,\"cachedSimpleScoreCases\":2000000,\"cachedSimpleScoresAndFlagsExact\":true,\"simplePenaltyFallbacksExact\":true,\"bandedScoreCases\":2000001,\"bandedAcceptanceAndFlagsExact\":true,\"rejectedScoresUntouched\":true,\"failures\":0}\n", (unsigned long long)anchors);
    return 0;
}
