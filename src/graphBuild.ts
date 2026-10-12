// 图数据构建：IRFunction -> G6 节点/边
// 含：类别过滤、搜索、diff 高亮、消环拆分、comb 域折叠聚合
import { KIND_COLORS, normalizeKind, type IREdge, type IRFunction, type IRNode } from "./ir";
import type { G6Node, G6Edge } from "./G6Canvas";

export const RESULT_FILL = "#ffc107";
export const RESULT_SIZE = 6.5;
export const ADDED_FILL = "#ffd54f";
export const ADDED_EDGE_FILL = "#81c784";
export const REMOVED_EDGE_FILL = "#e57373";
export const ADDED_SIZE = 7;
export const DEFAULT_SIZE = 5;
export const GHOST_FILL = "#455a64";
export const COMB_FILL = "#1e88e5";
export const COMB_SIZE = 8;
/** 折叠 comb 大节点的 id 前缀（cluster id 本身以 "comb " 开头） */
export const COMB_NODE_PREFIX = "◤comb:";

export const edgeSig = (e: { source: string; target: string }) => e.source + ">" + e.target;

export interface PairDiff {
  added: Set<string>;
  removed: Set<string>;
  addedEdgeSigs: Set<string>;
  removedEdges: { source: string; target: string }[];
}

// 消环拆分后缀：入边挂 D（数据端），出边挂 Q（寄存后的值）
const SUFFIX_IN = "·D";
const SUFFIX_OUT = "·Q";

/** 节点两行标签：第一行变量名（arg 名 / 常量值 / diff 前缀），第二行 op 属性 */
function nodeLabel(n: IRNode, isNew: boolean): string {
  if (n.op === "result") return "▶ OUT";
  const head =
    (isNew ? "+ " : "") +
    (n.op === "arg" && n.attrs?.name ? n.attrs.name + " " : "") +
    n.id +
    (n.op === "pyc.constant" ? " = " + (n.attrs?.value ?? "") : "");
  const tail = n.op === "arg" ? "arg" : n.op === "result" ? "" : n.op.replace(/^pyc\./, "");
  return tail ? head + "\n" + tail : head;
}

function toVNode(n: IRNode, isNew: boolean): G6Node {
  const isResult = n.op === "result";
  return {
    id: n.id,
    cluster: n.cluster,
    label: nodeLabel(n, isNew),
    fill: isResult ? RESULT_FILL : isNew ? ADDED_FILL : KIND_COLORS[normalizeKind(n.kind)] ?? KIND_COLORS.comb,
    size: isResult ? RESULT_SIZE : isNew ? ADDED_SIZE : DEFAULT_SIZE,
    data: n,
  };
}

/** 去重建边：只保留两端都在图中的边，diff 新增边着色（sigFn 把边映射为 diff 用的原始签名） */
function buildEdges(
  rawEdges: { source: string; target: string; label: string }[],
  ids: Set<string>,
  addedEdgeSigs?: Set<string>,
  sigFn: (e: { source: string; target: string }) => string = edgeSig,
): G6Edge[] {
  const edges: G6Edge[] = [];
  const seen = new Set<string>();
  for (const e of rawEdges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    const sig = sigFn(e);
    if (seen.has(sig)) continue;
    seen.add(sig);
    edges.push({
      id: "e" + edges.length,
      source: e.source,
      target: e.target,
      label: e.label,
      fill: addedEdgeSigs?.has(sig) ? ADDED_EDGE_FILL : undefined,
    });
  }
  return edges;
}

/** 是否为折叠 comb 大节点 */
export function isCombNode(id: string): boolean {
  return id.startsWith(COMB_NODE_PREFIX);
}

/**
 * comb 域折叠：把 cluster 内的节点收成一个聚合大节点。
 * 边重定向：cluster 内部边丢弃；跨域边把 comb 侧端点替换为聚合节点。
 * expandedClusters 里列出的 cluster 保持展开（不折叠）。
 */
