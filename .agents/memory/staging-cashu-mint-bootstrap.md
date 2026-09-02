---
name: Staging Cashu mint bootstrap
description: How the Staging Cashu Mint workflow is provisioned, and the environment gotchas that break a naive pip install of nutshell
---

The "Staging Cashu Mint" workflow runs `bash scripts/staging-cashu-mint.sh`, which
bootstraps a nutshell (cashu 0.20.3, FakeWallet) venv into /tmp on demand and execs
the mint on 127.0.0.1:3338. /tmp is EPHEMERAL — the venv vanishes on container
restart, so never assume `/tmp/nutshell-venv` exists; the script rebuilds it.

**Why:** the venv disappeared once already and the workflow silently failed; the
script exists so the mint self-heals. Naive `pip install cashu` FAILS here:

- The Replit package firewall 403s h11 0.13/0.14 (wheel AND sdist), but httpcore
  (via httpx, a cashu dep) pins h11<0.15. Workaround: install h11>=0.16 first,
  then `pip install --no-deps httpx httpcore` — the pin is metadata-only and
  httpcore 1.0.9 runs fine on h11 0.16.
- pip defaults to `--user` via PIP_CONFIG_FILE (fails inside a venv) — export
  PIP_USER=0.
- pip-generated entry points get a `#!/usr/bin/env python3` shebang that resolves
  to the SYSTEM python (no cashu module) — rewrite it to the venv python.
- Latest slowapi/limits removed the `fixed-window-elastic-expiry` strategy cashu
  configures at startup — pin slowapi==0.1.9 + limits==3.14.1.
- A workflow whose process binds 127.0.0.1 must NOT set waitForPort — the port
  checker never sees it and kills the workflow after the timeout.

**How to apply:** if the staging mint is down, restart the workflow (it
rebootstraps); if the bootstrap itself breaks after a cashu version bump, start
from the script's workaround list rather than rediscovering each failure. The
real-mint Jest tests gate on `${STAGING_CASHU_MINT_URL ?? http://127.0.0.1:3338}`
and skip with a warning when it is unreachable.
