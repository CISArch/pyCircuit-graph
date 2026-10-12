// Client-side .mlir parsing (TS port of scripts/export_ir.py) so a dropped
// .mlir file can be visualized without a server round-trip.
import type { IRDoc, IRFunction, IRNode, IREdge } from "./ir";

const SSA_DEF0 = /^(%[\w$.#-]+)(?::\d+)?\s*=\s*([\w.]+)\s*(.*)$/;
const SSA_USE = /%([\w$.#-]+)/g;
const FUNC_DECL = /func\.func\s+(@[\w$.-]+)\s*\(/;

// 归类方案（五大类 + output）：
//   input  = 函数参数（arg）
//   const  = constant
//   seq    = reg / delay_line / fifo 等时序存储元件
//   inst   = instance 等子模块实例化（层次结构，独立成类，不计入 comb）
//   comb   = 其余全部组合逻辑（and/or/xor/cmp/mux/extract/...）
//   output = 函数返回（result）
const OP_KIND: Record<string, string> = {
  reg: "seq",
  delay_line: "seq",
  fifo: "seq",
  constant: "const",
  instance: "inst",
};

function opKind(op: string): string {
  const suffix = op.includes(".") ? op.split(".").pop()! : op;
  return OP_KIND[suffix] ?? "comb";
}

function splitTypes(s: string): string[] {
  if (s.includes("->")) {
    const [lhs, rhs] = s.split("->");
    return [...lhs.split(",").map((t) => t.trim()).filter(Boolean), rhs.trim()];
  }
  return s.split(",").map((t) => t.trim()).filter(Boolean);
}

function bodySpan(text: string, start: number): [number, number] {
  const n = text.length;
  let i = start, paren = 0;
  while (i < n) {
    const c = text[i];
    if (c === "(") paren++;
    else if (c === ")") paren--;
    else if (c === "{" && paren <= 0) {
      const before = text.slice(Math.max(0, i - 11), i).trimEnd();
      if (before.endsWith("attributes")) {
        let depth = 1, j = i + 1;
        while (j < n && depth) {
          if (text[j] === "{") depth++;
          else if (text[j] === "}") depth--;
          j++;
        }
        i = j;
        continue;
      }
      break;
    }
    i++;
  }
  const open = i;
  let depth = 1;
  i = open + 1;
  while (i < n && depth) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") depth--;
    i++;
  }
  return [open, i - 1];
}

function parseFunction(text: string, start: number, bodyOpen: number, bodyClose: number): IRFunction | null {
  const header = text.slice(start, bodyOpen);
  const m = FUNC_DECL.exec(header);
  if (!m) return null; // inside a comment / FileCheck directive
  const name = m[1];
  const pOpen = header.indexOf("(", m.index + m[0].length - 1);
  let depth = 1, i = pOpen + 1;
  while (depth && i < header.length) {
    if (header[i] === "(") depth++;
    else if (header[i] === ")") depth--;
    i++;
  }
  const argStr = header.slice(pOpen + 1, i - 1);
  // keep the attributes block: arg_names / result_names live inside it
  const tail = header.slice(i);
  const argTypes = argStr.split(",").map((t) => t.trim()).filter(Boolean);
  const retM = /->\s*\(([^)]*)\)/.exec(tail) ?? /->\s*([^\s{]+)/.exec(tail);
  const retTypes = retM ? splitTypes(retM[1]) : [];

  const arrNames = (key: string): string[] => {
    const am = new RegExp(key + '\\s*=\\s*\\[([^\\]\\\\]*)\\]').exec(tail);
    if (!am) return [];
    try {
      const arr = JSON.parse("[" + am[1].replace(/\\/g, '"') + "]");
      return (arr as unknown[]).map((x) => String(x).replace(/^%/, ""));
    } catch {
      return [];
    }
  };
  const argNames = arrNames("arg_names");
  const resultNames = arrNames("result_names");
  while (argNames.length < argTypes.length) argNames.push("arg" + argNames.length);
  while (resultNames.length < retTypes.length) resultNames.push("result" + resultNames.length);
  const argTypeOnly = argTypes.map((a) => a.split(":").pop()!.trim());

  const nodes: IRNode[] = [];
  const edges: IREdge[] = [];
  const add = (id: string, op: string, kind: string, type: string, attrs?: Record<string, unknown>, src?: string, lineNo?: number, cluster?: string) => {
    const node: IRNode = { id, op, kind, type };
    if (attrs) node.attrs = attrs;
    if (src) node.src = src;
    if (lineNo != null) node.lineNo = lineNo;
    if (cluster) node.cluster = cluster;
    nodes.push(node);
  };

  const body = text.slice(bodyOpen + 1, bodyClose);
  const bodyStartLine = text.slice(0, bodyOpen + 1).split("\n").length;
  const bodyLines = body.split("\n");

  // region-scope-aware resolution: SSA names are scoped to their region;
  // stack holds the owner node id of each open region.
  let scope = "";
  let expectBB = false; // next line may declare ^bb0(params) for the opened region
  const stack: string[] = [];
  const defined = new Map<string, string>(); // scope+"%name" -> node id
  // pyc.comb regions become clusters: comb def id -> { label, ordered yields }
  const combs = new Map<string, { cluster: string; yields: (string | null)[]; inputs: string[]; flushed: boolean }>();
  const resolve = (name: string): string => {
    const hash = name.indexOf("#");
    if (hash >= 0) {
      const baseId = "%" + name.slice(0, hash);
      const idx = parseInt(name.slice(hash + 1), 10) || 0;
      for (const [key, c] of combs) {
        if (key === baseId || key.endsWith("/" + baseId)) {
          const y = c.yields[idx] ?? c.yields.find((x) => x != null);
          if (y != null) return y;
        }
      }
      return baseId;
    }
    for (let i = stack.length; i >= 0; i--) {
      const key = stack.slice(0, i).join("/") + "%" + name;
      const hit = defined.get(key);
      if (hit) return hit;
    }
    const id = "%" + name;
    if (!defined.has(id)) { defined.set(id, id); add(id, "external", "input", "?"); }
    return id;
  };
  const defId = (name: string) => scope + "%" + name;
  const braceCount = (l: string) => (l.match(/{/g) ?? []).length - (l.match(/}/g) ?? []).length;

  const ssaArgNames: (string | null)[] = argTypes.map((a) => {
    const mm = /%([\w$.#-]+)/.exec(a);
    return mm ? mm[1] : null;
  });
  argTypeOnly.forEach((t, k) => {
    const ssa = ssaArgNames[k];
    if (!ssa) return;
    const pretty = argNames[k];
    const key = "%" + ssa;
    add(key, "arg", "input", t, pretty ? { name: pretty } : undefined);
    defined.set(key, key);
  });

  for (let li = 0; li < bodyLines.length; li++) {
    const lineNo = bodyStartLine + li;
    const raw = bodyLines[li];
    const line = raw.split("//")[0].trim();
    if (!line) continue;

    if (expectBB && /^\^/.test(line)) {
      // region block args: ^bb0(%arg3: i8, ...) map positionally to the region
      // owner's operands (comb inputs)
      expectBB = false;
      const owner = stack[stack.length - 1];
      const c = owner ? combs.get(owner) : undefined;
      const inputs = c ? c.inputs : undefined;
      const params = [...line.matchAll(SSA_USE)].map((x) => "%" + x[1]);
      params.forEach((p, k) => {
        if (inputs && k < inputs.length) defined.set(scope + p, inputs[k]);
        else defined.set(scope + p, p);
      });
      continue;
    }
    if (expectBB) expectBB = false;

    if (line === "}") {
      stack.pop();
      scope = stack.join("/");
      continue;
    }

    if (line === "return" || line.startsWith("return ") || line.startsWith("func.return")) {
      // merge all outputs into a single sink node; every return operand
      // points to it
      const uses = [...line.matchAll(SSA_USE)].map((x) => "%" + x[1]);
      const outId = "%out";
      if (!defined.has(outId)) {
        const names = resultNames.slice(0, uses.length);
        const rtypes = splitTypes(uses.map((_, i) => retTypes[i] ?? "?").join(", "));
        add(outId, "result", "output", rtypes.join(", "), names.length ? { names } : undefined, line, lineNo);
        defined.set(outId, outId);
      }
      uses.forEach((u, k) => {
        edges.push({ source: resolve(u.slice(1)), target: outId, label: "ret" + k });
      });
      continue;
    }    if (line.startsWith("pyc.assign ")) {
      const ops = [...line.slice("pyc.assign ".length).split(" :")[0].matchAll(SSA_USE)].map((x) => "%" + x[1]);
      const resolved = ops.map((u) => resolve(u.slice(1)));
      for (let i = 1; i < resolved.length; i++) {
        edges.push({ source: resolved[i], target: resolved[i - 1], label: "assign" });
      }
      for (const u of ops) defined.set(scope + u, resolved[resolved.length - 1]);
      continue;
    }

    if (line.startsWith("pyc.yield")) {
      const owner = stack[stack.length - 1];
      const c = owner ? combs.get(owner) : undefined;
      if (c) {
        for (const mm of line.matchAll(SSA_USE)) {
          c.yields.push(resolve(mm[1]));
        }
      }
      continue;
    }

    SSA_DEF0.lastIndex = 0;
    const dm = SSA_DEF0.exec(line);
    if (!dm) continue;
    const [, dstNameRaw, op, rest] = dm;
    const dstName = dstNameRaw.replace(/^%+/, "");
    const [operandsPart, tailPart] = rest.split(" : ", 2) as [string, string?];
    const operands = [...operandsPart.matchAll(SSA_USE)].map((x) => "%" + x[1]);
    const tp = tailPart ?? "";
    const outType = tp.includes("->") ? tp.split("->").pop()!.trim() : tp.trim() || "?";
    const id = defId(dstName);
    const isComb = op === "pyc.comb" || op.endsWith(".comb");
    const parent = stack[stack.length - 1];
    const parentComb = parent ? combs.get(parent) : undefined;
    const attrs = op.endsWith("constant") ? { value: operandsPart.trim() } : undefined;
    if (isComb) {
      // comb 区域不再实例化为节点：其输入经由 ^bb0 块参数直接映射到
      // 区域内首次使用处，数据边自然成立；仅注册 cluster 供分组着色
      combs.set(id, { cluster: "comb " + dstName, yields: [], inputs: operands.map((u) => resolve(u.slice(1))), flushed: false });
      defined.set(defId(dstName), id);
    } else {
      add(id, op, opKind(op), outType, attrs, line, lineNo, parentComb?.cluster);
      defined.set(defId(dstName), id);
      operands.forEach((u, k) => {
        if (u !== id) edges.push({ source: resolve(u.slice(1)), target: id, label: "op" + k });
      });
    }
    if (braceCount(line) > 0) {
      stack.push(id);
      scope = stack.join("/");
      expectBB = true;
    }
  }
  return { name, args: argNames.map((n, k) => ({ name: n, type: argTypeOnly[k] ?? "?" })),
           results: resultNames.map((n, k) => ({ name: n, type: retTypes[k] ?? "?" })),
           attrs: {}, nodes, edges };
}

export function parseMlirText(text: string): IRDoc {
  const functions: IRFunction[] = [];
  for (const m of text.matchAll(/func\.func/g)) {
    const [open, close] = bodySpan(text, m.index + "func.func".length);
    const fn = parseFunction(text, m.index, open, close);
    if (fn) functions.push(fn);
  }
  return { module: {}, files: {}, functions };
}
