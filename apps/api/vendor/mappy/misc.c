#include <stdlib.h>
#include <pthread.h>
#include <unistd.h>
#include "mmpriv.h"

int mm_verbose = 1;
int mm_dbg_flag = 0;
double mm_realtime0;

#if defined(WIN32) || defined(_WIN32)
#include <windows.h>

struct timezone
{
  __int32  tz_minuteswest; /* minutes W of Greenwich */
  int  tz_dsttime;     /* type of dst correction */
};

/*
 * gettimeofday.c
 *    Win32 gettimeofday() replacement
 *    taken from PostgreSQL, according to
 *    https://stackoverflow.com/questions/1676036/what-should-i-use-to-replace-gettimeofday-on-windows
 *
 * src/port/gettimeofday.c
 *
 * Copyright (c) 2003 SRA, Inc.
 * Copyright (c) 2003 SKC, Inc.
 *
 * Permission to use, copy, modify, and distribute this software and
 * its documentation for any purpose, without fee, and without a
 * written agreement is hereby granted, provided that the above
 * copyright notice and this paragraph and the following two
 * paragraphs appear in all copies.
 *
 * IN NO EVENT SHALL THE AUTHOR BE LIABLE TO ANY PARTY FOR DIRECT,
 * INDIRECT, SPECIAL, INCIDENTAL, OR CONSEQUENTIAL DAMAGES, INCLUDING
 * LOST PROFITS, ARISING OUT OF THE USE OF THIS SOFTWARE AND ITS
 * DOCUMENTATION, EVEN IF THE UNIVERSITY OF CALIFORNIA HAS BEEN ADVISED
 * OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * THE AUTHOR SPECIFICALLY DISCLAIMS ANY WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE.  THE SOFTWARE PROVIDED HEREUNDER IS ON AN "AS
 * IS" BASIS, AND THE AUTHOR HAS NO OBLIGATIONS TO PROVIDE MAINTENANCE,
 * SUPPORT, UPDATES, ENHANCEMENTS, OR MODIFICATIONS.
 */

/* FILETIME of Jan 1 1970 00:00:00. */
static const unsigned __int64 epoch = ((unsigned __int64) 116444736000000000ULL);

/*
 * timezone information is stored outside the kernel so tzp isn't used anymore.
 *
 * Note: this function is not for Win32 high precision timing purpose. See
 * elapsed_time().
 */
int gettimeofday(struct timeval * tp, struct timezone *tzp)
{
    FILETIME    file_time;
    SYSTEMTIME  system_time;
    ULARGE_INTEGER ularge;

    GetSystemTime(&system_time);
    SystemTimeToFileTime(&system_time, &file_time);
    ularge.LowPart = file_time.dwLowDateTime;
    ularge.HighPart = file_time.dwHighDateTime;

    tp->tv_sec = (long) ((ularge.QuadPart - epoch) / 10000000L);
    tp->tv_usec = (long) (system_time.wMilliseconds * 1000);

    return 0;
}

// taken from https://stackoverflow.com/questions/5272470/c-get-cpu-usage-on-linux-and-windows
double cputime()
{
	HANDLE hProcess = GetCurrentProcess();
	FILETIME ftCreation, ftExit, ftKernel, ftUser;
	SYSTEMTIME stKernel;
	SYSTEMTIME stUser;

	GetProcessTimes(hProcess, &ftCreation, &ftExit, &ftKernel, &ftUser);
	FileTimeToSystemTime(&ftKernel, &stKernel);
	FileTimeToSystemTime(&ftUser, &stUser);

	double kernelModeTime = ((stKernel.wHour * 60.) + stKernel.wMinute * 60.) + stKernel.wSecond * 1. + stKernel.wMilliseconds / 1000.;
	double userModeTime = ((stUser.wHour * 60.) + stUser.wMinute * 60.) + stUser.wSecond * 1. + stUser.wMilliseconds / 1000.;

	return kernelModeTime + userModeTime;
}

long peakrss(void) { return 0; }
#else
#include <sys/resource.h>
#include <sys/time.h>

