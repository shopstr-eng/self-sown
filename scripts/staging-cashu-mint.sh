#!/usr/bin/env bash
# Starts the staging Nutshell Cashu mint (FakeWallet) on 127.0.0.1:3338.
#
# The mint runs from a Python venv in /tmp (kept out of the repo on purpose),
# which is EPHEMERAL — this script bootstraps the venv if it is missing or
# broken, then execs the mint. Wired to the "Staging Cashu Mint" workflow.
#
# Bootstrap gotchas in this environment (learned the hard way):
# - The Replit package firewall 403s h11 0.13/0.14 wheels AND sdists, but
#   httpcore (via httpx, a cashu dep) pins h11<0.15. h11 0.16 installs fine
#   and works at runtime, so we preinstall it and then install httpx/httpcore
#   with --no-deps (their h11 pin is metadata-only).
# - pip in this image defaults to --user (via PIP_CONFIG_FILE), which fails
#   inside a venv — PIP_USER=0 overrides it.
# - PYTHONPATH injects the Nix-store pip + sitecustomize into EVERY python
#   here, including the venv one, so venv pip resolves its install scheme
#   against the read-only Nix store ("Permission denied: .../site-packages").
#   Scrub PYTHONPATH/PYTHONUSERBASE/the poetry pip vars and neutralize
#   PIP_CONFIG_FILE for all pip invocations.
# - pip-generated entry points here get a "#!/usr/bin/env python3" shebang
#   that resolves to the system python (no cashu) — rewrite to the venv python.
# - Latest slowapi/limits dropped the "fixed-window-elastic-expiry" strategy
#   cashu 0.20.3 configures; pin slowapi==0.1.9 + limits==3.14.1.
set -euo pipefail

VENV=/tmp/nutshell-venv
DATA=/tmp/nutshell-data
MINT_VERSION=0.20.3

if ! "$VENV/bin/python" -c "import cashu.mint.main" >/dev/null 2>&1; then
  echo "[staging-mint] bootstrapping nutshell mint venv at $VENV ..."
  rm -rf "$VENV"
  python3 -m venv "$VENV"
  pip_venv() {
    env -u PYTHONPATH -u PYTHONUSERBASE -u REPLIT_PYTHONPATH \
      -u POETRY_PIP_NO_ISOLATE -u POETRY_PIP_NO_PREFIX -u POETRY_PIP_FROM_PATH \
      PIP_CONFIG_FILE=/dev/null PIP_USER=0 \
      "$VENV/bin/python" -m pip "$@"
  }
  pip_venv install --quiet --upgrade pip
  pip_venv install --quiet "h11>=0.16"   # firewall blocks h11<0.15 artifacts
  pip_venv install --quiet --no-deps "cashu==$MINT_VERSION"
  pip_venv install --quiet \
    aiosqlite bech32 bip32 bitstring bolt11 brotli cbor2 click cryptography \
    ecdsa environs fastapi greenlet importlib-metadata jinja2 loguru mnemonic \
    pycryptodomex pydantic pydantic-settings pyjwt setuptools SQLAlchemy \
    uvicorn websockets wheel zstandard \
    grpcio grpcio-tools googleapis-common-protos redis websocket-client \
    mypy-protobuf types-protobuf asyncpg breez-sdk-spark \
    anyio sniffio certifi idna
  pip_venv install --quiet --no-deps httpx httpcore   # h11<0.15 pin is metadata-only
  pip_venv install --quiet "slowapi==0.1.9" "limits==3.14.1"
  # Entry points get a system-python shebang in this image; point them at the venv.
  for bin in mint mint-cli cashu; do
    [ -f "$VENV/bin/$bin" ] && sed -i "1s|.*|#!$VENV/bin/python|" "$VENV/bin/$bin"
  done
  "$VENV/bin/python" -c "import cashu.mint.main"
  echo "[staging-mint] bootstrap complete"
fi

mkdir -p "$DATA"
cd "$DATA"
export MINT_RATE_LIMIT=FALSE \
  MINT_BACKEND_BOLT11_SAT=FakeWallet \
  MINT_INPUT_FEE_PPK=0 \
  MINT_LISTEN_HOST=127.0.0.1 \
  MINT_LISTEN_PORT=3338 \
  MINT_DATABASE="$DATA" \
  MINT_PRIVATE_KEY=TEST_PRIVATE_KEY \
  MINT_NAME="Staging Fake Mint"
exec "$VENV/bin/mint"
