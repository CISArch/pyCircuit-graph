import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import G6Canvas, { type G6Node, type G6Edge } from "./G6Canvas";
import type { IRDoc, IRFunction, IRPass } from "./ir";
import { KIND_COLORS, KIND_LABELS, LAYOUTS, normalizeKind, type Layout } from "./ir";
import { buildTree, defaultExpanded, parseDumpName, type ParsedDump, type TreeNode } from "./irtree";
import { functionToGraph, edgeSig } from "./graphBuild";

type VNode = G6Node;

interface AutoPerfTask {
  name: string;
  mtime: number;
  hasResult: boolean;
  files: string[];
}

const NODE_WARN_LIMIT = 3000;
const NODE_RENDER_LIMIT = 5000;

function basename(p: string) {
  return p.split("/").pop() ?? p;
}

type Remote = { task: AutoPerfTask; files: string[]; cache: Record<string, IRFunction[]>; raws: Record<string, string> };

// 从 IR 头部文本提取所属 module 名：优先 pyc.base，退回首个 func.func 名
function moduleOfHead(text: string): string | null {
  const base = /pyc\.base\s*=\s*"([^"]+)"/.exec(text);
  if (base) return base[1];
  const fn = /func\.func\s+@([\w.$-]+)/.exec(text);
  if (fn) return fn[1];
  return null;
}

/** tag -> module 名映射：并发限流拉取每个 dump 文件的头部（很轻），失败静默 */
async function fetchModuleMap(
  task: string, files: string[], limit = 12,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let i = 0;
  let done = 0;
  async function next(): Promise<void> {
    while (i < files.length) {
      const rel = files[i++];
      try {
        const r = await fetch("/api/autoperf/head?task=" + encodeURIComponent(task) +
          "&path=" + encodeURIComponent(rel) + "&n=1200");
        if (!r.ok) continue;
        const d = (await r.json()) as { text: string };
        const m = moduleOfHead(d.text);
        if (m) out.set(rel, m);
      } catch { /* skip */ }
      onProgress?.(++done, files.length);
    }
  }
  await Promise.all(Array.from({ length: limit }, next));
  return out;
}


class CanvasErrorBoundary extends Component<{ children: ReactNode; onError: (msg: string) => void }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) {
    console.error("[IR Graph] 布局渲染异常:", error);
    this.props.onError(String(error?.stack ?? error?.message ?? error));
  }
  render() {
    if (this.state.error) {
      return (
        <div className="center">
          <p>此布局渲染失败：{String(this.state.error.message ?? this.state.error)}</p>
          <p>请在上方布局下拉切换回 force。</p>
        </div>
      );
    }
    return this.props.children;
  }
}

function TreePanel(props: {
  node: TreeNode; depth: number; expanded: Set<string>;
  onToggle: (key: string) => void; selected: string; onSelect: (tag: string) => void;
  onDiff?: (beforeTag: string, afterTag: string) => void;
  diffActive?: string;
  moduleMap?: Map<string, string>;
}) {
  const { node, depth, expanded, onToggle, selected, onSelect, onDiff, diffActive, moduleMap } = props;
  // 该节点 dump 对应的 module 名（取第一个有映射的 dump）
  const moduleTag = moduleMap
    ? (node.dumps.find((d) => moduleMap.get(d.tag))?.tag ?? node.derivedBefore?.tag)
    : undefined;
  const moduleName = moduleTag && moduleMap ? moduleMap.get(moduleTag) : undefined;
  // instance node: own before dump -> nested children -> own after dump
  const before = node.dumps.filter((d) => d.phase === "before");
  const after = node.dumps.filter((d) => d.phase !== "before");
  const bTag = before[0]?.tag ?? node.derivedBefore?.tag;
  const aTag = after[0]?.tag ?? node.derivedAfter?.tag;
  if (depth === 0) {
    return (
      <div>
        {node.children.map((c) => (
          <TreePanel key={c.key} node={c} depth={1} expanded={expanded}
            onToggle={onToggle} selected={selected} onSelect={onSelect} onDiff={onDiff} diffActive={diffActive}
            moduleMap={moduleMap} />
        ))}
      </div>
    );
  }
  const open = expanded.has(node.key);
  const active = diffActive === aTag;
  const hasChildren = node.children.length > 0;
  return (
    <div>
      <div
        className={"treedir" + (open ? " open" : "")}
        style={{ paddingLeft: 4 + depth * 12, cursor: hasChildren ? "pointer" : "default" }}
        onClick={hasChildren ? () => onToggle(node.key) : undefined}
      >
        <span className="caret">{hasChildren ? (open ? "\u25be" : "\u25b8") : ""}</span>
        <span className="tlabel" title={moduleName ? node.label + " @ " + moduleName : node.label}>
          {node.label}{moduleName ? <span className="tmod"> @{moduleName}</span> : null}
        </span>
        <span className="treebtns" onClick={(e) => e.stopPropagation()}>
          {bTag && (
            <button
              className={"tbtn" + (selected === bTag ? " sel" : "")}
              title={bTag}
              onClick={() => onSelect(bTag)}
            >{before.length ? "前" : "前*"}</button>
          )}
          {aTag && (
            <button
              className={"tbtn" + (!diffActive && selected === aTag ? " sel" : "")}
              title={aTag}
              onClick={() => onSelect(aTag)}
            >{after.length ? "后" : "后*"}</button>
          )}
          {onDiff && bTag && aTag && (
            <button
              className={"tbtn diff" + (active ? " sel" : "")}
              title="对比该 pass 前后 IR"
              onClick={() => onDiff(bTag, aTag)}
            >⇄</button>
          )}
        </span>
      </div>
      {open ? (
        <div>
          {node.children.map((c) => (
            <TreePanel key={c.key} node={c} depth={depth + 1} expanded={expanded}
              onToggle={onToggle} selected={selected} onSelect={onSelect} onDiff={onDiff} diffActive={diffActive}
              moduleMap={moduleMap} />
          ))}
        </div>
      ) : null}
    </div>
  );
}


