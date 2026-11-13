static uint64_t random_state = 0x32a75c916be048dfULL;
static uint32_t next_random(void)
{
    random_state ^= random_state << 13;
    random_state ^= random_state >> 7;
    random_state ^= random_state << 17;
    return (uint32_t)random_state;
}


static int check_cached_candidate_scores(void)
{
    dnaforge_chain_work_t work = {
        .max_dist_x = 5000, .max_dist_y = 4500, .bw = 500,
        .chn_pen_gap = 0.19f, .chn_pen_skip = 0.0f, .is_cdna = 0, .n_seg = 1
    };
    int32_t *penalties = dnaforge_prepare_chain_penalties(&work);
    if (!penalties) return 30;
    for (int test = 0; test < 2000000; ++test) {
        int32_t dr = (int32_t)(next_random() % 7000) - 1000;
        int32_t dq = (int32_t)(next_random() % 7000) - 1000;
        uint64_t sid = next_random() % 3;
        mm128_t ai = { .x = 30000, .y = (sid << MM_SEED_SEG_SHIFT) | (uint32_t)30000 };
        mm128_t aj = { .x = (uint32_t)(30000 - dr), .y = ((test % 4 == 0 ? (sid + 1) % 3 : sid) << MM_SEED_SEG_SHIFT) | ((uint64_t)(next_random() % 256) << 32) | (uint32_t)(30000 - dq) };
        int32_t expected = dnaforge_reference_comput_sc(&ai, &aj, work.max_dist_x, work.max_dist_y, work.bw, work.chn_pen_gap, work.chn_pen_skip, work.is_cdna, work.n_seg);
        int32_t actual = dnaforge_comput_cached_sc(&ai, &aj, work.max_dist_x, work.max_dist_y, work.bw, work.chn_pen_gap, work.chn_pen_skip, work.is_cdna, work.n_seg, penalties);
        if (expected != actual) {
            printf("{\"cachedCase\":%d,\"expected\":%d,\"actual\":%d}\n",test,expected,actual);
            free(penalties);
            return 31;
        }
    }
    free(penalties);
    return 0;
}

static uint64_t small_group_scalar_calls, small_group_indexed_calls;

static int check_small_group_work(void)
{
    const int count = 128;
    mm128_t a[128] = {0};
    int32_t f[2][128] = {{0}}, t[2][128] = {{0}}, v[2][128] = {{0}};
    int64_t pred[2][128];
    for (int i = 0; i < count; ++i) {
        a[i].x = (3ULL << 32) | (uint32_t)i;
        a[i].y = (15ULL << 32) | (uint32_t)(i + (i % 16) * 5000);
        pred[0][i] = pred[1][i] = -1;
    }
    dnaforge_chain_work_t work = {
        .a = a, .max_dist_x = 5000, .max_dist_y = 5000, .bw = 100,
        .max_skip = 25, .max_iter = 5000, .n_seg = 1, .chn_pen_gap = 0.19f
    };
    work.penalties = dnaforge_prepare_chain_penalties(&work);
    if (!work.penalties) return 40;
    work.f = f[0]; work.t = t[0]; work.v = v[0]; work.p = pred[0];
    candidate_score_calls = 0;
    dnaforge_reference_chain_score_range_original(&work, 0, count);
    small_group_scalar_calls = candidate_score_calls;
    work.f = f[1]; work.t = t[1]; work.v = v[1]; work.p = pred[1];
    candidate_score_calls = 0;
    dnaforge_chain_score_range(&work, 0, count);
    small_group_indexed_calls = candidate_score_calls;
    free(work.penalties);
    if (memcmp(f[0], f[1], sizeof(f[0])) || memcmp(t[0], t[1], sizeof(t[0])) ||
        memcmp(v[0], v[1], sizeof(v[0])) || memcmp(pred[0], pred[1], sizeof(pred[0])))
        return 41;
    if (f[0][count - 1] <= 15 || small_group_indexed_calls * 4 >= small_group_scalar_calls)
        return 42;
    return 0;
}

