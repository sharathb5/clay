#!/usr/bin/env bash
# Trusted verifier launcher: preserves the verifier's real exit status.
# Optional --tee uses a pipeline under pipefail so logging cannot hide failure.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <verify.ts|verify-clay.ts> [--tee <logfile>]" >&2
  exit 2
fi

script="$1"
shift

tee_file=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tee)
      if [[ $# -lt 2 ]]; then
        echo "usage: $0 <script> [--tee <logfile>]" >&2
        exit 2
      fi
      tee_file="$2"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

run=(npx tsx "tests/$script")

if [[ -n "$tee_file" ]]; then
  # pipefail: pipeline exits non-zero if tsx fails, even when tee succeeds.
  "${run[@]}" 2>&1 | tee "$tee_file"
else
  "${run[@]}"
fi
