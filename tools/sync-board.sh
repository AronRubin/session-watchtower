#!/usr/bin/env bash
# Copies the committed phone board (session-board) into board/: lib/ without scan-worker.js, and public/.
# Only the committed version is copied (git archive), never work in progress. board/SOURCE.txt records the
# source commit and a sha256 per file; a test checks that the files in board/ still match it, so board/ is
# never edited in place: change session-board, commit there, then run this again.
# Usage: tools/sync-board.sh [path to the session-board repository]
set -euo pipefail
SRC="${1:-$HOME/tools/session-board}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DST="$ROOT/board"
[ -f "$SRC/lib/board-server.js" ] || { echo "not a session-board repository: $SRC" >&2; exit 1; }
rev=$(git -C "$SRC" rev-parse HEAD)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git -C "$SRC" archive "$rev" lib public | tar -x -C "$tmp"
rm -f "$tmp/lib/scan-worker.js"
case "$DST" in */session-watchtower/board|*/board) ;; *) echo "unexpected target: $DST" >&2; exit 1;; esac
rm -rf "$DST/lib" "$DST/public"
mkdir -p "$DST"
cp -R "$tmp/lib" "$tmp/public" "$DST/"
{
  echo "session-board $rev"
  echo "Copied by tools/sync-board.sh: lib/ (without scan-worker.js) and public/. Do not edit these files here."
  echo
  (cd "$DST" && find lib public -type f | LC_ALL=C sort | while read -r f; do sha256sum "$f"; done)
} > "$DST/SOURCE.txt"
echo "board/ <- session-board $rev ($(find "$DST/lib" "$DST/public" -type f | wc -l) files)"