export default function App() {
  const [staticDoc, setStaticDoc] = useState<IRDoc | null>(null);
  const [remote, setRemote] = useState<Remote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fnName, setFnName] = useState<string>("");
  const [layout, setLayout] = useState<Layout>("dagre-lr");
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<Set<string>>(new Set(Object.keys(KIND_COLORS)));
  const [selected, setSelected] = useState<VNode | null>(null);
  const [passTag, setPassTag] = useState<string | null>(null);
  const [tasks, setTasks] = useState<AutoPerfTask[]>([]);
  const [taskName, setTaskName] = useState<string>("");
  const [loadingMsg, setLoadingMsg] = useState<string | null>(null);
  const [irFlavor, setIrFlavor] = useState<"cpp" | "verilator">("cpp");
  const [diffMode, setDiffMode] = useState<{ beforeTag: string; afterTag: string } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [irPanelOpen, setIrPanelOpen] = useState(false);
  const [irPanelWidth, setIrPanelWidth] = useState(420); // px, excludes sidebar
  const [treeWidth, setTreeWidth] = useState(300); // 左侧文件树宽度，可拖拽
  const draggingDivider = useRef(false);
  const draggingTree = useRef(false);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [showLabels, setShowLabels] = useState(true);
  const [splitRegs, setSplitRegs] = useState(false);
  // comb 域默认折叠成聚合大节点；expandedClusters 是用户点开过的域
  const [collapseCombs, setCollapseCombs] = useState(true);
  const [expandedClusters, setExpandedClusters] = useState<Set<string>>(new Set());
  const clusterSeq = useRef(new Map<string, number>()).current; // cluster -> 序号（跨渲染稳定）
  const fileInput = useRef<HTMLInputElement>(null);

  const filterFlavor = useCallback((files: string[], flavor: "cpp" | "verilator") => {
    const matched = files.filter((f) => f.includes("/" + flavor + "/"));
    return matched.length ? matched : files;
  }, []);

  const loadDoc = useCallback((d: IRDoc) => {
    setStaticDoc(d);
    setRemote(null);
    setPassTag(d.passes?.[0]?.tag ?? null);
    const first = d.passes?.length ? d.functions.find((f) => f.origin === d.passes![0].tag) : d.functions[0];
    setFnName(first?.name ?? "");
    setSelected(null);
  }, []);

  const refreshTasks = useCallback(async () => {
    try {
      const r = await fetch("/api/autoperf/tasks");
      if (!r.ok) return;
      const d = (await r.json()) as { tasks: AutoPerfTask[] };
      setTasks(d.tasks);
    } catch { /* server not ready */ }
  }, []);

  // 每 15s 轮询 auto_perf 日志目录，新任务/新 IR 自动出现
  useEffect(() => {
    const t = setInterval(() => void refreshTasks(), 15000);
    return () => clearInterval(t);
  }, [refreshTasks]);

  // 默认加载本地 graph.json（export_ir.py 的产物）；远端任务选中后覆盖
  useEffect(() => {
    // URL 带任务参数时走恢复流程，不加载静态默认数据（避免竞态顶掉远端任务）
    if (new URLSearchParams(location.search).get("task")) return;
    fetch("graph.json")
      .then((r) => (r.ok ? (r.json() as Promise<IRDoc>) : Promise.reject(new Error("HTTP " + r.status))))
      .then(loadDoc)
      .catch(() => { /* 没有本地 graph.json 也可以，用任务面板加载 */ });
  }, [loadDoc]);

  const onDrop = useCallback(
    async (file: File) => {
      try {
        const text = await file.text();
        if (file.name.endsWith(".json")) {
          loadDoc(JSON.parse(text) as IRDoc);
        } else {
          const { parseMlirText } = await import("./wasmParse");
          const d = parseMlirText(text);
          loadDoc(d);
        }
        setError(null);
      } catch (e) {
        setError("load failed: " + String(e));
      }
    },
    [loadDoc],
  );

  const fetchRemoteFunctions = useCallback(
    async (task: string, rel: string): Promise<{ fns: IRFunction[]; text: string }> => {
      const r = await fetch("/api/autoperf/file?task=" + encodeURIComponent(task) +
        "&path=" + encodeURIComponent(rel));
      if (!r.ok) throw new Error(rel + ": HTTP " + r.status);
      const d = (await r.json()) as { text: string };
      const { parseMlirText } = await import("./wasmParse");
      const parsed = parseMlirText(d.text);
      return { fns: parsed.functions.map((f) => ({ ...f, origin: rel })), text: d.text };
    },
    [],
  );

  // 按需加载：只拉取当前选中的 IR 文件（以及 diff 需要的上一个文件）
  const ensureTags = useCallback(
    async (tags: string[]) => {
      if (!remote) return;
      const missing = tags.filter((t) => t && !remote.cache[t]);
      if (!missing.length) return;
      setLoadingMsg("拉取解析 " + missing.length + " 个 IR 文件…");
      const cache = { ...remote.cache };
      const raws = { ...remote.raws };
      let fail: string | null = null;
      for (const tag of missing) {
        try {
          const { fns, text } = await fetchRemoteFunctions(remote.task.name, tag);
          cache[tag] = fns;
          raws[tag] = text;
        } catch (e) {
          fail = String(e);
          cache[tag] = [];
        }
      }
      setRemote({ ...remote, cache, raws });
      setLoadingMsg(null);
      if (fail) setError("部分文件读取失败: " + fail);
    },
    [remote, fetchRemoteFunctions],
  );

  const taskDirs = useMemo(() => {
    const t = tasks.find((x) => x.name === taskName);
    if (!t) return [];
    const s = new Set<string>();
    t.files.forEach((f) => s.add(f.split("/")[0]));
    return [...s].sort();
  }, [tasks, taskName]);

  const selectTask = useCallback(
    (t: AutoPerfTask, flavor: "cpp" | "verilator" = irFlavor, dir?: string) => {
      setTaskName(t.name);
      setDiffMode(null);
      setSelected(null);
      let all = filterFlavor([...t.files].sort(), flavor);
      // 一个任务里有多个 dump 目录（如 ir/ 与 ir-default/ 两个编译变体）时按目录过滤
      const dirs = [...new Set(all.map((f) => f.split("/")[0]))].sort();
      const useDir = dir ?? (dirs.includes("ir") ? "ir" : dirs[0] ?? "");
      if (dirs.length > 1 && useDir) {
        const m = all.filter((f) => f.startsWith(useDir + "/"));
        if (m.length) all = m;
      }
      setError(all.length ? null : "该任务目录下还没有 .mlir IR（pass_ir 尚未产出）");
      if (!all.length) { setRemote(null); return; }
      const files = all;
      // 选中任务后不自动加载第一个 IR：清空当前图，等用户在 pass 下拉里选
      setStaticDoc(null);
      setRemote({ task: t, files, cache: {}, raws: {} });
      setPassTag(null);
      setFnName("");
    },
    [filterFlavor, irFlavor],
  );

  const selectDiff = useCallback(
    (beforeTag: string, afterTag: string) => {
      setDiffMode({ beforeTag, afterTag });
      setPassTag(afterTag);
      setSelected(null);
      void ensureTags([beforeTag, afterTag]);
    },
    [ensureTags],
  );  // doc：远端任务按需合成；否则用静态导入的 graph.json / 拖拽文件
  // URL 同步：task / ir / fn 写进 query，刷新后恢复
  useEffect(() => {
    if (!urlRestored.current) return; // 恢复完成前不同步，避免空值把 query 抹掉
    const p = new URLSearchParams();
    if (taskName) p.set("task", taskName);
    if (passTag) p.set("ir", passTag);
    if (fnName) p.set("fn", fnName);
    const q = p.toString();
    history.replaceState(null, "", location.pathname + (q ? "?" + q : ""));
  }, [taskName, passTag, fnName]);

  // 刷新恢复：从 URL 读取 task/ir/fn
  const urlRestored = useRef(false);
  useEffect(() => {
    if (urlRestored.current || !tasks.length) return;
    const p = new URLSearchParams(location.search);
    const task = p.get("task");
    if (!task) { urlRestored.current = true; return; }
    const t = tasks.find((x) => x.name === task);
    if (!t) { urlRestored.current = true; return; }
    urlRestored.current = true;
    selectTask(t, (p.get("flavor") as "cpp" | "verilator") ?? irFlavor);
    const ir = p.get("ir");
    const fn = p.get("fn");
    if (ir) setPassTag(ir);
    if (fn) setFnName(fn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, selectTask]);

  // tag -> module 名（从各 dump 文件头部检测）；到达前树先显示无后缀版本
  // 注意：不能把 cancelled 挂在 effect cleanup 上——ensureTags 会更新 remote 对象身份，
  // cleanup 会误杀进行中的拉取；只有切换任务才取消。
  const [moduleMap, setModuleMap] = useState<Map<string, string>>(new Map());
  const [moduleProgress, setModuleProgress] = useState<string | null>(null);
  const moduleTaskRef = useRef("");
  const moduleCancelRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!remote) return;
    if (moduleTaskRef.current === remote.task.name) return;
    moduleTaskRef.current = remote.task.name;
    moduleCancelRef.current?.();
    setModuleMap(new Map());
    setModuleProgress("module 名 0/" + remote.files.length);
    let cancelled = false;
    moduleCancelRef.current = () => { cancelled = true };
    void fetchModuleMap(remote.task.name, remote.files, 12, (done, total) => {
      if (!cancelled) setModuleProgress("module 名 " + done + "/" + total);
    }).then((m) => {
      if (!cancelled) { setModuleMap(m); setModuleProgress(null); }
    });
  }, [remote]);
  // module 筛选：选中后树/时间线只显示该 module 的 dump；moduleMap 未加载完时不过滤
  const [moduleFilter, setModuleFilter] = useState("");
  const moduleOptions = useMemo(
    () => [...new Set(moduleMap.values())].sort(),
    [moduleMap],
  );
  const visibleFiles = useMemo(() => {
    if (!remote) return [];
    if (!moduleFilter || !moduleMap.size) return remote.files;
    return remote.files.filter((f) => moduleMap.get(f) === moduleFilter);
  }, [remote, moduleFilter, moduleMap]);
  // 筛选变化后当前选中的 pass 可能不在筛选结果里：清掉避免空白图
  useEffect(() => {
    if (passTag && remote && moduleFilter && !visibleFiles.includes(passTag)) {
      setPassTag(null);
      setDiffMode(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleFilter, visibleFiles]);
  // IR 文件按 PassIRDumper 命名组织成执行树（via 链 = 嵌套 pass 实例路径）
  const dumps: ParsedDump[] = useMemo(
    () => (visibleFiles.map(parseDumpName).filter((d): d is ParsedDump => !!d)),
    [visibleFiles],
  );
  const irTree = useMemo(() => (dumps.length ? buildTree(dumps) : null), [dumps]);

  const doc: IRDoc | null = useMemo(() => {
    if (remote) {
      const passes: IRPass[] = visibleFiles.map((rel, i) => ({
        tag: rel, seq: i, phase: "after", inner: i, pass: basename(rel), level: 0,
      }));
      const functions = Object.values(remote.cache).flat();
      return { module: {}, files: {}, functions, passes };
    }
    return staticDoc;
  }, [remote, staticDoc, visibleFiles]);

  const passes = doc?.passes ?? null;
  const passIdx = passes ? passes.findIndex((p) => p.tag === passTag) : -1;
  const treeKey = remote?.task.name + ":" + remote?.files.length;
  useEffect(() => {
    if (remote) setExpanded(defaultExpanded(irTree ?? { key: "", label: "", children: [], dumps: [], firstSeq: 0 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeKey]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (draggingTree.current) {
        const mainEl = document.querySelector(".main");
        if (mainEl) {
          const rect = mainEl.getBoundingClientRect();
          setTreeWidth(Math.min(Math.max(e.clientX - rect.left, 180), Math.min(560, rect.width - 200)));
        }
        return;
      }
      if (!draggingDivider.current) return;
      const mainEl = document.querySelector(".main");
      if (!mainEl) return;
      const rect = mainEl.getBoundingClientRect();
      const sidebarEl = mainEl.querySelector(".sidebar");
      const sidebarW = sidebarEl ? sidebarEl.getBoundingClientRect().width : 0;
      // 面板宽度 = 分隔条右缘(=鼠标位置) 到 详情栏左缘 的距离（像素）
      const w = rect.right - sidebarW - e.clientX;
      setIrPanelWidth(Math.min(Math.max(w, 200), rect.width - sidebarW - 150));
    };
    const onUp = () => { draggingDivider.current = false; draggingTree.current = false; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const toggleNode = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // diff 需要上一个 dump；变更摘要需要第一个 dump（输入）——都懒加载
  useEffect(() => {
    if (!remote || !passes || passIdx < 0) return;
    const need = [passes[0].tag, passes[passIdx].tag];
    if (diffMode) need.push(diffMode.beforeTag, diffMode.afterTag);
    void ensureTags(need);
  }, [remote, passes, passIdx, diffMode, ensureTags]);

  const visibleFns = useMemo(() => {
    if (!doc) return [];
    if (passes && passTag != null) return doc.functions.filter((f) => f.origin === passTag);
    return doc.functions.filter((f) => !f.origin);
  }, [doc, passes, passTag]);

  const fn = useMemo(
    () => visibleFns.find((f) => f.name === fnName) ?? visibleFns[0],
    [visibleFns, fnName],
  );

  const diff = useMemo(() => {
    if (!fn) return null;
    if (!diffMode) return null;
    const prev = remote?.cache[diffMode.beforeTag]?.find((f) => f.name === fn.name);
    if (!prev) return null;
    const base = prev as IRFunction;
    const cur = new Set(fn.nodes.map((n) => n.id));
    const prevSet = new Set(base.nodes.map((n) => n.id));
    const added = new Set([...cur].filter((x) => !prevSet.has(x)));
    const removed = new Set([...prevSet].filter((x) => !cur.has(x)));
    const removedEdges: { source: string; target: string }[] = [];
    const addedEdgeSigs = new Set<string>();
    if (diffMode) {
      const curSigs = new Set(fn.edges.map(edgeSig));
      for (const e of base.edges) {
        if (!curSigs.has(edgeSig(e))) removedEdges.push({ source: e.source, target: e.target });
      }
      const prevSigs = new Set(base.edges.map(edgeSig));
      for (const e of fn.edges) {
        if (!prevSigs.has(edgeSig(e))) addedEdgeSigs.add(edgeSig(e));
      }
    }
    if (!added.size && !removed.size && !removedEdges.length) return null;
    return { added, removed, removedEdges, addedEdgeSigs };
  }, [fn, diffMode, remote]);

  const graph = useMemo(
    () =>
      fn
        ? functionToGraph(fn, kindFilter, search, splitRegs, collapseCombs, expandedClusters, clusterSeq, diff)
        : { nodes: [] as G6Node[], edges: [] as G6Edge[], visibleIdOf: new Map<string, string>() },
    [fn, kindFilter, search, splitRegs, collapseCombs, expandedClusters, clusterSeq, diff],
  );
  // 原始节点 id -> 图上可见节点 id（comb 折叠时指向聚合节点）
  const visibleIdOf = graph.visibleIdOf;

  // G6 v5 的 combo 在所有布局下均可作为 cluster 分组容器
  const renderNodes = graph.nodes;

  // 类别 chip 按“函数中实际存在的类别”展示（不随过滤消失，否则取消勾选后就再也点不回来）；
  // 计数显示当前视图中的节点数（折叠时 comb 域成员归入 combbox 类）
  const presentKinds = useMemo(() => {
    const fnKinds = new Set<string>();
    fn?.nodes.forEach((n) => fnKinds.add(normalizeKind(n.kind)));
    const viewCount = new Map<string, number>();
    for (const n of graph.nodes) {
      const k = normalizeKind(n.data.kind);
      viewCount.set(k, (viewCount.get(k) ?? 0) + 1);
    }
    // combbox（折叠域聚合）只按视图统计，不依赖原始节点
    if (viewCount.has("combbox")) fnKinds.add("combbox");
    return [...fnKinds].sort().map((k) => [k, viewCount.get(k) ?? 0] as [string, number]);
  }, [fn, graph.nodes]);

  // IR 原文行号 -> 图上可见节点 id（悬停原文行高亮图中节点；折叠时指向所属 comb 聚合节点）
  const lineMap = useMemo(() => {
    const m = new Map<number, string>();
    fn?.nodes.forEach((n) => {
      if (n.lineNo == null || m.has(n.lineNo)) return;
      m.set(n.lineNo, visibleIdOf.get(n.id) ?? n.id);
    });
    return m;
  }, [fn, visibleIdOf]);  // 选中节点时，原文面板滚动到对应行并高亮
  useEffect(() => {
    const ln = selected?.data.lineNo;
    if (ln == null || !irPanelOpen) return;
    const el = document.querySelector(`.irline[data-ln="${ln}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [selected, irPanelOpen]);  const neighbors = useMemo(() => {
    if (!selected || !fn) return null;
    const preds = fn.edges.filter((e) => e.target === selected.id).map((e) => e.source);
    const succs = fn.edges.filter((e) => e.source === selected.id).map((e) => e.target);
    return { preds, succs };
  }, [selected, fn]);


  // 变更摘要：当前 IR 相对最初输入（第一个 dump）的整体差异与原始元数据
  const changeSummary = useMemo(() => {
    if (!remote || !passes || passIdx < 0 || !fn) return null;
    const baseTag = diffMode ? diffMode.beforeTag : passes[0].tag;
    const baseFns = remote.cache[baseTag];
    if (!baseFns) return null;
    const curTag = passes[passIdx].tag;
    const curFns = remote.cache[curTag];
    if (!curFns) return null;
    const baseSets = new Map(baseFns.map((f) => [f.name, new Set(f.nodes.map((n) => n.id))]));
    const curSets = new Map(curFns.map((f) => [f.name, new Set(f.nodes.map((n) => n.id))]));
    let added = 0, removed = 0;
    const perFn: { name: string; added: number; removed: number }[] = [];
    for (const [name, cur] of curSets) {
      const base = baseSets.get(name);
      if (!base) { added += cur.size; perFn.push({ name, added: cur.size, removed: 0 }); continue; }
      const a = [...cur].filter((x) => !base.has(x)).length;
      const r = [...base].filter((x) => !cur.has(x)).length;
      added += a; removed += r;
      if (a || r) perFn.push({ name, added: a, removed: r });
    }
    for (const [name, base] of baseSets) {
      if (!curSets.has(name)) { removed += base.size; perFn.push({ name, added: 0, removed: base.size }); }
    }
    perFn.sort((x, y) => (y.added + y.removed) - (x.added + x.removed));
    const kinds: Record<string, number> = {};
    for (const f of curFns) for (const n of f.nodes) { const k = normalizeKind(n.kind); kinds[k] = (kinds[k] ?? 0) + 1; }
    const p = passes[passIdx];
    return {
      baseTag, curTag, added, removed,
      baseNodes: baseFns.reduce((n, f) => n + f.nodes.length, 0),
      curNodes: curFns.reduce((n, f) => n + f.nodes.length, 0),
      baseEdges: baseFns.reduce((n, f) => n + f.edges.length, 0),
      curEdges: curFns.reduce((n, f) => n + f.edges.length, 0),
      baseFns: baseFns.length, curFns: curFns.length,
      kinds, perFn,
      meta: { seq: p.seq + 1, total: passes.length, pass: p.pass, phase: p.phase, level: p.level, file: p.tag },
    };
  }, [remote, passes, passIdx, fn, diffMode]);
  const toggleKind = (k: string) =>
    setKindFilter((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next.size ? next : new Set(Object.keys(KIND_COLORS));
    });

  if (error && !doc && !loadingMsg) {
    return (
      <div className="center">
        <p>加载失败：{error}</p>
        <p>先运行 python scripts/export_ir.py &lt;mlir目录&gt; -o graph.json，或拖拽 .mlir/.json 文件到页面。</p>
      </div>
    );
  }
  if (!doc && !loadingMsg) return <div className="center">loading…</div>;

  // 上限按“实际渲染节点数”（折叠后的 graph.nodes）判断，而非函数原始节点数
  const bigGraph = graph.nodes.length > NODE_WARN_LIMIT && graph.nodes.length <= NODE_RENDER_LIMIT;
  const tooBig = graph.nodes.length > NODE_RENDER_LIMIT;

  return (
    <div
      className="app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files?.[0];
        if (f) void onDrop(f);
      }}
    >
      <header className="toolbar">
        <strong>pyCircuit IR Graph <span style={{color:"#4dd0e1",fontSize:11}}>v3-diff</span></strong>
        {passes && passes.length > 0 && (
          <span className="passbar">
            <button
              disabled={passIdx <= 0}
              onClick={() => { setPassTag(passes[passIdx - 1].tag); setSelected(null); setDiffMode(null); }}
            >◀</button>
            <span className="stat">{passIdx >= 0 ? (passIdx + 1) + "/" + passes.length : "选择左侧 IR"}</span>
            <button
              disabled={passIdx < 0 || passIdx === passes.length - 1}
              onClick={() => { setPassTag(passes[passIdx + 1].tag); setSelected(null); setDiffMode(null); }}
            >▶</button>
          </span>
        )}
        {remote && moduleOptions.length > 0 && (
          <select
            value={moduleFilter}
            title="按 module 筛选 IR 文件（树与时间线）；不选显示全部"
            onChange={(e) => { setModuleFilter(e.target.value); setDiffMode(null); }}
          >
            <option value="">全部 module（{remote.files.length} IR）</option>
            {moduleOptions.map((m) => (
              <option key={m} value={m}>
                {m}（{[...moduleMap.values()].filter((v) => v === m).length}）
              </option>
            ))}
          </select>
        )}
        <select value={fn?.name ?? ""} onChange={(e) => { setFnName(e.target.value); setSelected(null); }}>
          {visibleFns.map((f) => (
            <option key={f.origin + f.name} value={f.name}>
              {f.name} ({f.nodes.length})
            </option>
          ))}
        </select>
        <select value={layout} onChange={(e) => setLayout(e.target.value as Layout)}>
          {LAYOUTS.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
        <label className="chk" title="显示/隐藏节点标签（标签文本会撑大气泡包围盒）">
          <input
            type="checkbox" checked={showLabels}
            onChange={(e) => setShowLabels(e.target.checked)}
          /> 标签
        </label>
        <label className="chk" title="reg 等时序节点拆成输入(D)/输出(Q)两个节点：入边挂 D、出边挂 Q，打断反馈环便于层次布局">
          <input
            type="checkbox" checked={splitRegs}
            onChange={(e) => setSplitRegs(e.target.checked)}
          /> 消环
        </label>
        <label className="chk" title="pyc.comb 域默认折叠成一个聚合大节点（减少渲染节点数）；点击图中的 comb 节点可展开/收起该域">
          <input
            type="checkbox" checked={collapseCombs}
            onChange={(e) => {
              setCollapseCombs(e.target.checked);
              setExpandedClusters(new Set());
            }}
          /> comb 折叠
        </label>
        <input
          className="search"
          placeholder="搜索 SSA 名 / op…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="stat">
          {graph.nodes.length} nodes / {graph.edges.length} edges
          {diff && (
            <span className="diffstat">
              (+{diff.added.size} / −{diff.removed.size} 节点
              {diff.addedEdgeSigs ? <span>, −{diff.removedEdges?.length ?? 0} 边 / +{diff.addedEdgeSigs.size} 边</span> : null})
            </span>
          )}
        </span>
        <button
          className={irPanelOpen ? "on" : ""}
          onClick={async () => {
            setIrPanelOpen(!irPanelOpen);
            if (!irPanelOpen && remote && passTag && !remote.raws[passTag]) {
              await ensureTags([passTag]);
            }
          }}
        >IR 原文</button>
        <button onClick={() => fileInput.current?.click()}>打开 .mlir/.json</button>
        <input
          ref={fileInput}
          type="file"
          accept=".mlir,.json,.txt"
          hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onDrop(f); }}
        />
      </header>
      <div className="taskbar">
        <span className="lbl">auto_perf 任务</span>
        <select
          value={taskName}
          onChange={(e) => {
            const t = tasks.find((x) => x.name === e.target.value);
            if (t) selectTask(t);
          }}
        >
          <option value="">{tasks.length ? "选择任务…" : "（未发现任务）"}</option>
          {tasks.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}{t.files.length ? " (" + t.files.length + " IR)" : ""}
            </option>
          ))}
        </select>
        <button onClick={() => void refreshTasks()}>刷新</button>
        {taskDirs.length > 1 && (
          <span className="passbar">
            <span className="lbl">IR 组：</span>
            {taskDirs.map((d) => (
              <button
                key={d}
                className={"chip" + ((remote?.files[0] ?? "").startsWith(d + "/") ? " on" : "")}
                onClick={() => {
                  const t = tasks.find((x) => x.name === taskName);
                  if (t) selectTask(t, irFlavor, d);
                }}
              >{d}</button>
            ))}
          </span>
        )}
        <span className="passbar">
          {(["cpp", "verilator"] as const).map((fl) => (
            <button
              key={fl}
              className={"chip" + (irFlavor === fl ? " on" : "")}
              onClick={() => {
                if (irFlavor !== fl) {
                  setIrFlavor(fl);
                  const t = tasks.find((x) => x.name === taskName);
                  if (t) selectTask(t, fl);
                }
              }}
            >{fl}</button>
          ))}
        </span>
        {loadingMsg && <span className="loading">{loadingMsg}</span>}
        {moduleProgress && <span className="stat" title="正在从各 IR 文件头部检测所属 module">{moduleProgress}</span>}
        {error && <span className="loading" title={error}>⚠ {error.slice(0, 120)}</span>}
        {remote && !loadingMsg && (
          <span className="stat">
            已缓存 {Object.keys(remote.cache).length}/{remote.files.length} 个 IR（按需拉取，不整包加载）
          </span>
        )}
      </div>
      <div className="kinds">
        {presentKinds.map(([k, n]) => (
          <button
            key={k}
            className={"chip" + (kindFilter.has(k) ? " on" : "")}
            style={{ borderColor: KIND_COLORS[k] }}
            onClick={() => toggleKind(k)}
          >
            <span className="dot" style={{ background: KIND_COLORS[k] }} />
            {KIND_LABELS[k] ?? k} ({n})
          </button>
        ))}
        {collapseCombs && expandedClusters.size > 0 && (
          <span
            className="chip on"
            style={{ borderColor: "#1e88e5", cursor: "pointer" }}
            title="点击收起所有已展开的 comb 域"
            onClick={() => setExpandedClusters(new Set())}
          >
            <span className="dot" style={{ background: "#1e88e5" }} />
            已展开 {expandedClusters.size} 个 comb（点此全部收起）
          </span>
        )}
      </div>
      <main className="main">
        <aside className="tree" style={{ width: treeWidth + "px", flexShrink: 0 }}>
          <div className="treehead">IR 文件（执行树：pass 节点内 前→子嵌套→后）</div>
          {irTree ? (
            <TreePanel node={irTree} depth={0} expanded={expanded} onToggle={toggleNode}
              selected={diffMode ? "" : (passTag ?? "")} onSelect={(tag) => { setPassTag(tag); setSelected(null); setDiffMode(null); }}
              onDiff={(b, a) => selectDiff(b, a)}
              diffActive={diffMode?.afterTag}
              moduleMap={moduleMap} />
          ) : (
            <p className="hint">选择上方任务后，这里按 pass 执行层级展示 IR 文件树。</p>
          )}
        </aside>
        <div
          className="divider"
          title="拖拽调整文件树宽度"
          onMouseDown={(e) => { e.preventDefault(); draggingTree.current = true; }}
        />
        <div className="canvas">
          {bigGraph && !tooBig && (
            <div className="warn">
              当前视图 {graph.nodes.length} 节点（函数共 {fn!.nodes.length}），渲染可能卡顿；
              可保持 comb 折叠、或用搜索/类别过滤缩小范围。
            </div>
          )}
          {remote && !fn ? (
            <div className="center">
              <p>已选中任务 {taskName}（{remote.files.length} 个 IR）。</p>
              <p>请在上方 pass 下拉中选择一个 IR 后展开图。</p>
            </div>
          ) : tooBig ? (
            <div className="center">
              <p>
                当前视图 {graph.nodes.length} 节点（上限 {NODE_RENDER_LIMIT}），直接渲染会卡死浏览器。
              </p>
              <p>
                建议：保持「comb 折叠」勾选（当前已折叠域不占节点数）、收起部分已展开的 comb、
                或用搜索/类别过滤缩小范围；函数总节点数 {fn?.nodes.length}。
              </p>
            </div>
          ) : (
          <CanvasErrorBoundary key={"eb-" + layout} onError={(msg) => {
            setLayout("force");
            setError("布局 " + layout + " 渲染异常，已回退到 force: " + msg);
          }}>
          <G6Canvas
            nodes={renderNodes}
            edges={graph.edges}
            layout={layout}
            hoveredNode={hoveredNode}
            showLabels={showLabels}
            onNodeClick={(n) => setSelected(n)}
            onNodeContextmenu={(n) => {
              // 右键 comb 聚合节点 -> 展开/收起该域
              if (n.data.kind === "combbox") {
                const cluster = n.data.id;
                setExpandedClusters((prev) => {
                  const next = new Set(prev);
                  if (next.has(cluster)) next.delete(cluster);
                  else next.add(cluster);
                  return next;
                });
              }
            }}
          />
          </CanvasErrorBoundary>
          )}
        </div>
        {irPanelOpen && remote && passTag && remote.raws[passTag] && (
          <>
          <div
            className="divider"
            onMouseDown={(e) => { e.preventDefault(); draggingDivider.current = true; }}
          />
          <aside className="irpanel" style={{ width: irPanelWidth + "px", flexShrink: 0 }}>
            <div className="irhead">IR 原文 · {basename(passTag)}（悬停行高亮图中节点）</div>
            <div className="irtext">
              {remote.raws[passTag].split("\n").map((line, i) => {
                const ln = i + 1;
                const nid = lineMap.get(ln);
                return (
                  <div
                    key={ln}
                    className={"irline" + (nid ? " hasnode" : "") + (hoveredNode === nid && nid ? " hot" : "") + (selected?.data.lineNo === ln ? " sel" : "")}
                    onMouseEnter={() => nid && setHoveredNode(nid)}
                    onMouseLeave={() => nid && setHoveredNode(null)}
                    onClick={() => nid && setSelected(null)}
                    data-ln={ln}
                  >
                    <span className="ln">{ln}</span>
                    <span className="code">{line}</span>
                  </div>
                );
              })}
            </div>
          </aside>
          </>
        )}
        <aside className="sidebar">
          {changeSummary && (
            <div className="changesum">
              <h3>变更摘要（相对输入 #{passes![0].seq + 1}）</h3>
              <div className="csrow">
                <span className="add">+{changeSummary.added}</span>
                <span className="rem">−{changeSummary.removed}</span>
                <span>净 {changeSummary.curNodes - changeSummary.baseNodes >= 0 ? "+" : ""}{changeSummary.curNodes - changeSummary.baseNodes}</span>
              </div>
              <table className="mtable">
                <tbody>
                  <tr><td>输入</td><td>{changeSummary.baseNodes} 节点 / {changeSummary.baseEdges} 边 / {changeSummary.baseFns} 函数</td></tr>
                  <tr><td>当前</td><td>{changeSummary.curNodes} 节点 / {changeSummary.curEdges} 边 / {changeSummary.curFns} 函数</td></tr>
                  <tr><td>位置</td><td>#{changeSummary.meta.seq}/{changeSummary.meta.total} · {changeSummary.meta.pass}{moduleMap.get(changeSummary.meta.file) ? " @" + moduleMap.get(changeSummary.meta.file) : ""} (L{changeSummary.meta.level}, {changeSummary.meta.phase})</td></tr>
                </tbody>
              </table>
              <h4>类别分布</h4>
              <div className="kinds">
                {Object.entries(changeSummary.kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => (
                  <span key={k} className="chip on" style={{ borderColor: KIND_COLORS[k] ?? KIND_COLORS.comb }}>
                    <span className="dot" style={{ background: KIND_COLORS[k] ?? KIND_COLORS.comb }} />{KIND_LABELS[k] ?? k} ({n})
                  </span>
                ))}
              </div>
              {changeSummary.perFn.length > 0 && (
                <>
                  <h4>函数级变化（前 15）</h4>
                  <table className="mtable">
                    <tbody>
                      {changeSummary.perFn.slice(0, 15).map((x) => (
                        <tr key={x.name}><td>{x.name}</td><td className="add">+{x.added}</td><td className="rem">−{x.removed}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          )}
          {selected ? (
            <>
              <h3>{selected.id}</h3>
              <table>
                <tbody>
                  <tr><td>op</td><td>{selected.data.op}</td></tr>
                  <tr><td>kind</td><td>{normalizeKind(selected.data.kind)}</td></tr>
                  <tr><td>type</td><td>{selected.data.type}</td></tr>
                </tbody>
              </table>
              {selected.data.attrs && <pre>{JSON.stringify(selected.data.attrs, null, 2)}</pre>}
              {neighbors && (
                <>
                  <h4>前驱 ({neighbors.preds.length})</h4>
                  <ul>{neighbors.preds.map((p) => <li key={p}>{p}</li>)}</ul>
                  <h4>后继 ({neighbors.succs.length})</h4>
                  <ul>{neighbors.succs.map((s) => <li key={s}>{s}</li>)}</ul>
                </>
              )}
            </>
          ) : (
            <p className="hint">点击节点查看详情；拖拽 .mlir 文件可直接加载。</p>
          )}
        </aside>
      </main>
    </div>
  );
}