static int check_packed_window_maxima(void)
{
    const int64_t count = 50000;
    for (int test = 0; test < 5; ++test) {
        const int64_t begin = test % 2 ? 17 : 0, end = begin + count;
        mm128_t *a = calloc((size_t)end, sizeof(mm128_t));
        int32_t *f[2], *t[2], *v[2];
        int64_t *p[2];
        if (!a) return 45;
        for (int copy = 0; copy < 2; ++copy) {
            f[copy] = calloc((size_t)end, sizeof(int32_t));
            t[copy] = calloc((size_t)end, sizeof(int32_t));
            v[copy] = calloc((size_t)end, sizeof(int32_t));
            p[copy] = malloc((size_t)end * sizeof(int64_t));
            if (!f[copy] || !t[copy] || !v[copy] || !p[copy]) return 46;
            for (int64_t i = 0; i < end; ++i) p[copy][i] = -1;
        }
        uint32_t target = 0;
        int32_t maximum = 0;
        for (int64_t i = begin; i < end; ++i) {
            target += test == 3 && i % 19 == 0 ? 257 : 1;
            const int32_t query = test == 0 ? 1000 : test == 4
                ? 0x00ffff00 + (int32_t)(i % 128)
                : (int32_t)(i % 131);
            if (maximum < query) maximum = query;
            a[i].x = (3ULL << 32) | target;
            a[i].y = (2ULL << MM_SEED_SEG_SHIFT) | (13ULL << 32) | (uint32_t)query;
        }
        dnaforge_chain_work_t work = {
            .a = a, .max_dist_x = 128, .max_dist_y = 128, .bw = 64,
            .max_skip = test % 2 ? 0 : 25,
            .max_iter = test == 1 ? 0 : test == 2 ? 1 : 64,
            .n_seg = 1, .chn_pen_gap = 0.19f,
        };
        work.penalties = dnaforge_prepare_chain_penalties(&work);
        if (!work.penalties) return 47;
        work.f = f[0]; work.t = t[0]; work.v = v[0]; work.p = p[0];
        dnaforge_reference_chain_score_range_original(&work, begin, end);
        work.f = f[1]; work.t = t[1]; work.v = v[1]; work.p = p[1];
        if (!dnaforge_chain_score_range_packed(&work, begin, end, maximum)) return 48;
        for (int64_t i = 0; i < end; ++i) {
            if (f[0][i] != f[1][i] || t[0][i] != t[1][i] ||
                v[0][i] != v[1][i] || p[0][i] != p[1][i]) {
                printf("{\"windowMaximumCase\":%d,\"anchor\":%lld}\n", test, i);
                return 49;
            }
        }
        for (int copy = 0; copy < 2; ++copy) {
            free(f[copy]); free(t[copy]); free(v[copy]); free(p[copy]);
        }
        free(work.penalties);
        free(a);
    }
    return 0;
}


static uint64_t diagonal_scalar_calls, diagonal_indexed_calls;
static int check_diagonal_partition_work(void)
{
    enum { count = 4096 };
    mm128_t a[count];
    int32_t f[2][count] = {{0}}, t[2][count] = {{0}}, v[2][count] = {{0}};
    int64_t pred[2][count];
    int32_t maximum = 0;
    for (int i = 0; i < count; ++i) {
        const int32_t query = (i % 16) * 256 + i / 16;
        a[i].x = (3ULL << 32) | (uint32_t)i;
        a[i].y = (15ULL << 32) | (uint32_t)query;
        if (query > maximum) maximum = query;
        pred[0][i] = pred[1][i] = -1;
    }
    dnaforge_chain_work_t work = {
        .a = a, .max_dist_x = 5000, .max_dist_y = 5000, .bw = 100,
        .max_skip = 25, .max_iter = 5000, .n_seg = 1, .chn_pen_gap = 0.19f
    };
    work.penalties = dnaforge_prepare_chain_penalties(&work);
    if (!work.penalties) return 52;
    work.f = f[0]; work.t = t[0]; work.v = v[0]; work.p = pred[0];
    candidate_score_calls = 0;
    dnaforge_reference_chain_score_range_original(&work, 0, count);
    diagonal_scalar_calls = candidate_score_calls;
    work.f = f[1]; work.t = t[1]; work.v = v[1]; work.p = pred[1];
    candidate_score_calls = 0;
    dnaforge_chain_score_range(&work, 0, count);
    diagonal_indexed_calls = candidate_score_calls;
    free(work.penalties);
    if (memcmp(f[0], f[1], sizeof(f[0])) || memcmp(t[0], t[1], sizeof(t[0])) ||
        memcmp(v[0], v[1], sizeof(v[0])) || memcmp(pred[0], pred[1], sizeof(pred[0]))) return 53;
    if (diagonal_indexed_calls * 16 >= diagonal_scalar_calls) return 54;
    return 0;
}

