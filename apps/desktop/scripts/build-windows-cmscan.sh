#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "Usage: $0 <output-dir> [source-cache-dir]" >&2
  exit 2
fi

export PATH="/mingw64/bin:/usr/bin:$PATH"

if ! command -v cygpath >/dev/null 2>&1; then
  echo "ERROR: build-windows-cmscan.sh must run under MSYS2." >&2
  exit 1
fi

for tool in curl sha256sum tar awk sed make gcc objdump; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: required MSYS2/MinGW tool missing: $tool" >&2
    exit 1
  fi
done

to_posix_path() {
  cygpath -u "$1"
}

INFERNAL_VERSION="${INFERNAL_VERSION:-1.1.5}"
: "${INFERNAL_SOURCE_URL:?INFERNAL_SOURCE_URL must come from release-assets.lock.json}"
: "${INFERNAL_SOURCE_SHA256:?INFERNAL_SOURCE_SHA256 must come from release-assets.lock.json}"

output_dir="$(to_posix_path "$1")"
source_cache="${2:-${RUNNER_TEMP:-/tmp}/dnaforge-cmscan-source}"
source_cache="$(to_posix_path "$source_cache")"
work_dir="${RUNNER_TEMP:-/tmp}/dnaforge-cmscan-build"
work_dir="$(to_posix_path "$work_dir")"
build_dir="$work_dir/build"

mkdir -p "$source_cache"
rm -rf "$build_dir" "$output_dir"
mkdir -p "$build_dir" "$output_dir"

source_archive="$source_cache/infernal-${INFERNAL_VERSION}.tar.gz"
if [ ! -s "$source_archive" ]; then
  curl -fL --retry 3 --retry-delay 2 -o "$source_archive" "$INFERNAL_SOURCE_URL"
fi
echo "${INFERNAL_SOURCE_SHA256} *${source_archive}" | sha256sum -c -

rm -rf "$work_dir/infernal-${INFERNAL_VERSION}"
mkdir -p "$work_dir"
tar xzf "$source_archive" -C "$work_dir"
source_dir="$work_dir/infernal-${INFERNAL_VERSION}"

awk '
  $0 == "#include <syslog.h>" {
    print "#ifdef _WIN32"
    print "#define LOG_ERR 3"
    print "static void esl_windows_vsyslog(int priority, const char *format, va_list ap)"
    print "{"
    print "  (void) priority;"
    print "  vfprintf(stderr, format, ap);"
    print "  fputc(10, stderr);"
    print "}"
    print "#define vsyslog esl_windows_vsyslog"
    print "static int esl_windows_zero(void) { return 0; }"
    print "#define getppid esl_windows_zero"
    print "#define getuid esl_windows_zero"
    print "#define geteuid esl_windows_zero"
    print "#define getgid esl_windows_zero"
    print "#define getegid esl_windows_zero"
    print "#else"
    print "#include <syslog.h>"
    print "#endif"
    next
  }
  { print }
' "$source_dir/easel/easel.c" > "$source_dir/easel/easel.c.tmp"
mv "$source_dir/easel/easel.c.tmp" "$source_dir/easel/easel.c"

awk '
  $0 ~ /^#include <signal.h>/ {
    print
    print ""
    print "#ifdef _WIN32"
    print "#undef _POSIX_VERSION"
    print "#ifndef MAP_FAILED"
    print "#define MAP_FAILED ((void *) -1)"
    print "#endif"
    print "#define mmap(...) MAP_FAILED"
    print "#define munmap(...) (-1)"
    print "#endif"
    next
  }
  { print }
' "$source_dir/easel/esl_buffer.c" > "$source_dir/easel/esl_buffer.c.tmp"
mv "$source_dir/easel/esl_buffer.c.tmp" "$source_dir/easel/esl_buffer.c"