function collapseCombs(
  nodes: G6Node[],
  rawEdges: { source: string; target: string; label: string }[],
  expandedClusters: Set<string>,
  clusterSeq: Map<string, number>,
  kindFilter: Set<string>,
): {
  nodes: G6Node[];
  edges: { source: string; target: string; label: string }[];
  proxyOf: Map<string, string>;
} {
  // combbox 类别被过滤掉时：折叠域成员不生成聚合节点，直接不显示
  if (!kindFilter.has("combbox")) {
    const dropped = new Set(nodes.filter((n) => n.cluster && !expandedClusters.has(n.cluster)).map((n) => n.id));
    if (dropped.size) {
      return {
        nodes: nodes.filter((n) => !dropped.has(n.id)),
        edges: rawEdges.filter((e) => !dropped.has(e.source) && !dropped.has(e.target)),
        proxyOf: new Map(),
      };
    }
    return { nodes, edges: rawEdges, proxyOf: new Map() };
  }
  // 待折叠的 cluster -> 成员 id 集合
  const members = new Map<string, Set<string>>();
  for (const n of nodes) {
    if (!n.cluster || expandedClusters.has(n.cluster)) continue;
    let set = members.get(n.cluster);
    if (!set) members.set(n.cluster, (set = new Set()));
    set.add(n.id);
  }
  if (!members.size) return { nodes, edges: rawEdges, proxyOf: new Map() };

  const proxyOf = new Map<string, string>(); // 成员 id -> 聚合节点 id
  const proxyNodes: G6Node[] = [];
  let next = 0;
  for (const [cluster, set] of members) {
    // 序号按 cluster 在本函数中首次出现的顺序
    let seq = clusterSeq.get(cluster);
    if (seq == null) clusterSeq.set(cluster, (seq = clusterSeq.size + 1));
    const id = COMB_NODE_PREFIX + seq + " " + cluster;
    for (const m of set) proxyOf.set(m, id);
    proxyNodes.push({
      id,
      label: `comb #${seq}\n(${set.size} 节点)`,
      fill: KIND_COLORS.combbox,
      size: COMB_SIZE,
      // 折叠聚合节点独立成 combbox 类别（与展开的 comb 节点区分），可单独过滤
      data: { id: cluster, op: "pyc.comb", kind: "combbox", type: "?" },
    });
    next++;
  }
  void next;

  const outNodes = [...proxyNodes, ...nodes.filter((n) => !proxyOf.has(n.id))];
  // 边重定向 + 去自身环
  const outEdges: { source: string; target: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const e of rawEdges) {
    const s = proxyOf.get(e.source) ?? e.source;
    const t = proxyOf.get(e.target) ?? e.target;
    if (s === t) continue; // 域内部边
    const sig = s + ">" + t;
    if (seen.has(sig)) continue;
    seen.add(sig);
    outEdges.push({ source: s, target: t, label: e.label });
  }
  return { nodes: outNodes, edges: outEdges, proxyOf };
}

/** 是否为 wire 节点 */
export function isWireOp(op: string): boolean {
  return op === "wire" || op === "pyc.wire" || op.endsWith(".wire");
}

/**
 * wire 旁路：有入边的 wire 节点，其全部出边改由它的驱动节点发出，wire 节点删除。
 * - 无入边的 wire（外部输入）保留；
 * - 多驱动或成环的 wire 不旁路（语义有歧义）；
 * - wire 链（wire→wire→驱动）一路传递解析到最终驱动。
 * redirect：被删 wire id -> 最终驱动 id（供原文行悬停定位）。
 */
export function bypassWires(fn: IRFunction): {
  nodes: IRNode[];
  edges: IREdge[];
  redirect: Map<string, string>;
} {
  const wireIds = new Set(fn.nodes.filter((n) => isWireOp(n.op)).map((n) => n.id));
  const redirect = new Map<string, string>();
  if (!wireIds.size) return { nodes: fn.nodes, edges: fn.edges, redirect };

  // wire -> 唯一驱动（可能仍是 wire）；出现多个不同驱动则标记为不可旁路
  const driverOf = new Map<string, string>();
  const multi = new Set<string>();
  for (const e of fn.edges) {
    if (!wireIds.has(e.target) || e.source === e.target) continue;
    const cur = driverOf.get(e.target);
    if (cur == null) driverOf.set(e.target, e.source);
    else if (cur !== e.source) multi.add(e.target);
  }

  const resolveDriver = (id: string): string | null => {
    const seen = new Set<string>();
    let cur = id;
    while (wireIds.has(cur)) {
      if (seen.has(cur) || multi.has(cur)) return null; // 环 / 多驱动
      seen.add(cur);
      const next = driverOf.get(cur);
      if (next == null) return null; // 无入边：保留
      cur = next;
    }
    return cur;
  };

  const bypassable = new Set<string>();
  for (const w of wireIds) {
    const d = resolveDriver(w);
    if (d != null) {
      bypassable.add(w);
      redirect.set(w, d);
    }
  }
  if (!bypassable.size) return { nodes: fn.nodes, edges: fn.edges, redirect };

  const resolve = (id: string): string => (bypassable.has(id) ? resolveDriver(id) ?? id : id);

  const edges: IREdge[] = [];
  for (const e of fn.edges) {
    // 指向被旁路 wire 的边（wire 的入边、wire→wire）随节点一起消失
    if (bypassable.has(e.target)) continue;
    const source = resolve(e.source);
    if (source === e.target) continue;
    edges.push({ ...e, source });
  }
  return { nodes: fn.nodes.filter((n) => !bypassable.has(n.id)), edges, redirect };
}

