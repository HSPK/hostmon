from __future__ import annotations

import re
import sys
import tarfile
import zipfile
from pathlib import Path


FORBIDDEN = re.compile(
    rb"kubernetes|cluster_gpu|volcano|k8s|gpu fleet|gpu workloads|"
    rb"workload|fleet|submitter|creator_id|running_gpus|pending_gpus|"
    rb"queue-a|queue-b|oidc@|bonete",
    re.IGNORECASE,
)


def scan(path: Path) -> list[str]:
    matches: list[str] = []
    if path.suffix == ".whl":
        with zipfile.ZipFile(path) as archive:
            for name in archive.namelist():
                if FORBIDDEN.search(name.encode()) or FORBIDDEN.search(
                    archive.read(name)
                ):
                    matches.append(name)
        return matches
    with tarfile.open(path) as archive:
        for member in archive.getmembers():
            if not member.isfile():
                continue
            handle = archive.extractfile(member)
            content = handle.read() if handle is not None else b""
            if FORBIDDEN.search(member.name.encode()) or FORBIDDEN.search(content):
                matches.append(member.name)
    return matches


def main(arguments: list[str]) -> int:
    failed = False
    for raw_path in arguments:
        path = Path(raw_path)
        matches = scan(path)
        print(f"{path.name}: {len(matches)} forbidden matches")
        for name in matches:
            print(f"  {name}")
        failed = failed or bool(matches)
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
