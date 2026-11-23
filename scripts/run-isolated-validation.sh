#!/usr/bin/env bash
# Linux-only test runner: no network, no credentials, read-only source/toolchain,
# bounded tmpfs scratch, and per-process resource plus overall wall-clock limits.
set -euo pipefail
if [[ "${1:-}" != "--inside" ]]; then
  repo="$(cd "$(dirname "$0")/.." && pwd)"
  exec env -i PATH="$PATH" \
    unshare --user --map-user=1000 --map-group=1000 --keep-caps --mount --net --ipc --uts --pid --fork \
    bash "$0" --inside "$repo" "$@"
fi
shift
repo="$1"; shift
wall_seconds=240
cpu_seconds=180
file_limit=512
if [[ "${1:-}" == "--extended" ]]; then
  wall_seconds=600
  cpu_seconds=480
  file_limit=4096
  shift
fi
root="$(mktemp -d)"
trap 'umount -R "$root" 2>/dev/null || true; rmdir "$root" 2>/dev/null || true' EXIT
mount -t tmpfs -o size=512m,nosuid,nodev tmpfs "$root"
mkdir -p "$root/app" "$root/nix/store" "$root/dev" "$root/scratch" "$root/usr/bin" "$root/etc"
printf 'validation:x:1000:1000::/scratch/home:/bin/false\n' > "$root/etc/passwd"
printf 'validation:x:1000:\n' > "$root/etc/group"
# Only version-controlled/source files enter the disposable copy. Private
# credential files are excluded even if accidentally tracked.
cd "$repo"
git ls-files -z --cached --others --exclude-standard |
  python3 -c 'import sys; paths=sys.stdin.buffer.read().split(b"\0"); sys.stdout.buffer.write(b"".join(p+b"\0" for p in paths if p and not any(s in p.split(b"/") for s in [b"keys",b".git",b".config",b".agents",b".local",b"attached_assets"]) and not p.split(b"/")[-1].startswith((b".env",b"credentials.")) and not p.endswith((b".p8",b".p12",b".pem",b".mobileprovision",b".jks",b".tsbuildinfo"))))' |
  tar --null --files-from=- -cf - | tar -xf - -C "$root/app"
mkdir -p "$root/app/node_modules"
mount --bind "$repo/node_modules" "$root/app/node_modules"
mount -o remount,bind,ro "$root/app/node_modules"
for modules in "$repo"/apps/*/node_modules "$repo"/packages/*/node_modules; do
  [[ -d "$modules" ]] || continue
  destination="$root/app/${modules#"$repo/"}"
  mkdir -p "$destination"
  mount --bind "$modules" "$destination"
  mount -o remount,bind,ro "$destination"
done
mount --bind /nix/store "$root/nix/store"
mount -o remount,bind,ro "$root/nix/store"
for device in null urandom random; do
  touch "$root/dev/$device"
  mount --bind "/dev/$device" "$root/dev/$device"
done
ln -s /scratch/tmp "$root/tmp"
ln -s "$(command -v env)" "$root/usr/bin/env"
mount -t tmpfs -o size=256m,nosuid,nodev tmpfs "$root/scratch"
mkdir -p "$root/scratch/home" "$root/scratch/tmp"
# Expo writes generated metadata even during an offline export. Give that
# cache a scratch-backed mount, never write access to the copied source.
mkdir -p "$root/scratch/expo" "$root/app/apps/mobile/.expo"
mount --bind "$root/scratch/expo" "$root/app/apps/mobile/.expo"
node="$(command -v node)"
shell="$(command -v bash)"
mkdir -p "$root/bin"
ln -s "$shell" "$root/bin/sh"
ln -s "$shell" "$root/bin/bash"
setpriv="$(readlink -f "$(command -v setpriv)")"
if [[ "$setpriv" != /nix/store/* ]]; then
  for candidate in /nix/store/*-util-linux*-bin/bin/setpriv; do
    [[ -x "$candidate" ]] || continue
    setpriv="$candidate"
    break
  done
fi
[[ "$setpriv" == /nix/store/* ]] || { echo "A Nix setpriv is required" >&2; exit 1; }
if [[ -f "$repo/.local/validation-tools/tla2tools.jar" ]]; then
  # Official TLA+ v1.7.4 release asset (the validation report records its URL).
  echo "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88  $repo/.local/validation-tools/tla2tools.jar" |
    sha256sum --check --status
  mkdir -p "$root/tools"
  cp "$repo/.local/validation-tools/tla2tools.jar" "$root/tools/tla2tools.jar"
fi
if [[ "${1:-}" == "--exec" ]]; then
  shift
  node="$1"
  shift
fi
mount -t tmpfs -o remount,ro tmpfs "$root"
timeout --kill-after=5s "${wall_seconds}s" prlimit \
  --as=12884901888 --cpu="$cpu_seconds" --nproc=128 --nofile="$file_limit" --fsize=67108864 --core=0 \
  chroot "$root" "$setpriv" --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs \
    /usr/bin/env -i \
    PATH="$PATH" HOME=/scratch/home TMPDIR=/scratch/tmp \
    NODE_ENV=test CI=1 NEXT_TELEMETRY_DISABLED=1 \
    NODE_OPTIONS="--max-old-space-size=1536 --disable-wasm-trap-handler" \
    "$shell" -c 'cd /app; exec "$@"' bash "$node" "$@"
