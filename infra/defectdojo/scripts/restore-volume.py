#!/usr/bin/env python3

from __future__ import annotations

import argparse
import shutil
import sys
import tarfile
from pathlib import Path


TARGETS = {
    "media": Path("/restore/media"),
    "valkey": Path("/restore/valkey"),
    "caddy-data": Path("/restore/caddy-data"),
    "caddy-config": Path("/restore/caddy-config"),
}


def clear_directory(path: Path) -> None:
    if path not in TARGETS.values() or not path.is_dir():
        raise RuntimeError(f"refusing to clear unexpected target: {path}")
    for child in path.iterdir():
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child)
        else:
            child.unlink()


def validate_members(archive: tarfile.TarFile) -> None:
    for member in archive.getmembers():
        member_path = Path(member.name)
        if member_path.is_absolute() or ".." in member_path.parts:
            raise RuntimeError(f"unsafe archive member: {member.name}")
        if member.isdev() or member.isfifo():
            raise RuntimeError(f"unsupported archive member type: {member.name}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Safely restore an allowlisted DefectDojo volume.",
    )
    parser.add_argument("target", choices=sorted(TARGETS))
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--clear-only", action="store_true")
    args = parser.parse_args()

    destination = TARGETS[args.target]
    if args.clear_only:
        if args.archive is not None:
            parser.error("--archive cannot be combined with --clear-only")
        clear_directory(destination)
        return 0

    if args.archive is None or not args.archive.is_file():
        parser.error("--archive must identify a regular tar.gz file")

    with tarfile.open(args.archive, mode="r:gz") as archive:
        validate_members(archive)
        clear_directory(destination)
        archive.extractall(destination, filter="data")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, tarfile.TarError) as exc:
        print(f"restore failed: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
