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
# - cashu 0.20.3 pins tight ranges for nearly every dep; installing them
#   unpinned lands incompatible majors (e.g. bitstring 5.x removes
#   ConstBitStream → ImportError at mint startup). Pin every dep to cashu's
#   declared range (see `pip show cashu` Requires / importlib.metadata).
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
  # Pin every dep to the ranges cashu 0.20.3 declares (importlib.metadata
  # requires("cashu")); unpinned installs drift to incompatible majors.
  pip_venv install --quiet \
    "aiosqlite>=0.20.0,<0.21.0" "bech32>=1.2.0,<2.0.0" "bip32>=4.0,<5.0" \
    "bitstring>=3.1.9,<4.0.0" "bolt11>=2.0.5,<3.0.0" "brotli>=1.1.0,<2.0.0" \
    "cbor2>=5.6.2,<6.0.0" "click>=8.1.7,<9.0.0" \
    "cryptography>=43.0.1,<44.0.0" "ecdsa>=0.19.0,<0.20.0" \
    "environs>=9.5.0,<10.0.0" "marshmallow>=3.13.0,<4.0.0" \
    "fastapi>=0.115.0,<0.116.0" \
    "greenlet>=3.0.0" "importlib-metadata>=6.8.0,<7.0.0" \
    "jinja2>=3.1.5,<4.0.0" "loguru>=0.7.0,<0.8.0" "mnemonic>=0.20,<0.21" \
    "pycryptodomex>=3.16.0,<4.0.0" "pydantic>=2.5.3,<3.0.0" \
    "pydantic-settings>=2.1.0,<3.0.0" "pyjwt>=2.9.0,<3.0.0" \
    "setuptools>=75.1.0,<76.0.0" "SQLAlchemy[asyncio]>=2.0.35,<3.0.0" \
    "uvicorn>=0.31.0,<0.32.0" "websockets>=12.0,<13.0" \
    "wheel>=0.41.1,<0.42.0" "zstandard>=0.23.0,<0.24.0" \
    "grpcio>=1.65.1,<2.0.0" "grpcio-tools>=1.65.1,<2.0.0" \
    "googleapis-common-protos>=1.63.2,<2.0.0" "redis>=5.1.1,<6.0.0" \
    "websocket-client>=1.3.3,<2.0.0" "mypy-protobuf>=3.6.0,<4.0.0" \
    "types-protobuf>=5.27.0.20240626,<6.0.0.0" "asyncpg>=0.30.0,<0.31.0" \
    anyio sniffio certifi idna socksio
  # cashu pins breez-sdk-spark<0.16, but 0.15.x was yanked from the index
  # (only 0.18+ remain). It's only used by the Breez Lightning backend —
  # the FakeWallet staging mint never touches it — so take the latest.
  pip_venv install --quiet breez-sdk-spark
  pip_venv install --quiet --no-deps "httpx>=0.25.1,<0.26.0" httpcore   # h11<0.15 pin is metadata-only
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
