#!/usr/bin/env python3
"""Run pyc-opt passes one-by-one and dump IR after each step, using the same
file naming scheme as pyc's PassIRDumper (NNNN_<phase>_<NN>_<pass>__L<level>.mlir)
so export_ir.py and the web UI treat it like a native pass-IR dump.

Note: pyc-opt's own --dump-pass-ir currently suppresses --pass-pipeline on
MLIR 19 (the setup callback replaces the textual pipeline), so we drive the
passes incrementally instead.

Usage:
  python scripts/run_passes.py input.mlir -p pyc-state-optimize,pyc-eliminate-wires -o pass_ir
  python scripts/run_passes.py input.mlir --list-passes   # pyc-opt --help pass list
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

DEFAULT_PYC_OPT = str(Path.home() / "pyCircuit/.pycircuit_out/toolchain/install/bin/pyc-opt")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("input", type=Path, help="input .mlir file")
    ap.add_argument("-p", "--passes", default="", help="comma-separated pass names (pyc-xxx)")
    ap.add_argument("-o", "--output", type=Path, default=Path("pass_ir"))
    ap.add_argument("--pyc-opt", default=DEFAULT_PYC_OPT, help="path to pyc-opt binary")
    args = ap.parse_args()

    passes = [p.strip() for p in args.passes.split(",") if p.strip()]
    args.output.mkdir(parents=True, exist_ok=True)

    def run(seq: int, phase: str, pass_idx: int, name: str, src: Path) -> Path:
        dst = args.output / f"{seq:04d}_{phase}_{pass_idx:02d}_{name}__L0.mlir"
        dst.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
        return dst

    text = args.input.read_text(encoding="utf-8")
    run(0, "before", 0, "input", args.input)

    cur = args.input
    tmp_dir = Path("/tmp") / ("pycircuit-graph-passes-" + str(abs(hash(str(args.input)))) )
    tmp_dir.mkdir(exist_ok=True)

    def run_one(mlir_in: Path, mlir_out: Path, p: str) -> bool:
        """Run a single pass; func-level passes get nested under func.func."""
        for pipeline in (f"builtin.module({p})",
                         f"builtin.module(func.func({p}))"):
            proc = subprocess.run(
                [args.pyc_opt, str(mlir_in), f"--pass-pipeline={pipeline}",
                 "-o", str(mlir_out)],
                capture_output=True, text=True,
            )
            if proc.returncode == 0:
                return True
        print(proc.stderr, file=sys.stderr)
        return False

    for i, p in enumerate(passes):
        nxt = tmp_dir / f"step{i}.mlir"
        if not run_one(cur, nxt, p):
            print(f"pass {p} failed (step {i})", file=sys.stderr)
            return 1
        run(2 * i + 1, "after", i, p.removeprefix("pyc-"), nxt)
        if i + 1 < len(passes):
            before = tmp_dir / f"step{i}_before{i + 1}.mlir"
            before.write_text(nxt.read_text(encoding="utf-8"), encoding="utf-8")
            run(2 * i + 2, "before", i + 1, passes[i + 1].removeprefix("pyc-"), before)
        cur = nxt

    print(f"{len(passes) + 1} dump file(s) -> {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
