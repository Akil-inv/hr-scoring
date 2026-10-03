#!/usr/bin/env python3
"""
Insert the QA schedule tee into scheduling.service.ts.

    python3 tools/qa/add_schedule_tee.py

Writes a .bak alongside the original. Refuses to act if the anchor is missing
or appears more than once, and refuses to insert twice. Run --revert to undo.
"""

import shutil
import sys
from pathlib import Path

TARGET = Path("apps/api/src/scheduling/scheduling.service.ts")

ANCHOR = """        result = await response.json();
      }

      await this.audit.log({"""

TEE = """        result = await response.json();
      }

      // QA tee: captures the solve for tools/qa/check_schedule.py.
      // Off unless SCHEDULE_TEE_DIR is set. Wrapped so a write failure can
      // never fail a schedule generation.
      if (process.env.SCHEDULE_TEE_DIR) {
        try {
          const fs = await import('node:fs/promises');
          const dir = process.env.SCHEDULE_TEE_DIR;
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(
            `${dir}/${stamp}-request.json`,
            JSON.stringify(payload, null, 2),
          );
          await fs.writeFile(
            `${dir}/${stamp}-response.json`,
            JSON.stringify(result, null, 2),
          );
          console.log(`[schedule-tee] wrote ${dir}/${stamp}-{request,response}.json`);
        } catch (teeError) {
          console.warn(`[schedule-tee] failed: ${teeError}`);
        }
      }

      await this.audit.log({"""

MARKER = "process.env.SCHEDULE_TEE_DIR"


def main() -> int:
    if not TARGET.exists():
        print(f"not found: {TARGET}")
        print("run this from the repo root")
        return 2

    src = TARGET.read_text()
    bak = TARGET.with_suffix(".ts.bak")

    if "--revert" in sys.argv:
        if not bak.exists():
            print(f"no backup at {bak}")
            return 2
        shutil.copy(bak, TARGET)
        print(f"restored {TARGET} from {bak}")
        return 0

    if MARKER in src:
        print(f"{MARKER} already present — nothing to do")
        return 0

    n = src.count(ANCHOR)
    if n == 0:
        print("anchor not found. Expected this exact block:\n")
        print(ANCHOR)
        print("\nThe file has changed. Paste the surrounding lines and I'll re-anchor.")
        return 1
    if n > 1:
        print(f"anchor appears {n} times — ambiguous, refusing to guess")
        return 1

    shutil.copy(TARGET, bak)
    TARGET.write_text(src.replace(ANCHOR, TEE))

    after = TARGET.read_text()
    if MARKER not in after:
        shutil.copy(bak, TARGET)
        print("verification failed, reverted")
        return 1

    added = len(after.splitlines()) - len(src.splitlines())
    print(f"inserted the tee into {TARGET} (+{added} lines)")
    print(f"backup at {bak}")
    print("\nnext:")
    print("  export SCHEDULE_TEE_DIR=/tmp/hackjudge-tee")
    print("  ./dev.sh build")
    print("  grep -c SCHEDULE_TEE_DIR apps/api/dist/scheduling/scheduling.service.js")
    return 0


if __name__ == "__main__":
    sys.exit(main())
