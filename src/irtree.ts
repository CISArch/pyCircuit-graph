// Parse PassIRDumper-style file names and organize them into an execution tree.
//
// Name format:
//   NNNN_<phase>_<NN>_<pass>__L<level>[__via_<seq>.<name>.<seq>.<name>...][_FAILED].mlir
// The via chain lists nested pass instances traversed, outermost first.
//
// Tree semantics: a pass instance node owns its before/after dumps directly, and
// its nested child instances are ordered between the before and after dumps
// (matching actual execution order: run body -> children -> rest of body).

export interface ParsedDump {
  tag: string;          // full relative path (used as key / fetch target)
  file: string;         // basename
  seq: number;          // NNNN, lexical = execution order
  phase: "before" | "after";
  inner: number;        // <NN> pass instance index
  pass: string;         // own pass short name
  level: number;
  failed: boolean;
  chain: { seq: number; name: string }[]; // via ancestors, outermost first
}

export interface TreeNode {
  key: string;          // stable chain key
  label: string;
  children: TreeNode[]; // nested pass instances
  dumps: ParsedDump[];  // this instance's own before/after dumps
  firstSeq: number;
  /** Wrapper instances (e.g. OpToOpPassAdaptor) produce no dump files of
   *  their own; their boundaries equal the first/last descendant dump. */
  derivedBefore?: ParsedDump;
  derivedAfter?: ParsedDump;
}

const DUMP_RE =
  /^(\d+)_(before|after)_(\d+)_(.+?)__L(\d+)(?:__via_(.+?))?(_FAILED)?\.mlir$/;

export function parseDumpName(rel: string): ParsedDump | null {
  const file = rel.split("/").pop() ?? rel;
  const m = DUMP_RE.exec(file);
  if (!m) return null;
  const chain: { seq: number; name: string }[] = [];
  const via = m[6];
  if (via) {
    const tokens = via.split(".");
    // chain is "<name>.<seq>.<name>.<seq>..." (outermost first)
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      const seq = parseInt(tokens[i + 1], 10);
      if (!Number.isNaN(seq)) chain.push({ seq, name: tokens[i] });
    }
  }
  return {
    tag: rel,
    file,
    seq: parseInt(m[1], 10),
    phase: m[2] as "before" | "after",
    inner: parseInt(m[3], 10),
    pass: m[4],
    level: parseInt(m[5], 10),
    failed: !!m[7],
    chain,
  };
}

export function buildTree(dumps: ParsedDump[]): TreeNode {
  const root: TreeNode = { key: "__root__", label: "pass_ir", children: [], dumps: [], firstSeq: Number.MAX_SAFE_INTEGER };
  for (const d of [...dumps].sort((a, b) => a.seq - b.seq)) {
    let node = root;
    node.firstSeq = Math.min(node.firstSeq, d.seq);
    // adaptor wrappers are pure dispatch layers (no own IR effect): skip them
    // so real passes surface directly. Children keep file (execution) order.
    const chain = d.chain.filter((c) => !c.name.includes("OpToOpPassAdaptor"));
    const parts = [
      ...chain.map((c) => ({ key: c.seq + " " + c.name, label: c.seq + " · " + c.name })),
      { key: d.inner + " " + d.pass, label: d.inner + " · " + d.pass },
    ];
    for (const part of parts) {
      const want = node.key + "/" + part.key;
      let child = node.children.find((c) => c.key === want);
      if (!child) {
        child = { key: want, label: part.label, children: [], dumps: [], firstSeq: d.seq };
        node.children.push(child);
      }
      child.firstSeq = Math.min(child.firstSeq, d.seq);
      node = child;
    }
    node.dumps.push(d);
  }
  const sortRec = (n: TreeNode): { min: ParsedDump; max: ParsedDump } | null => {
    n.children.sort((a, b) => a.firstSeq - b.firstSeq);
    n.dumps.sort((a, b) => a.seq - b.seq);
    let min = n.dumps[0];
    let max = n.dumps[n.dumps.length - 1];
    for (const c of n.children) {
      const e = sortRec(c);
      if (e) {
        if (!min || e.min.seq < min.seq) min = e.min;
        if (!max || e.max.seq > max.seq) max = e.max;
      }
    }
    if (!n.dumps.length && min && max) {
      // wrapper instance: borrow first/last descendant dumps as its boundaries
      n.derivedBefore = min;
      n.derivedAfter = max;
    }
    return min && max ? { min, max } : null;
  };
  sortRec(root);
  return root;
}

export function countLeaves(n: TreeNode): number {
  return n.dumps.length + n.children.reduce((s, c) => s + countLeaves(c), 0);
}

/** Default-expanded keys: only the first level (root's children); deeper nodes start collapsed. */
export function defaultExpanded(root: TreeNode): Set<string> {
  const expanded = new Set<string>();
  for (const c of root.children) expanded.add(c.key);
  return expanded;
}
