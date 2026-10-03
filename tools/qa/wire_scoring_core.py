#!/usr/bin/env python3
"""
Wire ScoringCoreService into the scorecards and judge-portal modules.

    python3 tools/qa/wire_scoring_core.py
    python3 tools/qa/wire_scoring_core.py --revert

Backs each file up to .bak. Idempotent — safe to run twice.
"""

import shutil
import sys
from pathlib import Path

TARGETS = [
    (Path("apps/api/src/scorecards/scorecards.module.ts"),
     "import { ScoringCoreService } from './scoring-core.service';",
     "providers: [ScorecardsService, ScorecardsResolver],",
     "providers: [ScorecardsService, ScorecardsResolver, ScoringCoreService],"),
    (Path("apps/api/src/judge-portal/judge-portal.module.ts"),
     "import { ScoringCoreService } from '../scorecards/scoring-core.service';",
     "providers: [JudgePortalService, JudgePortalResolver],",
     "providers: [JudgePortalService, JudgePortalResolver, ScoringCoreService],"),
]


def main() -> int:
    revert = "--revert" in sys.argv
    changed = 0

    for path, import_line, old_providers, new_providers in TARGETS:
        if not path.exists():
            print(f"not found: {path}  (run from the repo root)")
            return 2

        bak = path.with_suffix(".ts.bak")

        if revert:
            if bak.exists():
                shutil.copy(bak, path)
                print(f"restored {path}")
                changed += 1
            else:
                print(f"no backup for {path}")
            continue

        src = path.read_text()

        if "ScoringCoreService" in src:
            print(f"already wired: {path}")
            continue

        if src.count(old_providers) != 1:
            print(f"providers line not found (or ambiguous) in {path}")
            print(f"  expected exactly: {old_providers}")
            return 1

        # Insert the import after the last existing import line.
        lines = src.splitlines()
        last_import = max(i for i, l in enumerate(lines) if l.startswith("import "))
        lines.insert(last_import + 1, import_line)
        out = "\n".join(lines)
        out = out.replace(old_providers, new_providers)
        if not src.endswith("\n"):
            pass
        elif not out.endswith("\n"):
            out += "\n"

        shutil.copy(path, bak)
        path.write_text(out)

        after = path.read_text()
        if after.count("ScoringCoreService") != 2:
            shutil.copy(bak, path)
            print(f"verification failed for {path}, reverted")
            return 1

        print(f"wired {path}")
        changed += 1

    if changed and not revert:
        print("\nnext:  ./dev.sh build")
    return 0


if __name__ == "__main__":
    sys.exit(main())