export function functionToGraph(
  fn: IRFunction,
  kindFilter: Set<string>,
  search: string,
  splitRegs: boolean,
  collapseRegs: boolean,
  expandedClusters: Set<string>,
  clusterSeq: Map<string, number>,
  diff?: PairDiff | null,
): { nodes: G6Node[]; edges: G6Edge[]; visibleIdOf: Map<string, string> } {
  const q = search.trim().toLowerCase();
  // wire 旁路：删除有入边的 wire 节点，其出边改由驱动节点发出
  const bypassed = bypassWires(fn);
  let nodes: G6Node[] = bypassed.nodes
    .filter((n) => kindFilter.has(normalizeKind(n.kind)))
    .filter((n) => !q || n.id.toLowerCase().includes(q) || n.op.toLowerCase().includes(q))
    .map((n) => toVNode(n, !!diff?.added.has(n.id)));
  let rawEdges: { source: string; target: string; label: string }[] = bypassed.edges;
  // 原始节点 id -> 当前图上实际可见的节点 id（折叠 -> comb 聚合节点；消环 -> ·Q 输出端）
  const visibleIdOf = new Map<string, string>();
  for (const n of nodes) visibleIdOf.set(n.id, n.id);
  // 被删的 wire：原文行悬停高亮改为它的驱动节点
  for (const [wire, driver] of bypassed.redirect) visibleIdOf.set(wire, driver);

  // ---- comb 域折叠（在拆分/建边之前做，减少图的规模）----
  if (collapseRegs) {
    const collapsed = collapseCombs(nodes, rawEdges, expandedClusters, clusterSeq, kindFilter);
    nodes = collapsed.nodes;
    rawEdges = collapsed.edges;
    for (const [member, proxy] of collapsed.proxyOf) visibleIdOf.set(member, proxy);
  }

  // ---- 消环模式：seq 时序节点拆成 输入(D)/输出(Q) 两个节点，打断反馈环成 DAG ----
  if (splitRegs) {
    const inDeg = new Map<string, number>();
    const outDeg = new Map<string, number>();
    for (const e of rawEdges) {
      outDeg.set(e.source, (outDeg.get(e.source) ?? 0) + 1);
      inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1);
    }
    // 只拆既有入边又有出边的 seq 节点（纯源/纯汇无需拆）
    const splitIds = new Set(
      nodes
        .filter((n) => n.data.kind === "seq" && (inDeg.get(n.id) ?? 0) > 0 && (outDeg.get(n.id) ?? 0) > 0)
        .map((n) => n.id),
    );
    if (splitIds.size) {
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (!splitIds.has(nodes[i].id)) continue;
        const base = nodes[i].label.split("\n")[0];
        const d: G6Node = { ...nodes[i], id: nodes[i].id + SUFFIX_IN, label: base + "\n·in", size: DEFAULT_SIZE };
        const qq: G6Node = { ...nodes[i], id: nodes[i].id + SUFFIX_OUT, label: base + "\n·out", size: DEFAULT_SIZE };
        nodes.splice(i, 1, d, qq);
      }
      // 重定向边：入边改指 D，出边改从 Q 发出；diff 签名还原成原始 id 匹配
      const redirected = rawEdges.map((e) => ({
        source: splitIds.has(e.source) ? e.source + SUFFIX_OUT : e.source,
        target: splitIds.has(e.target) ? e.target + SUFFIX_IN : e.target,
        label: e.label,
      }));
      const ids = new Set(nodes.map((n) => n.id));
      const strip = (s: string) => s.replace(SUFFIX_IN, "").replace(SUFFIX_OUT, "");
      const edges = buildEdges(
        redirected,
        ids,
        diff?.addedEdgeSigs,
        (e) => strip(e.source) + ">" + strip(e.target),
      );
      // 消环拆分后原始 id 不在图上：悬停等指向 Q 输出端
      for (const id of splitIds) visibleIdOf.set(id, id + SUFFIX_OUT);
      return { nodes, edges, visibleIdOf };
    }
  }

  // ---- 建边 ----
  const ids = new Set(nodes.map((n) => n.id));
  const edges = buildEdges(rawEdges, ids, diff?.addedEdgeSigs);

  // diff ghost：消失的节点 / 被删的边
  if (diff) {
    for (const gid of diff.removed) {
      nodes.push({
        id: gid,
        label: "- " + gid,
        fill: GHOST_FILL,
        size: DEFAULT_SIZE,
        data: { id: gid, op: "(removed)", kind: "removed", type: "?" },
      });
    }
    for (const re of diff.removedEdges ?? []) {
      if (ids.has(re.source) || ids.has(re.target)) {
        edges.push({
          id: "rm-" + edgeSig(re),
          source: re.source,
          target: re.target,
          label: "removed",
          fill: REMOVED_EDGE_FILL,
          dashed: true,
        });
      }
    }
  }
  return { nodes, edges, visibleIdOf };
}