for ctime_file in \
  "$source_dir/hmmer/src/p7_hmm.c" \
  "$source_dir/hmmer/src/p7_tophits.c" \
  "$source_dir/src/cm.c" \
  "$source_dir/src/cm_tophits.c"; do
  awk '
    ($0 == "#include <time.h>" || $0 == "#include <limits.h>") && ! inserted {
      print
      if ($0 != "#include <time.h>") {
        print "#include <time.h>"
      }
      print ""
      print "#ifdef _WIN32"
      print "static char *dnaforge_windows_ctime_r(const time_t *clock, char *buf)"
      print "{"
      print "  return ctime_s(buf, 32, clock) == 0 ? buf : NULL;"
      print "}"
      print "#define ctime_r dnaforge_windows_ctime_r"
      print "#endif"
      inserted = 1
      next
    }
    { print }
  ' "$ctime_file" > "$ctime_file.tmp"
  mv "$ctime_file.tmp" "$ctime_file"
done

while IFS= read -r sse_file; do
  awk '
    { gsub(/unsigned long int/, "uintptr_t") }
    ! inserted && /^#include / {
      print
      print "#include <stdint.h>"
      inserted = 1
      next
    }
    { print }
  ' "$sse_file" > "$sse_file.tmp"
  mv "$sse_file.tmp" "$sse_file"
done < <(
  {
    grep -rl "unsigned long int" \
      "$source_dir/src/impl_sse" \
      "$source_dir/hmmer/src/impl_sse"
    printf '%s\n' \
      "$source_dir/hmmer/src/fm_general.c" \
      "$source_dir/hmmer/src/fm_sse.c"
  } | awk '!seen[$0]++'
)
if grep -R "unsigned long int" \
  "$source_dir/src/impl_sse" \
  "$source_dir/hmmer/src/impl_sse" \
  "$source_dir/hmmer/src/fm_general.c" \
  "$source_dir/hmmer/src/fm_sse.c"; then
  echo "ERROR: Windows SSE alignment patch left LLP64-unsafe pointer casts behind." >&2
  exit 1
fi

awk '
  {
    gsub(/fopen\(filename, "r"\)/, "fopen(filename, \"rb\")")
    gsub(/fopen\(cmfp->fname, "r"\)/, "fopen(cmfp->fname, \"rb\")")
    print
  }
' "$source_dir/src/cm_file.c" > "$source_dir/src/cm_file.c.tmp"
mv "$source_dir/src/cm_file.c.tmp" "$source_dir/src/cm_file.c"
if grep -Eq 'fopen\((filename|cmfp->fname), "r"\)' "$source_dir/src/cm_file.c"; then
  echo "ERROR: Windows Infernal build left a CM/HMM file handle in text mode." >&2
  exit 1
fi

awk '
  {
    gsub(/fopen\(ssifile, "w"\)/, "fopen(ssifile, \"wb\")")
    print
  }
' "$source_dir/easel/esl_ssi.c" > "$source_dir/easel/esl_ssi.c.tmp"
mv "$source_dir/easel/esl_ssi.c.tmp" "$source_dir/easel/esl_ssi.c"
if grep -Eq 'fopen\(ssifile, "w"\)' "$source_dir/easel/esl_ssi.c"; then
  echo "ERROR: Windows Infernal build left the binary SSI index writer in text mode." >&2
  exit 1
fi

cd "$build_dir"
"$source_dir/configure" --enable-threads --prefix="$build_dir/install"

make -C easel -j2 libeasel.a
for daemon_obj in \
  cachedb.o \
  cachedb_shard.o \
  hmmdmstr.o \
  hmmdmstr_shard.o \
  hmmd_search_status.o \
  hmmdwrkr.o \
  hmmdwrkr_shard.o \
  hmmdutils.o \
  hmmpgmd2msa.o \
  p7_hmmcache.o \
  p7_hmmd_search_stats.o; do
  sed -i "/^[[:space:]]*${daemon_obj}\\\\$/d" hmmer/src/Makefile
done
make -C hmmer/src -j2 libhmmer.a
make -C src -j2 cmscan cmpress

cmscan="$build_dir/src/cmscan.exe"
cmpress="$build_dir/src/cmpress.exe"
test -s "$cmscan"
test -s "$cmpress"
"$cmscan" -h > "$output_dir/cmscan-help.txt"
"$cmpress" -h > "$output_dir/cmpress-help.txt"
grep -q -- '--cpu' "$output_dir/cmscan-help.txt" || {
  cat "$output_dir/cmscan-help.txt"
  echo "ERROR: cmscan help does not expose --cpu; Infernal lacks thread support." >&2
  exit 1
}