double cputime(void)
{
	struct rusage r;
	getrusage(RUSAGE_SELF, &r);
	return r.ru_utime.tv_sec + r.ru_stime.tv_sec + 1e-6 * (r.ru_utime.tv_usec + r.ru_stime.tv_usec);
}

long peakrss(void)
{
	struct rusage r;
	getrusage(RUSAGE_SELF, &r);
#ifdef __linux__
	return r.ru_maxrss * 1024;
#else
	return r.ru_maxrss;
#endif
}

#endif /* WIN32 || _WIN32 */

double realtime(void)
{
	struct timeval tp;
	gettimeofday(&tp, NULL);
	return tp.tv_sec + tp.tv_usec * 1e-6;
}

void mm_err_puts(const char *str)
{
	int ret;
	ret = puts(str);
	if (ret == EOF) {
		perror("[ERROR] failed to write the results");
		exit(EXIT_FAILURE);
	}
}

void mm_err_fwrite(const void *p, size_t size, size_t nitems, FILE *fp)
{
	int ret;
	ret = fwrite(p, size, nitems, fp);
	if (ret == EOF) {
		perror("[ERROR] failed to write data");
		exit(EXIT_FAILURE);
	}
}

void mm_err_fread(void *p, size_t size, size_t nitems, FILE *fp)
{
	int ret;
	ret = fread(p, size, nitems, fp);
	if (ret == EOF) {
		perror("[ERROR] failed to read data");
		exit(EXIT_FAILURE);
	}
}

#include "ksort.h"

#define sort_key_128x(a) ((a).x)
KRADIX_SORT_INIT(128x, mm128_t, sort_key_128x, 8) 

typedef struct dnaforge_seed_sort_schedule_s {
    rsbucket_128x_t *jobs;
    int count, next, shift;
} dnaforge_seed_sort_schedule_t;

static void *dnaforge_seed_sort_worker(void *data)
{
    dnaforge_seed_sort_schedule_t *schedule = (dnaforge_seed_sort_schedule_t *)data;
    for (;;) {
        const int index = __sync_fetch_and_add(&schedule->next, 1);
        if (index >= schedule->count) break;
        const rsbucket_128x_t job = schedule->jobs[index];
        if (job.e - job.b > RS_MIN_SIZE) rs_sort_128x(job.b, job.e, RS_MAX_BITS, schedule->shift);
        else rs_insertsort_128x(job.b, job.e);
    }
    return 0;
}

void dnaforge_radix_sort_128x(mm128_t *beg, mm128_t *end)
{
    if (end - beg < (1<<20) || MM_DNAFORGE_MAP_THREAD_LIMIT < 2 || sysconf(_SC_NPROCESSORS_ONLN) < 2) {
        radix_sort_128x(beg, end);
        return;
    }
    rsbucket_128x_t buckets[1<<RS_MAX_BITS], jobs[1<<RS_MAX_BITS];
    int child_shift;
    const int shift = rs_partition_128x(beg, end, RS_MAX_BITS, 7 * RS_MAX_BITS, buckets, &child_shift);
    if (shift <= 0 || child_shift < 0) return;
    int count = 0;
    for (int i = 0; i < (1<<RS_MAX_BITS); ++i)
        if (buckets[i].e - buckets[i].b > 1) jobs[count++] = buckets[i];
    dnaforge_seed_sort_schedule_t schedule = {
        .jobs = jobs, .count = count, .next = 0,
        .shift = child_shift
    };
    pthread_t worker;
    const int created = count > 1 && pthread_create(&worker, 0, dnaforge_seed_sort_worker, &schedule) == 0;
    dnaforge_seed_sort_worker(&schedule);
    if (created && pthread_join(worker, 0) != 0) abort();
}

#define sort_key_64(x) (x)
KRADIX_SORT_INIT(64, uint64_t, sort_key_64, 8)

KSORT_INIT_GENERIC(uint32_t)
KSORT_INIT_GENERIC(uint64_t)
