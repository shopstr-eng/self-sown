---
name: Isolated validation environment
description: Constraints for executing untrusted project code and real PostgreSQL tests without ambient credentials or network access.
---

This workspace permits user, mount, network, PID, IPC and UTS namespaces with a scratch tmpfs and read-only source/toolchain mounts, but a proc mount is blocked. Native SWC/Jest transforms expect proc and can fail; a Babel-only Jest transform can exercise the same code without weakening the sandbox. For a disposable real database, map the sandbox identity to a non-root UID and run PostgreSQL over a Unix-domain socket in writable scratch, without TCP or production credentials. Metro exports may require a larger descriptor budget even when one worker is requested.

**Why:** ordinary host-side tests/builds inherit ambient secrets and network; initial sandbox attempts exposed missing proc and a Postgres initdb root restriction, while a mobile export exceeded a tight file-descriptor cap.

**How to apply:** prefer the bounded isolated validation runner for executing project code during security remediation. Keep source/toolchains read-only, pass no ambient secrets, and raise only measured resource ceilings rather than opening the network or host filesystem.