cp "$cmscan" "$output_dir/cmscan.exe"
cp "$cmpress" "$output_dir/cmpress.exe"
cp "$source_dir/LICENSE" "$output_dir/INFERNAL-LICENSE.txt"
cp "$source_dir/hmmer/LICENSE" "$output_dir/HMMER-LICENSE.txt"
cp "$source_dir/easel/LICENSE" "$output_dir/EASEL-LICENSE.txt"

objdump -p "$cmscan" > "$output_dir/cmscan-objdump.txt"
objdump -p "$cmpress" > "$output_dir/cmpress-objdump.txt"
awk '/DLL Name:/ {print $3}' \
  "$output_dir/cmscan-objdump.txt" \
  "$output_dir/cmpress-objdump.txt" | sort -u > "$output_dir/dll-closure.txt"
while IFS= read -r dll; do
  lower="$(printf '%s' "$dll" | tr '[:upper:]' '[:lower:]')"
  case "$lower" in
    advapi32.dll|bcrypt.dll|kernel32.dll|msvcrt.dll|ntdll.dll|shell32.dll|user32.dll|ws2_32.dll)
      continue
      ;;
  esac
  if [ -f "/mingw64/bin/$dll" ]; then
    cp "/mingw64/bin/$dll" "$output_dir/$dll"
  fi
done < "$output_dir/dll-closure.txt"

for required_dll in libgcc_s_seh-1.dll libwinpthread-1.dll; do
  if [ -f "/mingw64/bin/$required_dll" ]; then
    cp "/mingw64/bin/$required_dll" "$output_dir/$required_dll"
  fi
  test -s "$output_dir/$required_dll" || {
    echo "ERROR: required MinGW runtime DLL missing from cmscan bundle: $required_dll" >&2
    cat "$output_dir/dll-closure.txt" >&2
    exit 1
  }
done

{
  echo "cmscan.exe:"
  sha256sum "$output_dir/cmscan.exe"
  echo "cmpress.exe:"
  sha256sum "$output_dir/cmpress.exe"
  find "$output_dir" -maxdepth 1 -type f -name '*.dll' -print0 | sort -z | xargs -0 sha256sum
} > "$output_dir/SHA256SUMS.txt"

runtime_libraries=""
while IFS= read -r dll_path; do
  dll="$(basename "$dll_path")"
  package="$(pacman -Qoq "/mingw64/bin/$dll")"
  version="$(pacman -Q "$package" | awk '{print $2}')"
  base="$(sed -n '/^%BASE%$/{n;p;q;}' "/var/lib/pacman/local/$package-$version/desc")"
  if [ -z "$package" ] || [ -z "$version" ] || [ -z "$base" ]; then
    echo "ERROR: cannot identify the MSYS2 package that provides $dll" >&2
    exit 1
  fi
  runtime_libraries="${runtime_libraries:+$runtime_libraries,}
    {\"file\": \"$dll\", \"package\": \"$package\", \"version\": \"$version\", \"base\": \"$base\"}"
done < <(find "$output_dir" -maxdepth 1 -type f -name '*.dll' | sort)

cat > "$output_dir/build-metadata.json" <<EOF
{
  "product": "DNAForge",
  "task": "windows-cmscan-build",
  "artifact": "infernal-win-x64",
  "infernalVersion": "${INFERNAL_VERSION}",
  "infernalSourceUrl": "${INFERNAL_SOURCE_URL}",
  "infernalSourceSha256": "${INFERNAL_SOURCE_SHA256}",
  "threaded": true,
  "runtimeLibraries": [${runtime_libraries}
  ],
  "patches": [
    "easel-windows-syslog-process-fallbacks",
    "easel-windows-no-mmap",
    "windows-ctime-r-shim",
    "llp64-sse-uintptr-alignment",
    "cm-file-handles-binary-mode",
    "ssi-index-binary-write-mode"
  ]
}
EOF

echo "[cmscan-build] Built Windows cmscan bundle at $output_dir"
find "$output_dir" -maxdepth 1 -type f -printf '  %f\n' | sort
