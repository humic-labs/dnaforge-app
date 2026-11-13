#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
typedef struct { int32_t *f, *v, *t; int64_t *p; } observed_state_t;
static observed_state_t observed[2];
static int observed_slot;
static void dnaforge_observe_state(int64_t n, const int32_t *f, const int64_t *p, const int32_t *v, const int32_t *t)
{
    observed_state_t *s = &observed[observed_slot++];
    s->f = malloc((size_t)n * sizeof(int32_t)); s->p = malloc((size_t)n * sizeof(int64_t));
    s->v = malloc((size_t)n * sizeof(int32_t)); s->t = malloc((size_t)n * sizeof(int32_t));
    if (!s->f || !s->p || !s->v || !s->t) exit(22);
    memcpy(s->f, f, (size_t)n * sizeof(int32_t)); memcpy(s->p, p, (size_t)n * sizeof(int64_t));
    memcpy(s->v, v, (size_t)n * sizeof(int32_t)); memcpy(s->t, t, (size_t)n * sizeof(int32_t));
}

static int observed_root_arenas;
void dnaforge_observe_arena(void *parent)
{
    if (!parent) __sync_add_and_fetch(&observed_root_arenas, 1);
}