static uint64_t query_origin_scalar_calls, query_origin_indexed_calls;
static int check_query_origin_work(void)
{
    enum { count = 4096 };
    mm128_t a[count];
    int32_t f[2][count] = {{0}}, t[2][count] = {{0}}, v[2][count] = {{0}};
    int64_t pred[2][count];
    for (int i = 0; i < count; ++i) {
        const int32_t query = (1 << 28) + (i % 16) * 256 + i / 16;
        a[i].x = (3ULL << 32) | (uint32_t)i;
        a[i].y = (15ULL << 32) | (uint32_t)query;
        pred[0][i] = pred[1][i] = -1;
    }
    dnaforge_chain_work_t work = {
        .a = a, .max_dist_x = 5000, .max_dist_y = 5000, .bw = 100,
        .max_skip = 25, .max_iter = 5000, .n_seg = 1, .chn_pen_gap = 0.19f
    };
    work.penalties = dnaforge_prepare_chain_penalties(&work);
    if (!work.penalties) return 55;
    work.f = f[0]; work.t = t[0]; work.v = v[0]; work.p = pred[0];
    candidate_score_calls = 0;
    dnaforge_reference_chain_score_range_original(&work, 0, count);
    query_origin_scalar_calls = candidate_score_calls;
    work.f = f[1]; work.t = t[1]; work.v = v[1]; work.p = pred[1];
    candidate_score_calls = 0;
    dnaforge_chain_score_range(&work, 0, count);
    query_origin_indexed_calls = candidate_score_calls;
    free(work.penalties);
    if (memcmp(f[0], f[1], sizeof(f[0])) || memcmp(t[0], t[1], sizeof(t[0])) ||
        memcmp(v[0], v[1], sizeof(v[0])) || memcmp(pred[0], pred[1], sizeof(pred[0]))) return 56;
    if (query_origin_indexed_calls * 16 >= query_origin_scalar_calls) return 57;
    return 0;
}

static int check_small_packed_state(void)
{
    for (int test = 0; test < 8; ++test) {
        const int64_t count = (int[]){511, 512, 513, 4096}[test % 4];
        const int64_t begin = test % 2 ? 17 : 0, end = begin + count, allocated = end + 9;
        mm128_t *a = calloc((size_t)allocated, sizeof(mm128_t));
        int32_t *f[2], *t[2], *v[2];
        int64_t *p[2];
        if (!a) return 52;
        for (int copy = 0; copy < 2; ++copy) {
            f[copy] = calloc((size_t)allocated, sizeof(int32_t));
            t[copy] = calloc((size_t)allocated, sizeof(int32_t));
            v[copy] = calloc((size_t)allocated, sizeof(int32_t));
            p[copy] = malloc((size_t)allocated * sizeof(int64_t));
            if (!f[copy] || !t[copy] || !v[copy] || !p[copy]) return 53;
            for (int64_t i = 0; i < allocated; ++i) p[copy][i] = -1;
        }
        int32_t target = 0, maximum = 0;
        for (int64_t i = begin; i < end; ++i) {
            target += next_random() % 12;
            const int32_t q = 0x00a00000 + (int32_t)(next_random() % 20000);
            if (maximum < q) maximum = q;
            a[i].x = (3ULL << 32) | (uint32_t)target;
            a[i].y = (2ULL << MM_SEED_SEG_SHIFT) | ((uint64_t)(1 + next_random() % 63) << 32) | (uint32_t)q;
            t[0][i] = t[1][i] = test >= 4 && i % 7 == 0 ? (int32_t)(i + 1) : 0;
        }
        dnaforge_chain_work_t work = {
            .a = a, .max_dist_x = 5000, .max_dist_y = 4900, .bw = 500,
            .max_skip = test % 3, .max_iter = test == 5 ? 1 : 5000,
            .n_seg = 1, .chn_pen_gap = 0.19f
        };
        work.penalties = dnaforge_prepare_chain_penalties(&work);
        if (!work.penalties) return 54;
        work.f = f[0]; work.t = t[0]; work.v = v[0]; work.p = p[0];
        dnaforge_reference_chain_score_range_original(&work, begin, end);
        work.f = f[1]; work.t = t[1]; work.v = v[1]; work.p = p[1];
        const int used = dnaforge_chain_score_range_packed(&work, begin, end, maximum);
        if (used != (count >= 512)) return 55;
        if (!used) dnaforge_chain_score_range_indexed(&work, begin, end, maximum);
        if (memcmp(f[0], f[1], (size_t)allocated * sizeof(int32_t)) ||
            memcmp(t[0], t[1], (size_t)allocated * sizeof(int32_t)) ||
            memcmp(v[0], v[1], (size_t)allocated * sizeof(int32_t)) ||
            memcmp(p[0], p[1], (size_t)allocated * sizeof(int64_t))) return 56;
        free(work.penalties);
        free(a);
        for (int copy = 0; copy < 2; ++copy) {
            free(f[copy]); free(t[copy]); free(v[copy]); free(p[copy]);
        }
    }
    return 0;
}

