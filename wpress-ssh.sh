#!/usr/bin/env bash
#
# wpress-ssh.sh — stream a directory out of a .wpress archive straight to a
# remote server over SSH, WITHOUT staging anything to local disk.
#
# It pipes:  wpress.js tar  ->  (gzip?)  ->  ssh host 'tar -x -C <dest>'
# so peak local disk usage is ~0 regardless of how big the directory is.
#
# Usage:
#   wpress-ssh.sh <archive.wpress> <archive-dir> <[user@]host:/dest> [opts] [-- ssh-opts...]
#
#   <archive-dir>     A directory inside the archive, e.g. "uploads".
#   <[user@]host:/dest>  Remote target. The directory's CONTENTS are written
#                        INTO /dest (so point it at the final folder, e.g.
#                        user@web.example.com:/var/www/html/wp-content/uploads).
#
# Options:
#   -z, --gzip        Compress the stream in transit (good for text/sql; little
#                     benefit for already-compressed images).
#   -n, --dry-run     Print the pipeline that would run, then exit.
#   -h, --help        Show this help.
#
# Anything after "--" is passed to ssh, e.g.:
#   wpress-ssh.sh bk.wpress uploads user@host:/var/www/uploads -- -p 2222 -i ~/.ssh/id_ed25519
#
# Notes:
#   * The remote needs `tar` (GNU tar or bsdtar) and write access to <dest>.
#   * If `pv` is installed locally you'll get a live throughput meter.

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
SSH_BIN="${WPRESS_SSH:-ssh}"

die() { echo "Error: $*" >&2; exit 1; }
usage() { sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

GZIP=0
DRYRUN=0
POSITIONAL=()
SSH_OPTS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage 0 ;;
    -z|--gzip) GZIP=1; shift ;;
    -n|--dry-run) DRYRUN=1; shift ;;
    --) shift; SSH_OPTS=("$@"); break ;;
    -*) die "Unknown option: $1 (run --help)" ;;
    *) POSITIONAL+=("$1"); shift ;;
  esac
done

[[ ${#POSITIONAL[@]} -eq 3 ]] || usage 1
ARCHIVE="${POSITIONAL[0]}"
ARCHIVE_DIR="${POSITIONAL[1]%/}"
DEST="${POSITIONAL[2]}"

# Split [user@]host:/path on the first colon.
[[ "$DEST" == *:* ]] || die "destination must look like user@host:/path (got: $DEST)"
REMOTE_HOST="${DEST%%:*}"
REMOTE_PATH="${DEST#*:}"
[[ -n "$REMOTE_HOST" && -n "$REMOTE_PATH" ]] || die "could not parse host/path from: $DEST"

command -v node >/dev/null 2>&1 || die "node is not installed / not on PATH"
[[ -f "$WPRESS_JS" ]] || die "cannot find wpress.js at: $WPRESS_JS (set WPRESS_JS=...)"
[[ -f "$ARCHIVE"  ]] || die "archive not found: $ARCHIVE"

TAR_X="tar -x"
[[ "$GZIP" -eq 1 ]] && TAR_X="tar -xz"
REMOTE_CMD="mkdir -p $(printf %q "$REMOTE_PATH") && cd $(printf %q "$REMOTE_PATH") && $TAR_X"

if [[ "$DRYRUN" -eq 1 ]]; then
  echo "node \"$WPRESS_JS\" tar \"$ARCHIVE\" \"$ARCHIVE_DIR\" --strip \"$ARCHIVE_DIR\" \\"
  [[ "$GZIP" -eq 1 ]] && echo "  | gzip \\"
  echo "  | $SSH_BIN ${SSH_OPTS[*]:-} \"$REMOTE_HOST\" $(printf %q "$REMOTE_CMD")"
  exit 0
fi

# Pipeline stages (functions keep optional gzip/pv composable and quote-safe).
src_stream() { node "$WPRESS_JS" tar "$ARCHIVE" "$ARCHIVE_DIR" --strip "$ARCHIVE_DIR"; }
maybe_pv()   { if command -v pv >/dev/null 2>&1; then pv; else cat; fi; }
maybe_gzip() { if [[ "$GZIP" -eq 1 ]]; then gzip; else cat; fi; }

echo ">> Streaming '$ARCHIVE_DIR' -> $REMOTE_HOST:$REMOTE_PATH (no local staging)" >&2

src_stream \
  | maybe_pv \
  | maybe_gzip \
  | "$SSH_BIN" ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$REMOTE_HOST" "$REMOTE_CMD"

echo ">> Done." >&2
