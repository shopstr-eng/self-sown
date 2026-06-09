#!/bin/bash
set -e

# Runs automatically after a task is merged to reconcile the environment.
# Stdin is closed, so everything must be non-interactive.
#
# Dependencies: a merged task may add/remove packages, so reinstall to match
# the merged lockfile. The database schema is created at runtime by
# initializeTables() in utils/db/db-service.ts (CREATE TABLE IF NOT EXISTS),
# so no migration step is needed here. The dev workflow rebuilds on restart
# during workflow reconciliation, so we don't build here.

pnpm install --prefer-offline
