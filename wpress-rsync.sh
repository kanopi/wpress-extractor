#!/usr/bin/env bash
#
# wpress-rsync.sh — rsync a directory out of a .wpress archive to a destination,
# staging files in small SIZE-BUDGETED batches so peak local disk stays tiny.
#
# It builds a manifest of the directory's files, groups them into batches up to
# a byte budget (default 300M), and for each batch:
#   extract the batch -> rsync it -> delete it -> next batch.
# Peak temp usage is ~one batch, no matter how big the directory is. Works for
# local paths and any rsync target, including Pantheon.
#
# Usage:
#   wpress-rsync.sh <archive.wpress> <archive-dir> <destination> [opts] [-- rsync-opts...]
#
#   <archive-dir>   A directory inside the archive, e.g. "uploads".
#   <destination>   A local path or rsync target. The directory's CONTENTS are
#                   synced INTO <destination>. Examples:
#                     ./local/uploads
#                     dev.UUID@appserver.dev.UUID.drush.in:files/   (Pantheon)
#
# Options:
#   -b, --budget SIZE   Max bytes to stage per batch (e.g. 300M, 1G, 500000000).
#                       Default 300M. (A single file larger than this is still
#                       sent on its own.)
#   -M, --max-file SIZE Skip any single file larger than SIZE and list them at
#                       the end (e.g. for hosts that reject large uploads like
#                       Pantheon). Default: no limit.
#   -s, --staging DIR   Where to stage batches (default: temp dir in CWD).
#   -k, --keep          Keep the staging dir afterwards.
#   -n, --dry-run       Show the batch plan, transfer nothing.
#   -h, --help          Show this help.
#
# Anything after "--" is passed straight to rsync, e.g. for Pantheon:
#   wpress-rsync.sh bk.wpress uploads dev.UUID@appserver.dev.UUID.drush.in:files/ \
#     -- -e 'ssh -p 2222 -i ~/.ssh/id_rsa' --size-only --ipv4 --copy-unsafe-links
#
# Notes:
#   * --delete is NOT allowed: with batched syncing it would wipe files sent in
#     earlier batches.
#   * Pantheon: use a RELATIVE remote path ("files/", not "/files"); the env
#     must be in SFTP mode; --size-only avoids needless re-transfers.

set -euo pipefail

