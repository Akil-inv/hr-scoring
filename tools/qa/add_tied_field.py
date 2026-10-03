#!/usr/bin/env python3
"""
Add the `tied` field to model RankingResult in schema.prisma.

    python3 tools/qa/add_tied_field.py
    python3 tools/qa/add_tied_field.py --revert

Backs up to schema.prisma.bak. Idempotent. Inserts after `judgeCount` so it
sits with the other result columns rather than at the end of the model.
"""

import re
import shutil
import sys
from pathlib import Path

SCHEMA = Path("apps/api/prisma/schema.prisma")
FIELD = "  tied              Boolean  @default(false)"


def main() -> int:
    if not SCHEMA.exists():
        print(f"not found: {SCHEMA}  (run from the repo root)")
        return 2

    bak = SCHEMA.with_suffix(".prisma.bak")

    if "--revert" in sys.argv:
        if not bak.exists():
            print(f"no backup at {bak}")
            return 2
        shutil.copy(bak, SCHEMA)
        print(f"restored {SCHEMA}")
        return 0

    src = SCHEMA.read_text()

    m = re.search(r"model RankingResult \{(.*?)\n\}", src, re.S)
    if not m:
        print("could not find `model RankingResult` in schema.prisma")
        return 1

    body = m.group(1)
    if re.search(r"^\s*tied\s", body, re.M):
        print("`tied` already present — nothing to do")
        return 0

    lines = body.split("\n")
    anchor = next(
        (i for i, l in enumerate(lines) if re.match(r"\s*judgeCount\s", l)), None
    )
    if anchor is None:
        # Fall back to the last field line before any attribute block.
        anchor = max(
            i for i, l in enumerate(lines)
            if l.strip() and not l.strip().startswith("@@")
        )

    lines.insert(anchor + 1, FIELD)
    new_body = "\n".join(lines)
    out = src[: m.start(1)] + new_body + src[m.end(1):]

    shutil.copy(SCHEMA, bak)
    SCHEMA.write_text(out)

    after = SCHEMA.read_text()
    m2 = re.search(r"model RankingResult \{(.*?)\n\}", after, re.S)
    if not m2 or not re.search(r"^\s*tied\s", m2.group(1), re.M):
        shutil.copy(bak, SCHEMA)
        print("verification failed, reverted")
        return 1

    print(f"added `tied` to model RankingResult in {SCHEMA}")
    print(f"backup at {bak}\n")
    print("next:")
    print("  cd apps/api && npx prisma migrate dev --name add_ranking_tied && cd ../..")
    print("  ./dev.sh build && ./dev.sh restart")
    return 0


if __name__ == "__main__":
    sys.exit(main())
