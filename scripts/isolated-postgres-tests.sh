#!/usr/bin/env bash
# Run only inside run-isolated-validation.sh. This database is disposable and
# accepts Unix-domain sockets only; no host database or credentials are used.
set -euo pipefail
[[ "$(id -u)" != 0 && -d /scratch ]] || {
  echo "Run this through the isolated validation runner" >&2; exit 1;
}
for candidate in /nix/store/*-postgresql-17.*/bin; do
  [[ -x "$candidate/postgres" ]] || continue
  pg="$candidate"
  break
done
: "${pg:?A Nix PostgreSQL 17 toolchain is required}"
"$pg/initdb" -D /scratch/pg --no-locale --encoding=UTF8 --auth=trust >/scratch/initdb.log
trap '"$pg/pg_ctl" -D /scratch/pg -m immediate stop >/dev/null 2>&1 || true' EXIT
"$pg/pg_ctl" -D /scratch/pg -l /scratch/postgres.log \
  -o "-k /scratch -h '' -c shared_buffers=16MB -c max_connections=20 -c max_files_per_process=100 -c dynamic_shared_memory_type=mmap" \
  -w start >/dev/null
export ESCROW_CONCURRENCY_TEST_DATABASE_URL='postgresql://validation@localhost/postgres?host=/scratch'
export UCP_CONCURRENCY_TEST_DATABASE_URL="$ESCROW_CONCURRENCY_TEST_DATABASE_URL"
export UCP_CHECKOUT_TEST_DATABASE_URL="$ESCROW_CONCURRENCY_TEST_DATABASE_URL"
export RELEASE_PROTOCOL_TEST_DATABASE_URL="$ESCROW_CONCURRENCY_TEST_DATABASE_URL"
node --max-old-space-size=1536 node_modules/jest/bin/jest.js \
  --config scripts/isolated-jest.config.cjs --runInBand --no-cache --no-coverage "$@"