# Resolve this script's real directory, following symlinks (e.g. npm's bin
# symlink), so we can find wpress.js next to it.
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  case "$SOURCE" in /*) ;; *) SOURCE="$DIR/$SOURCE" ;; esac
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"
WPRESS_JS="${WPRESS_JS:-$SCRIPT_DIR/wpress.js}"

die() { echo "Error: $*" >&2; exit 1; }
usage() { sed -n '2,45p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

# Parse a human size (300M, 1G, 500k, raw bytes) into bytes.
to_bytes() {
  local s="$1" num unit
  num="${s%[kKmMgGbB]}"
  unit="${s:${#num}}"
  case "$unit" in
    ''|b|B) echo "$num" ;;
    k|K)    echo $(( num * 1024 )) ;;
    m|M)    echo $(( num * 1024 * 1024 )) ;;
    g|G)    echo $(( num * 1024 * 1024 * 1024 )) ;;
    *)      die "bad size: $s" ;;
  esac
}

BUDGET_RAW="300M"
MAXFILE_RAW=""
STAGING=""
KEEP=0
DRYRUN=0
POSITIONAL=()
RSYNC_EXTRA=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage 0 ;;
    -k|--keep) KEEP=1; shift ;;
    -n|--dry-run) DRYRUN=1; shift ;;
    -b|--budget) BUDGET_RAW="${2:-}"; [[ -n "$BUDGET_RAW" ]] || die "--budget needs a size"; shift 2 ;;
    -M|--max-file) MAXFILE_RAW="${2:-}"; [[ -n "$MAXFILE_RAW" ]] || die "--max-file needs a size"; shift 2 ;;
    -s|--staging) STAGING="${2:-}"; [[ -n "$STAGING" ]] || die "--staging needs a directory"; shift 2 ;;
    --) shift; RSYNC_EXTRA=("$@"); break ;;
    -*) die "Unknown option: $1 (run --help)" ;;
    *) POSITIONAL+=("$1"); shift ;;
  esac
done

[[ ${#POSITIONAL[@]} -eq 3 ]] || usage 1
ARCHIVE="${POSITIONAL[0]}"
ARCHIVE_DIR="${POSITIONAL[1]%/}"
DEST="${POSITIONAL[2]}"
BUDGET="$(to_bytes "$BUDGET_RAW")"
MAXFILE=0
[[ -n "$MAXFILE_RAW" ]] && MAXFILE="$(to_bytes "$MAXFILE_RAW")"

command -v node  >/dev/null 2>&1 || die "node is not installed / not on PATH"
command -v rsync >/dev/null 2>&1 || die "rsync is not installed / not on PATH"
[[ -f "$WPRESS_JS" ]] || die "cannot find wpress.js at: $WPRESS_JS (set WPRESS_JS=...)"
[[ -f "$ARCHIVE"  ]] || die "archive not found: $ARCHIVE"

for a in ${RSYNC_EXTRA[@]+"${RSYNC_EXTRA[@]}"}; do
  case "$a" in
    --delete|--delete-*|--del) die "--delete is incompatible with batched syncing (run without it)";;
  esac
done

# --- Safeguard 1: warn on an absolute remote path (likely wrong on Pantheon) -
# A remote target is "[user@]host:path" — i.e. a colon with no slash before it.
DEST_HOST="${DEST%%:*}"
DEST_PATH="${DEST#*:}"
if [[ "$DEST" == *:* && "$DEST_HOST" != */* && "$DEST_PATH" == /* ]]; then
  echo "!! warning: remote path '$DEST_PATH' is ABSOLUTE." >&2
  echo "   SFTP-jailed hosts (e.g. Pantheon) expect a RELATIVE path — drop the" >&2
  echo "   leading slash, e.g. '${DEST_HOST}:${DEST_PATH#/}'." >&2
fi

# --- Safeguard 2: rewrite an over-long ssh ControlPath to use %C -------------
# The 104-byte unix-socket limit is easily blown by long hostnames (Pantheon)
# when ControlPath uses %h/%r/%p. %C is a short fixed-length hash of the same
# connection identity, so swapping to it is safe and keeps multiplexing.
if [[ ${#RSYNC_EXTRA[@]} -gt 0 ]]; then
  # Estimate the expansion of ssh tokens for a length check.
  cp_user="${DEST_HOST%@*}"; [[ "$DEST_HOST" == *@* ]] || cp_user="$(id -un 2>/dev/null || echo user)"
  cp_host="${DEST_HOST##*@}"
  cp_lhost="$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo localhost)"
  for i in "${!RSYNC_EXTRA[@]}"; do
    e="${RSYNC_EXTRA[$i]}"
    case "$e" in
      *ControlPath=*)
        cp="${e##*ControlPath=}"; cp="${cp%% *}"          # the ControlPath token
        cp_port="22"; case "$e" in *"-p "*) cp_port="${e##*-p }"; cp_port="${cp_port%% *}";; esac
        exp="$cp"
        exp="${exp/#\~/$HOME}"
        exp="${exp//%h/$cp_host}"
        exp="${exp//%r/$cp_user}"
        exp="${exp//%p/$cp_port}"
        exp="${exp//%l/$cp_lhost}"
        exp="${exp//%C/0000000000000000000000000000000000000000}"  # %C ~ 40 chars
        if [[ "$cp" == *%C* ]]; then
          : # already using %C — fine
        elif [[ ${#exp} -ge 104 ]]; then
          cp_dir="${cp%/*}"; [[ "$cp_dir" == "$cp" ]] && cp_dir="~/.ssh"
          new_cp="$cp_dir/wpress-cm-%C"
          RSYNC_EXTRA[$i]="${e/ControlPath=$cp/ControlPath=$new_cp}"
          echo "!! note: ssh ControlPath '$cp' would exceed the 104-byte socket limit;" >&2
          echo "   rewrote it to '$new_cp' (short %C hash) so multiplexing still works." >&2
        fi
        ;;
    esac
  done
fi

# Manifest of every file under the target dir: "<bytes>\t<path>".
MANIFEST="$(mktemp "./.wpress-manifest.XXXXXX")"
SKIPPED=""
node "$WPRESS_JS" manifest "$ARCHIVE" "$ARCHIVE_DIR" > "$MANIFEST"
[[ -s "$MANIFEST" ]] || { rm -f "$MANIFEST"; die "no files found under '$ARCHIVE_DIR' in the archive"; }

# Optionally split off files larger than --max-file (skip them, list at end).
if [[ "$MAXFILE" -gt 0 ]]; then
  # Persistent log so the skip record survives terminal scrollback.
  SKIPPED="./wpress-skipped-${ARCHIVE_DIR//\//_}.tsv"
  rm -f "$SKIPPED"
  FILTERED="$(mktemp "./.wpress-filtered.XXXXXX")"
  awk -F'\t' -v M="$MAXFILE" -v S="$SKIPPED" '{ if ($1 > M) print $0 > S; else print }' "$MANIFEST" > "$FILTERED"
  mv "$FILTERED" "$MANIFEST"
  [[ -s "$MANIFEST" ]] || { rm -f "$MANIFEST"; die "every file under '$ARCHIVE_DIR' exceeds --max-file"; }
fi

TOTAL_FILES="$(wc -l < "$MANIFEST" | tr -d ' ')"
TOTAL_BYTES="$(awk -F'\t' '{s+=$1} END{print s}' "$MANIFEST")"

# Precompute the batch count for messaging (greedy fill to BUDGET).
NUM_BATCHES="$(awk -F'\t' -v B="$BUDGET" '
  { if (n>0 && n+$1 > B) { b++; n=0 } n+=$1; if (n==0||NR==1&&b==0) {} ; got=1 }
  END { if (got) print b+1; else print 0 }' "$MANIFEST")"

human() { awk -v b="$1" 'BEGIN{u="B KB MB GB TB";split(u,a," ");i=1;while(b>=1024&&i<5){b/=1024;i++}printf "%.1f %s", b, a[i]}'; }

report_skipped() {
  [[ -n "$SKIPPED" && -s "$SKIPPED" ]] || return 0
  local n bytes
  n="$(wc -l < "$SKIPPED" | tr -d ' ')"
  bytes="$(awk -F'\t' '{s+=$1} END{print s}' "$SKIPPED")"
  echo "" >&2
  echo ">> SKIPPED $n file(s) over $(human "$MAXFILE") ($(human "$bytes")) — NOT transferred:" >&2
  awk -F'\t' '{ printf "     %10.1f MB  %s\n", $1/1048576, $2 }' "$SKIPPED" | sort -rn >&2
  echo "   recorded in: $SKIPPED" >&2
  echo "   to extract just these later:" >&2
  echo "     node \"$WPRESS_JS\" extract-file \"$ARCHIVE\" --from <(cut -f2 \"$SKIPPED\") -o ./big-files" >&2
}

echo ">> '$ARCHIVE_DIR': $TOTAL_FILES files, $(human "$TOTAL_BYTES") total" >&2
echo ">> budget $(human "$BUDGET")/batch -> ~$NUM_BATCHES batch(es); peak staging <= one batch" >&2

if [[ "$DRYRUN" -eq 1 ]]; then
  echo ">> (dry run) would sync to: $DEST" >&2
  if [[ ${#RSYNC_EXTRA[@]} -gt 0 ]]; then
    echo ">> rsync passthrough: ${RSYNC_EXTRA[*]}" >&2
  fi
  report_skipped
  rm -f "$MANIFEST"
  exit 0
fi

# Staging + cleanup.
CREATED_STAGING=0
if [[ -z "$STAGING" ]]; then
  STAGING="$(mktemp -d "./.wpress-rsync.XXXXXX")"
  CREATED_STAGING=1
else
  mkdir -p "$STAGING"
fi
cleanup() {
  rm -f "$MANIFEST"
  # NOTE: the skipped-files log ($SKIPPED) is intentionally kept as a record.
  if [[ "$KEEP" -eq 1 ]]; then
    echo "Staging kept at: $STAGING" >&2
  elif [[ "$CREATED_STAGING" -eq 1 || -d "$STAGING" ]]; then
    rm -rf "$STAGING"
  fi
}
trap cleanup EXIT

# Base rsync flags (override via env, e.g. RSYNC_BASE='-rlvz' for Pantheon).
if [[ -n "${RSYNC_BASE:-}" ]]; then
  read -r -a RSYNC_BASE_ARR <<< "$RSYNC_BASE"
else
  RSYNC_BASE_ARR=(-a)
fi

# Progress flag the local rsync understands (macOS rsync 2.6.9 lacks --info).
PROGRESS=()
if rsync --help 2>&1 | grep -q -- '--info='; then
  PROGRESS=(--info=progress2)
elif rsync --help 2>&1 | grep -q -- '--progress'; then
  PROGRESS=(--progress)
fi

LISTFILE="$STAGING/.batch-list"
BATCH=0

flush_batch() {
  [[ -s "$LISTFILE" ]] || return 0
  BATCH=$((BATCH + 1))
  local count; count="$(wc -l < "$LISTFILE" | tr -d ' ')"
  echo ">> [batch $BATCH/$NUM_BATCHES] staging $count file(s)..." >&2
  node "$WPRESS_JS" extract-file "$ARCHIVE" --from "$LISTFILE" -o "$STAGING" >/dev/null \
    || die "failed to stage batch $BATCH"

  echo ">> [batch $BATCH/$NUM_BATCHES] rsync -> $DEST" >&2
  rsync "${RSYNC_BASE_ARR[@]}" \
    ${PROGRESS[@]+"${PROGRESS[@]}"} \
    ${RSYNC_EXTRA[@]+"${RSYNC_EXTRA[@]}"} \
    "$STAGING/$ARCHIVE_DIR/" "$DEST"

  # Drop everything we just sent so peak disk stays ~one batch.
  rm -rf "${STAGING:?}/$ARCHIVE_DIR"
  : > "$LISTFILE"
}

acc=0
while IFS=$'\t' read -r size path; do
  [[ -n "$path" ]] || continue
  if [[ "$acc" -gt 0 && $(( acc + size )) -gt "$BUDGET" ]]; then
    flush_batch
    acc=0
  fi
  printf '%s\n' "$path" >> "$LISTFILE"
  acc=$(( acc + size ))
done < "$MANIFEST"
flush_batch

echo ">> Done ($BATCH batch(es), $(human "$TOTAL_BYTES") synced)." >&2
report_skipped
