# Ghost MySQL images

The Linux Docker route checks CPU flags before creating task state. All x86 CPUs must report the required x86-64-v2 features to select the normal image. Missing features select the compatibility build; unreadable or inconclusive flags stop preparation. ARM64 uses the standard image.

- Standard: official MySQL 8.4.11 image, pinned by digest.
- Older x86-64: Debian Bookworm image with Oracle's MySQL 8.4.13 Debian packages, pinned by SHA-256. This keeps the maintained 8.4 family rather than downgrading to MySQL 8.0.

Exact image, package and source pins are in [ghost-mysql-compat.js](../src/ghost-mysql-compat.js). The build downloads the unchanged Docker-library MySQL entrypoint from commit `01f90d87012e46cd174073bba02d64e9fc693ed3`, verifies its checksum, and retains its GPL-2.0 license inside the image at `/usr/share/doc/intentaiops-mysql-compat/COPYING`. Debian dependencies use signed distribution repositories. Building requires access to those repositories, Oracle's package repository and GitHub.

Acquisition/build and startup are separate reviewed execution steps. The alternative uses a temporary task-owned BuildKit builder and a task-specific image tag. Rollback removes only task-owned resources and verifies the built image identity before removal. No existing Ghost containers, volumes, networks or service paths are reused. This is not a database migration or downgrade mechanism.

The compatibility build is Linux-only. macOS retains its standard Colima route; Windows retains its existing image pins. Automated fixtures cover selection, shell syntax and cleanup ownership. Live results and outstanding platform checks are recorded in the repository's `netbook-docker-validation-status.md`, which is not included in the installed package.

Sources: [Oracle MySQL Debian packages](https://repo.mysql.com/apt/debian/dists/bookworm/mysql-8.4-lts/binary-amd64/Packages), [Docker-library MySQL source and license](https://github.com/docker-library/mysql/tree/01f90d87012e46cd174073bba02d64e9fc693ed3), [MySQL support lifecycle](https://www.mysql.com/support/eol-notice.html).
