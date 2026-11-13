static int check_group_reuse(int method, int scenario)
{
    enum { groups = 4, group_size = 16384, count = groups * group_size };
    mm128_t *a = calloc(count, sizeof(mm128_t));
    int32_t *f[2], *t[2], *v[2];
    int64_t *p[2];
    if (!a) return 60;
    for (int copy = 0; copy < 2; ++copy) {
        f[copy] = calloc(count, sizeof(int32_t));
        t[copy] = calloc(count, sizeof(int32_t));
        v[copy] = calloc(count, sizeof(int32_t));
        p[copy] = malloc(count * sizeof(int64_t));
        if (!f[copy] || !t[copy] || !v[copy] || !p[copy]) return 61;
        for (int i = 0; i < count; ++i) { p[copy][i] = -1; if (scenario == 2) t[copy][i] = -7; }
    }
    for (int group = 0; group < groups; ++group)
        for (int i = 0; i < group_size; ++i) {
            const int at = group * group_size + i;
            const uint32_t x = scenario == 8 ? (uint32_t)(i * 2)
                : scenario == 6 ? (group % 2 ? (uint32_t)i : UINT32_MAX - group_size + 1 + (uint32_t)i)
                : scenario == 3 ? UINT32_MAX - group_size + i
                : (uint32_t)(i * 2 + (scenario >= 4 ? (group + 1) * 100000 : 0));
            a[at].x = ((uint64_t)(group + 3) << 32) | x;
            a[at].y = (13ULL << 32) | (uint32_t)(i * 2);
            if (scenario == 6) a[at].y = (13ULL << 32) | (uint32_t)(i + (group % 2) * 750);
            if (scenario == 7 || scenario == 8) a[at].y += (uint32_t)((group + 1) * 100000);
            if (scenario == 9) a[at].y += (1u << 29) + (uint32_t)((group + 1) * 100000);
            if (scenario == 1 && group == 2 && i == group_size / 2) a[at].y ^= 1;
        }
    dnaforge_chain_work_t work = {
        .a = a, .max_dist_x = 5000, .max_dist_y = 5000, .bw = 500,
        .max_skip = 25, .max_iter = 5000, .n_seg = 1, .chn_pen_gap = 0.19f,
        .max_dist_inner = 1000, .cap_rmq_size = 100000, .count = count
    };
    if (scenario == 5) work.chn_pen_gap = 0x1.0p-100f;
    work.penalties = dnaforge_prepare_chain_penalties(&work);
    if (!work.penalties) return 62;
    work.f = f[0]; work.t = t[0]; work.v = v[0]; work.p = p[0];
    if (!method) dnaforge_reference_chain_score_range_original(&work, 0, count);
    else {
        for (int group = 0; group < groups; ++group)
            dnaforge_rmq_score_range(&work, group * group_size, (group + 1) * group_size);
        km_destroy(work.arena); work.arena = 0;
    }
    work.f = f[1]; work.t = t[1]; work.v = v[1]; work.p = p[1];
    group_score_calls = 0;
    force_group_hash_collision = scenario == 1;
    dnaforge_chain_score_all(&work, count, method ? dnaforge_rmq_score_range : dnaforge_chain_score_range);
    force_group_hash_collision = 0;
    const uint64_t expected_calls = scenario == 6 ? 1 : scenario == 2 || scenario == 3 || scenario == 5 || scenario == 9 ? 4 : scenario == 1 ? 3 : 2;
    if (group_score_calls != expected_calls) {
        printf("{\"method\":%d,\"scenario\":%d,\"calls\":%llu,\"expected\":%llu}\n", method, scenario, (unsigned long long)group_score_calls, (unsigned long long)expected_calls);
        return 63;
    }
    for (int i = 0; i < count; ++i)
        if (f[0][i] != f[1][i] || t[0][i] != t[1][i] || v[0][i] != v[1][i] || p[0][i] != p[1][i]) {
            printf("{\"method\":%d,\"scenario\":%d,\"index\":%d,\"f\":[%d,%d],\"t\":[%d,%d],\"v\":[%d,%d],\"p\":[%lld,%lld]}\n",method,scenario,i,f[0][i],f[1][i],t[0][i],t[1][i],v[0][i],v[1][i],(long long)p[0][i],(long long)p[1][i]);
            return 64;
        }
    if (work.bounds || work.reuse_from || work.arena) return 65;
    for (int copy = 0; copy < 2; ++copy) { free(f[copy]); free(t[copy]); free(v[copy]); free(p[copy]); }
    free(work.penalties); free(a);
    return 0;
}

int main(int argc, char **argv)
{
    if (argc == 2 && strcmp(argv[1], "--small") == 0) {
        const int result = check_group_reuse(0, 0);
        if (!result) puts("{\"scope\":\"one bounded DP reuse case\",\"allOriginalInternalFieldsExact\":true}");
        return result;
    }
    if (argc == 2 && strcmp(argv[1], "--small-rmq-translated") == 0) {
        const int result = check_group_reuse(1, 4);
        if (!result) puts("{\"scope\":\"one bounded translated RMQ case\",\"allInternalFieldsExact\":true}");
        return result;
    }
    for (int method = 0; method < 2; ++method)
        for (int scenario = 0; scenario < 6; ++scenario) {
            const int result = check_group_reuse(method, scenario);
            if (result) return result;
        }
    puts("{\"cases\":12,\"completeStatesExact\":true,\"hashCollisionsComparedExactly\":true,\"firstGroupIndependent\":true,\"nonzeroInputAndOverflowFallbackExact\":true,\"exactTranslationAndPrecisionFallback\":true,\"joinedBeforeReuse\":true}");
    return 0;
}
