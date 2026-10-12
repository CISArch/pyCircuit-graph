#!/usr/bin/env python3
"""Export pyc-dialect MLIR (pyCircuit IR) to a JSON graph for reagraph visualization.

Usage:
  python scripts/export_ir.py FILE.mlir [-o graph.json]
  python scripts/export_ir.py DIR [-o graph.json]   # scans *.mlir recursively
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

SSA_DEF = re.compile(r"(%[\w$.#-]+)(?::\d+)?\s*=\s*([\w.]+)\s*(.*)")
SSA_USE = re.compile(r"%([\w$.#-]+)")
FUNC_DECL = re.compile(r"func\.func\s+(@[\w$.-]+)\s*\(")
# PassIRDumper file name: NNNN_<before|after>_<NN>_<pass-short>__L<level>[_FAILED].mlir
PASS_DUMP = re.compile(r"^(\d+)_(before|after)_(\d+)_(.+?)__L(\d+)(_FAILED)?\.mlir$")

# 归类方案（与前端 wasmParse.ts 一致）：input/const/seq/comb/output
#   seq    = reg / delay_line / fifo 等时序存储元件
#   comb   = 其余全部组合逻辑（and/or/xor/cmp/mux/extract/...）
OP_KIND = {
    "reg": "seq", "delay_line": "seq", "fifo": "seq",
    "constant": "const",
}


def split_types(type_str: str) -> list[str]:
    if "->" in type_str:
        lhs, rhs = type_str.split("->", 1)
        return [t.strip() for t in lhs.split(",") if t.strip()] + [rhs.strip()]
    return [t.strip() for t in type_str.split(",") if t.strip()]


def parse_attrs(text: str) -> dict:
    attrs: dict = {}
    # JSON-array values, e.g. arg_names = ["clk", "rst"]
    for m in re.finditer(r"(\b\w[\w.]*)\s*=\s*\[((?:[^\[\]\\]|\\.)*)\]", text):
        raw = "[" + m.group(2).replace('\\', '"') + "]"
        try:
            attrs[m.group(1)] = json.loads(raw)
        except json.JSONDecodeError:
            attrs[m.group(1)] = raw
    # quoted string values
    for m in re.finditer(r'(\b\w[\w.]*)\s*=\s*"((?:[^"\\]|\\.)*)"', text):
        attrs[m.group(1)] = m.group(2).replace('\\"', '"').replace("\\\\", "\\")
    # unquoted scalar values
    for m in re.finditer(r"(\b\w[\w.]*)\s*=\s*([^\s,{}\[\]\\\"']+)", text):
        if m.group(1) not in attrs:
            attrs[m.group(1)] = m.group(2)
    return attrs


def op_kind(op: str) -> str:
    suffix = op.split(".", 1)[-1] if "." in op else op
    return OP_KIND.get(suffix, "comb")


def func_body_span(text: str, start: int) -> tuple[int, int]:
    """Return (open, close) offsets of the function body braces, skipping the
    parenthesized signature and any attributes {...} inside it."""
    n = len(text)
    i, paren = start, 0
    while i < n:
        c = text[i]
        if c == "(":
            paren += 1
        elif c == ")":
            paren -= 1
        elif c == "{" and paren <= 0:
            # attributes {...} block before the body: skip it
            rest = text[i:i + 12]
            if rest.startswith("{attributes") or text[max(0, i - 11):i].rstrip().endswith("attributes"):
                depth, j = 1, i + 1
                while j < n and depth:
                    if text[j] == "{":
                        depth += 1
                    elif text[j] == "}":
                        depth -= 1
                    j += 1
                i = j
                continue
            break
        i += 1
    open_b = i
    depth, i = 1, open_b + 1
    while i < n and depth:
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
        i += 1
    return open_b, i - 1


def func_signature_tail(text: str, start: int, body_open: int) -> tuple[str, str, str]:
    """Split 'func.func @name(args) attrs...' -> (name, arg_str, tail)."""
    m = FUNC_DECL.search(text, start, body_open)
    if not m:  # occurrence inside a comment / FileCheck directive
        return None
    name = m.group(1)
    p_open = text.index("(", m.end() - 1)
    depth, i = 1, p_open + 1
    while depth:
        if text[i] == "(":
            depth += 1
        elif text[i] == ")":
            depth -= 1
        i += 1
    return name, text[p_open + 1:i - 1], text[i:body_open]


def parse_function(text: str, start: int, body_open: int, body_close: int) -> dict | None:
    sig = func_signature_tail(text, start, body_open)
    if sig is None:
        return None
    name, arg_str, sig_tail = sig
    arg_types = [t.strip() for t in arg_str.split(",") if t.strip()]
    ret_m = re.search(r"->\s*\(([^)]*)\)", sig_tail) or re.search(r"->\s*([^\s{]+)", sig_tail)
    ret_types = split_types(ret_m.group(1)) if ret_m else []

    attrs = parse_attrs(sig_tail)
    arg_names = [str(x).lstrip("%") for x in attrs.get("arg_names", [])] if isinstance(attrs.get("arg_names"), list) else []
    result_names = [str(x).lstrip("%") for x in attrs.get("result_names", [])] if isinstance(attrs.get("result_names"), list) else []
    while len(arg_names) < len(arg_types):
        arg_names.append(f"arg{len(arg_names)}")
    while len(result_names) < len(ret_types):
        result_names.append(f"result{len(result_names)}")
    arg_type_only = [a.split(":")[-1].strip() for a in arg_types]

    nodes, edges = [], []
    defined: dict[str, str] = {}

    def add_node(nid, op, kind, ntype, extra=None, src=None, line_no=None, cluster=None):
        node = {"id": nid, "op": op, "kind": kind, "type": ntype}
        if extra:
            node["attrs"] = extra
        if src:
            node["src"] = src
        if line_no is not None:
            node["lineNo"] = line_no
        if cluster:
            node["cluster"] = cluster
        nodes.append(node)

    def ensure_node(nid):
        nid = nid.split("#", 1)[0]
        if nid not in defined:
            defined[nid] = nid
            add_node(nid, "external", "input", "?")
        return defined[nid]

    # boundary node id must be the actual SSA name used in the body (%argN);
    # the pretty arg_names entry goes into attrs for display.
    ssa_arg_names = []
    for a in arg_types:
        mm = SSA_USE.search(a)
        ssa_arg_names.append(mm.group(1) if mm else None)
    for k, t in enumerate(arg_type_only):
        pretty = arg_names[k] if k < len(arg_names) else None
        ssa = ssa_arg_names[k]
        if ssa:
            add_node("%" + ssa, "arg", "input", t, extra={"name": pretty} if pretty else None)
            defined["%" + ssa] = "%" + ssa

    body = text[body_open + 1:body_close]
    body_start_line = text.count("\n", 0, body_open + 1) + 1

    # region-scope-aware resolution
    scope = ""
    expect_bb = False  # next line may declare ^bb0(params) for the opened region
    stack = []  # owner node ids of open regions
    def def_key(scope_, name):
        return scope_ + "%" + name
    combs = {}  # def_key comb id -> {"cluster": str, "yields": [inner ids]}
    def resolve(name):
        if "#" in name:
            base, idx_s = name.split("#", 1)
            base = "%" + base.lstrip("%")
            idx = int(idx_s) if idx_s.isdigit() else 0
            for key, c in combs.items():
                if key == base or key.endswith("/" + base):
                    ys = c["yields"]
                    y = ys[idx] if idx < len(ys) and ys[idx] else next((x for x in ys if x), None)
                    if y:
                        return y
            return base
        for i in range(len(stack), -1, -1):
            key = "/".join(stack[:i]) + "%" + name
            if key in defined:
                return defined[key]
        nid = "%" + name
        if nid not in defined:
            defined[nid] = nid
            add_node(nid, "external", "input", "?")
        return nid

    for li, raw in enumerate(body.splitlines()):
        line_no = body_start_line + li
        line = raw.split("//", 1)[0].strip()
        if not line:
            continue
        if expect_bb and line.startswith("^"):
            expect_bb = False
            owner = stack[-1] if stack else None
            c = combs.get(owner) if owner else None
            inputs = c["inputs"] if c else None
            params = SSA_USE.findall(line)
            for k, p in enumerate(params):
                if inputs and k < len(inputs):
                    defined[def_key(scope, p)] = inputs[k]
                else:
                    defined[def_key(scope, p)] = "%" + p.lstrip("%")
            continue
        if expect_bb:
            expect_bb = False

        if line == "}":
            if stack:
                stack.pop()
                scope = "/".join(stack)
            continue

        if line == "return" or line.startswith("return ") or line.startswith("func.return"):
            # merge all outputs into a single sink node; every return operand
            # points to it
            nid = "%out"
            if nid not in defined:
                names = [result_names[k] for k in range(len(SSA_USE.findall(line))) if k < len(result_names)]
                rtypes = split_types(" ".join(SSA_USE.findall(line)))
                add_node(nid, "result", "output",
                         ", ".join(ret_types) if ret_types else "?",
                         extra={"names": names} if names else None,
                         src=line, line_no=line_no)
                defined[nid] = nid
            for k, used in enumerate(SSA_USE.findall(line)):
                edges.append({"source": resolve(used), "target": nid, "label": f"ret{k}"})
            continue

        if line.startswith("pyc.assign "):
            ops = SSA_USE.findall(line[len("pyc.assign "):].split(" : ")[0])
            resolved = [resolve(u) for u in ops]
            for i in range(1, len(resolved)):
                edges.append({"source": resolved[i], "target": resolved[i - 1],
                              "label": "assign"})
            for u in ops:
                defined[def_key(scope, u)] = resolved[-1]
            continue

        if line.startswith("pyc.yield"):
            if stack:
                owner = stack[-1]
                c = combs.get(owner)
                if c:
                    for used in SSA_USE.findall(line):
                        c["yields"].append(resolve(used))
            continue

        dm = SSA_DEF.match(line)
        if not dm:
            continue
        dst, op, rest = dm.group(1), dm.group(2), dm.group(3)
        core = rest.split(" : ", 1)
        operands = SSA_USE.findall(core[0])
        tail = core[1] if len(core) > 1 else ""
        out_type = tail.split("->")[-1].strip() if "->" in tail else (tail.strip() or "?")
        if op.endswith("assign") and operands:
            src_node = resolve(operands[0])
            edges.append({"source": src_node, "target": dst, "label": "assign"})
            defined[def_key(scope, dst.lstrip("%"))] = src_node
            continue
        extra = {"value": core[0].strip()} if op.endswith("constant") else None
        nid = def_key(scope, dst.lstrip("%"))
        is_comb = op == "pyc.comb" or op.endswith(".comb")
        parent = stack[-1] if stack else None
        parent_comb = combs.get(parent) if parent else None
        cluster = parent_comb["cluster"] if parent_comb else None
        if is_comb:
            # comb 区域不再实例化为节点：其输入经由 ^bb0 块参数直接映射到
            # 区域内首次使用处，数据边自然成立；仅注册 cluster 供分组着色
            defined[def_key(scope, dst.lstrip("%"))] = nid
            combs[nid] = {"cluster": "comb " + dst.lstrip("%"), "yields": [],
                          "inputs": [resolve(u) for u in operands], "flushed": False}
        else:
            add_node(nid, op, op_kind(op), out_type, extra, src=line, line_no=line_no, cluster=cluster)
            defined[def_key(scope, dst.lstrip("%"))] = nid
        if not is_comb:
            for i2, used in enumerate(operands):
                src_node = resolve(used)
                if src_node != nid:
                    edges.append({"source": src_node, "target": nid, "label": f"op{i2}"})
        if line.count("{") - line.count("}") > 0:
            stack.append(nid)
            scope = "/".join(stack)
            expect_bb = True

    return {"name": name,
            "args": [{"name": n, "type": t} for n, t in zip(arg_names, arg_type_only)],
            "results": [{"name": n, "type": t} for n, t in zip(result_names, ret_types)],
            "attrs": attrs, "nodes": nodes, "edges": edges}


def parse_mlir(text: str) -> dict:
    module_attrs = {}
    mod_m = re.search(r"module\s+attributes\s*(\{.*?\})\s*\{", text, re.S)
    if mod_m:
        module_attrs = parse_attrs(mod_m.group(1))

    functions = []
    for m in re.finditer(r"func\.func", text):
        open_b, close_b = func_body_span(text, m.end())
        fn = parse_function(text, m.start(), open_b, close_b)
        if fn:
            functions.append(fn)
    return {"module": module_attrs, "functions": functions}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("input", type=Path, help=".mlir file or directory")
    ap.add_argument("-o", "--output", type=Path, default=Path("graph.json"))
    args = ap.parse_args()

    files = sorted(f for f in args.input.rglob("*.mlir")
                   if not any(part.startswith(".") for part in f.relative_to(args.input).parts)) \
        if args.input.is_dir() else [args.input]
    if not files:
        print(f"no .mlir files found under {args.input}", file=sys.stderr)
        return 1

    doc: dict = {"module": {}, "files": {}, "functions": [], "passes": []}
    passes: dict[str, dict] = {}
    for f in files:
        pm = PASS_DUMP.match(f.name)
        origin = None
        if pm:
            seq, phase, inner, pass_name, level, failed = pm.groups()
            origin = f.name[: -len(".mlir")]
            passes[origin] = {
                "tag": origin,
                "seq": int(seq),
                "phase": phase,
                "inner": int(inner),
                "pass": pass_name,
                "level": int(level),
                "failed": bool(failed),
            }
        parsed = parse_mlir(f.read_text(encoding="utf-8"))
        doc["files"][str(f)] = [fn["name"] for fn in parsed["functions"]]
        for fn in parsed["functions"]:
            if origin:
                fn["origin"] = origin
            doc["functions"].append(fn)
        if parsed["module"] and not doc["module"]:
            doc["module"] = parsed["module"]

    doc["passes"] = sorted(passes.values(), key=lambda p: p["tag"])

    args.output.write_text(json.dumps(doc, indent=1, ensure_ascii=False), encoding="utf-8")
    tn = sum(len(fn["nodes"]) for fn in doc["functions"])
    te = sum(len(fn["edges"]) for fn in doc["functions"])
    ps = f", {len(doc['passes'])} pass dump(s)" if doc["passes"] else ""
    print(f"{len(files)} file(s), {len(doc['functions'])} function(s), {tn} nodes, {te} edges{ps} -> {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