int main(void)
{
    int origin_result = check_query_origin_work();
    if (origin_result) return origin_result;
    int diagonal_result = check_diagonal_partition_work();
    if (diagonal_result) return diagonal_result;
    int cached_result = check_cached_candidate_scores();
    if (cached_result) return cached_result;
    int work_result = check_small_group_work();
    if (work_result) return work_result;
    int maximum_result = check_packed_window_maxima();
    if (maximum_result) return maximum_result;
    uint64_t anchors = 0;
    int packed_cases = 0, packed_fallback_cases = 0, lazy_peak_cases = 0;
    for (int test = 0; test < 176; ++test) {
        const int64_t begin = test % 3 == 0 ? 17 : 0;
        const int64_t count = test >= 168 ? (int[]){50000, 50001, 60000, 50000}[(test - 168) % 4] : test >= 160 ? (int[]){49999, 50000, 50001, 60000}[(test - 160) % 4] : test >= 144 ? (int[]){63, 64, 65, 127, 128, 129, 511, 512}[(test - 144) % 8] : test >= 128 ? (int[]){255, 256, 4095, 4096, 4097, 49999, 50000, 50001}[(test - 128) % 8] : test % 32 == 0 ? 60000 : 256 + next_random() % 2048;
        const int64_t end = begin + count, allocated = end + 9;
        mm128_t *a = calloc((size_t)allocated, sizeof(mm128_t));
        int32_t *f[5], *t[5], *v[5];
        int64_t *pred[5];
        for (int copy = 0; copy < 5; ++copy) {
            f[copy] = calloc((size_t)allocated, sizeof(int32_t));
            t[copy] = calloc((size_t)allocated, sizeof(int32_t));
            v[copy] = calloc((size_t)allocated, sizeof(int32_t));
            pred[copy] = malloc((size_t)allocated * sizeof(int64_t));
            if (!f[copy] || !t[copy] || !v[copy] || !pred[copy]) return 20;
            for (int64_t i = 0; i < allocated; ++i) pred[copy][i] = -1;
        }
        if (!a) return 21;
        const int dx = 100 + next_random() % 400;
        int32_t maximum = 0, target = 0;
        for (int64_t i = begin; i < end; ++i) {
            target += next_random() % 12;
            int32_t q = next_random() % (dx * 100);
            if (test % 4 == 0) q = target + (int)(next_random() % 100) - 50;
            if (test % 4 == 1) q = (int32_t)(i % 5) * dx;
            if (test >= 128) q = next_random() % (dx * 4);
            if (test >= 168) q = (test % 2 ? 0x01000000 : 0x00ffff00) + (int32_t)(next_random() % 256);
            if (q < 0) q = 0;
            if (maximum < q) maximum = q;
            const uint64_t sid = test >= 160 ? (test == 165 ? (uint64_t)(i % 3) : 2) : test % 5 == 0 ? next_random() % 3 : 0;
            a[i].x = (3ULL << 32) | (uint32_t)target;
            a[i].y = (sid << MM_SEED_SEG_SHIFT) | ((uint64_t)(1 + next_random() % 63) << 32) | (uint32_t)q;
        }
        dnaforge_chain_work_t work = {
            .a = a,
            .max_dist_x = dx,
            .max_dist_y = 1 + (int)(next_random() % (dx * 2)),
            .bw = 1 + (int)(next_random() % dx),
            .max_skip = test % 4 == 0 ? 0 : 1 + (int)(next_random() % 25),
            .max_iter = test % 7 == 0 ? 0 : test % 7 == 1 ? 1 : test % 7 == 2 ? 5000 : 10 + (int)(next_random() % 1000),
            .is_cdna = test % 2,
            .n_seg = 1 + test % 3,
            .chn_pen_gap = test % 11 == 0 ? -0.01f : 0.19f,
            .chn_pen_skip = test % 4 == 0 ? 0.0f : 0.01f,
        };
        if (test >= 160) {
            work.is_cdna = 0; work.n_seg = 1; work.chn_pen_gap = 0.19f;
            work.chn_pen_skip = test == 166 ? 0.01f : 0.0f;
        }
        work.penalties = dnaforge_prepare_chain_penalties(&work);
        work.f = f[0]; work.t = t[0]; work.v = v[0]; work.p = pred[0];
        dnaforge_reference_chain_score_range_original(&work, begin, end);
        work.f = f[1]; work.t = t[1]; work.v = v[1]; work.p = pred[1];
        if (test >= 160) {
            const int used = dnaforge_chain_score_range_packed(&work, begin, end, maximum);
            const int expected = test >= 168 ? test % 2 == 0 : test != 165 && test != 166;
            if (used != expected) return 43;
            if (used) ++packed_cases;
            else { ++packed_fallback_cases; dnaforge_chain_score_range_indexed(&work, begin, end, maximum); }
        } else dnaforge_chain_score_range_indexed(&work, begin, end, maximum);
        work.f = f[2]; work.t = t[2]; work.v = v[2]; work.p = pred[2];
        dnaforge_chain_score_range_scalar(&work, begin, end);
        work.f = f[3]; work.t = t[3]; work.v = v[3]; work.p = pred[3];
        dnaforge_chain_score_range(&work, begin, end);
        work.f = f[4]; work.t = t[4]; work.v = 0; work.p = pred[4];
        peak_score_calls = 0;
        dnaforge_chain_score_range(&work, begin, end);
        if (peak_score_calls != 0) return 50;
        dnaforge_chain_materialize_peaks(begin, end, f[4], pred[4], v[4]);
        if (peak_score_calls != (uint64_t)(end - begin)) return 51;
        ++lazy_peak_cases;
        for (int64_t i = 0; i < allocated; ++i) {
            if (f[0][i] != f[1][i] || t[0][i] != t[1][i] || v[0][i] != v[1][i] || pred[0][i] != pred[1][i] || f[0][i] != f[2][i] || t[0][i] != t[2][i] || v[0][i] != v[2][i] || pred[0][i] != pred[2][i] || f[0][i] != f[3][i] || t[0][i] != t[3][i] || v[0][i] != v[3][i] || pred[0][i] != pred[3][i] || f[0][i] != f[4][i] || t[0][i] != t[4][i] || v[0][i] != v[4][i] || pred[0][i] != pred[4][i]) {
                printf("{\"case\":%d,\"anchor\":%lld,\"score\":[%d,%d],\"skip\":[%d,%d],\"peak\":[%d,%d],\"pred\":[%lld,%lld]}\n", test, i, f[0][i], f[1][i], t[0][i], t[1][i], v[0][i], v[1][i], pred[0][i], pred[1][i]);
                return 1;
            }
        }
        anchors += count;
        for (int copy = 0; copy < 5; ++copy) {
            free(f[copy]); free(t[copy]); free(v[copy]); free(pred[copy]);
        }
        free(work.penalties);
        free(a);
    }
    if (packed_cases != 10 || packed_fallback_cases != 6) return 44;
    printf("{\"packedStateBytes\":24,\"packedStateCases\":10,\"packedFallbackCases\":6,\"cases\":176,\"windowMaximumCases\":5,\"anchors\":%llu,\"scorePredecessorPeakSkipArraysExact\":true,\"cachedScoreCases\":2000000,\"diagonalPartitionCases\":1,\"diagonalScalarScoreCalls\":%llu,\"diagonalIndexedScoreCalls\":%llu,\"queryOriginCases\":1,\"queryOriginScalarScoreCalls\":%llu,\"queryOriginIndexedScoreCalls\":%llu,\"smallGroupScalarScoreCalls\":%llu,\"smallGroupIndexedScoreCalls\":%llu,\"smallGroupWorkBoundPassed\":true,\"failures\":0,\"lazyPeakStateCases\":%d,\"eagerPeakWorkEliminated\":true}\n", (unsigned long long)anchors, (unsigned long long)diagonal_scalar_calls, (unsigned long long)diagonal_indexed_calls, (unsigned long long)query_origin_scalar_calls, (unsigned long long)query_origin_indexed_calls, (unsigned long long)small_group_scalar_calls, (unsigned long long)small_group_indexed_calls, lazy_peak_cases);
    return 0;
}
