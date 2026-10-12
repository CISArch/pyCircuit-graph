import { useEffect, useRef } from "react";
import { Graph } from "@antv/g6";
import type { IRNode, Layout } from "./ir";

export interface G6Node {
  id: string;
  cluster?: string;
  label: string;
  fill: string;
  size: number;
  data: IRNode;
}
export interface G6Edge {
  id: string;
  source: string;
  target: string;
  label?: string;
  fill?: string;
  dashed?: boolean;
}

/** 布局名 -> G6 v5 布局配置（dagre 间距由 buildDagreConfig 按 spacing 生成） */
const LAYOUT_CONFIG: Record<Layout, Record<string, any>> = {
  force: { type: "d3-force", linkDistance: 60, collide: 8 },
  forceatlas2: { type: "forceatlas2", gravity: 1, preventOverlap: true, kr: 20 },
  "dagre-tb": { type: "antv-dagre", rankdir: "TB" },
  "dagre-lr": { type: "antv-dagre", rankdir: "LR" },
  radial: { type: "radial", unitRadius: 60, linkDistance: 50, preventOverlap: true },
  circular: { type: "circular", radius: 220 },
  concentric: { type: "concentric", minNodeSpacing: 20 },
  grid: { type: "grid", sortBy: "id" },
  fruchterman: { type: "fruchterman", gravity: 5, speed: 2 },
  mds: { type: "mds", linkDistance: 50 },
};

/**
 * dagre 间距配置：dagre 会把节点渲染包围盒（含底部标签，100+px 宽）算进占位，
 * 导致同层节点被标签撑得很开。这里用 nodesepFunc/ranksepFunc 返回小间距，
 * dagre 内部仍以包围盒为基准，但叠加的额外间隔可控。
 */
function buildDagreConfig(base: Record<string, any>, spacing: number): Record<string, any> {
  return {
    ...base,
    nodesep: spacing,
    ranksep: spacing * 3,
  };
}

const NODE_STROKE = "#0b1418";
const EDGE_STROKE = "#546e7a";
// comb 分组的 bubble-sets 颜色（与 comb 类别色一致）
const COMB_FILL = "rgba(30, 136, 229, 0.08)";
const COMB_STROKE = "#1e88e5";

/** comb 气泡包络膨胀半径（px）与 dagre 节点间距（px），固定值 */
const BUBBLE_RADIUS = 6;
const DAGRE_SPACING = 8;

export default function G6Canvas(props: {
  nodes: G6Node[];
  edges: G6Edge[];
  layout: Layout;
  hoveredNode: string | null;
  /** 是否显示节点标签（标签会撑大 bubble-sets 的成员包围盒，使气泡显著变大） */
  showLabels?: boolean;
  onNodeClick: (n: G6Node | null) => void;
  /** 右键节点（用于展开/收起 comb 聚合节点） */
  onNodeContextmenu?: (n: G6Node) => void;
}) {
  const { nodes, edges, layout, hoveredNode, showLabels = true, onNodeClick, onNodeContextmenu } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const nodeById = useRef(new Map<string, G6Node>());
  const cb = useRef({ onNodeClick, onNodeContextmenu });
  useEffect(() => {
    cb.current = { onNodeClick, onNodeContextmenu };
  }, [onNodeClick, onNodeContextmenu]);

  // 悬停高亮：热节点描边加亮，离开时恢复默认描边
  const prevHover = useRef<string | null>(null);
  useEffect(() => {
    const g = graphRef.current;
    if (!g || g.destroyed) return;
    const prev = prevHover.current;
    if (prev && prev !== hoveredNode && g.getNodeData(prev)) {
      g.updateNodeData([{ id: prev, style: { stroke: NODE_STROKE, lineWidth: 1 } }]);
      g.draw();
    }
    if (hoveredNode && g.getNodeData(hoveredNode)) {
      g.updateNodeData([{ id: hoveredNode, style: { stroke: "#ffffff", lineWidth: 2.5 } }]);
      g.draw();
    }
    prevHover.current = hoveredNode;
  }, [hoveredNode, nodes]);

  // 创建 / 销毁 Graph 实例（一次）
  useEffect(() => {
    const container = containerRef.current!;
    const g = new Graph({
      container,
      autoFit: "view",
      padding: 24,
      animation: false,
      // 容器尺寸变化（打开/拖动 IR 原文面板、窗口缩放）时同步 canvas 大小，
      // 否则 canvas 溢出盖住右侧面板，导致面板无法滚动/拖动
      node: {
        type: "circle",
        style: {
          size: (d: any) => d?.style?.size ?? 10,
          fill: (d: any) => d?.style?.fill ?? "#455a64",
          stroke: NODE_STROKE,
          lineWidth: 1,
          labelText: (d: any) => d?.style?.labelText ?? "",
          labelPlacement: "bottom",
          labelFontSize: 10,
          labelFill: "#cfd8dc",
          labelBackground: true,
          labelBackgroundFill: "rgba(13,20,24,0.72)",
          labelBackgroundRadius: 3,
          labelPadding: [1, 3],
        },
      } as any,
      edge: {
        type: "line",
        style: {
          stroke: (d: any) => d?.style?.stroke ?? EDGE_STROKE,
          lineWidth: 1,
          lineDash: (d: any) => d?.style?.lineDash,
          endArrow: true,
          endArrowSize: 6,
        },
      } as any,
      behaviors: ["drag-canvas", "zoom-canvas", "drag-element"],
    });
    graphRef.current = g;

    g.on("node:click", (evt: any) => {
      const id = evt?.target?.id as string | undefined;
      const n = id ? nodeById.current.get(id) : null;
      cb.current.onNodeClick(n ?? null);
    });
    // 右键 comb 聚合节点 -> 展开该域（左键保持普通选中行为）
    g.on("node:contextmenu", (evt: any) => {
      const id = evt?.target?.id as string | undefined;
      const n = id ? nodeById.current.get(id) : null;
      if (n) cb.current.onNodeContextmenu?.(n);
    });
    // canvas 上屏蔽浏览器原生右键菜单
    const noMenu = (e: MouseEvent) => e.preventDefault();
    container.addEventListener("contextmenu", noMenu);
    g.on("canvas:click", () => cb.current.onNodeClick(null));

    // autoResize 只监听 window resize；面板开合/拖分隔条只改容器尺寸，
    // 必须用 ResizeObserver 同步 canvas 大小，否则 canvas 溢出盖住 IR 面板。
    // setSize 只改画布尺寸不重适配内容，视图中心会偏走，所以再 fitCenter 拉回中心
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) {
        g.setSize(width, height);
        void g.render().catch(() => {});
      }
    });
    ro.observe(container);

    return () => {
      container.removeEventListener("contextmenu", noMenu);
      ro.disconnect();
      g.destroy();
      graphRef.current = null;
    };
  }, []);

  // 数据 / 布局 / 气泡半径更新：
  // - 数据或布局变化 -> 全量 setData + relayout + render（会 autoFit 视口）
  // - 仅气泡半径变化 -> 只重建 bubble-sets 插件并 draw()，不重布局、不重定视口
  //   （render() 每次都会 autoFit，气泡变大导致包围盒变大、视口缩小，节点看起来就变小了）
  const prevKey = useRef("");
  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    const dataKey = layout + "|" + showLabels + "|" + nodes.map((n) => n.id).join(",") + "|" + edges.map((e) => e.id).join(",");
    // StrictMode 下 effect 会 挂载->销毁->重建：重建后的新 Graph 是空的，必须全量渲染
    const fullRender = dataKey !== prevKey.current || g.getNodeData().length === 0;
    prevKey.current = dataKey;

    // comb 分组：bubble-sets 气泡包络（每个 cluster 一个插件）
    const clusters = new Map<string, string[]>();
    for (const n of nodes) {
      if (!n.cluster) continue;
      const list = clusters.get(n.cluster) ?? [];
      list.push(n.id);
      clusters.set(n.cluster, list);
    }
    const plugins = [...clusters.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([id, members], i) => ({
        key: "comb-bubble-" + i,
        type: "bubble-sets",
        members,
        // 气泡膨胀半径：nodeR0/edgeR0 是内影响半径，nodeR1/edgeR1 是外影响半径
        nodeR0: BUBBLE_RADIUS,
        nodeR1: BUBBLE_RADIUS * 3.3,
        edgeR0: BUBBLE_RADIUS * 0.7,
        edgeR1: BUBBLE_RADIUS * 1.3,
        style: {
          fill: COMB_FILL,
          stroke: COMB_STROKE,
          lineWidth: 1.5,
          labelText: id,
          labelPlacement: "top",
          labelFontSize: 10,
          labelFill: COMB_STROKE,
          labelBackground: true,
          labelBackgroundFill: "rgba(13,20,24,0.72)",
          labelBackgroundRadius: 3,
          labelPadding: [1, 3],
        },
      }));
    (g as unknown as { setPlugins: (p: unknown) => void }).setPlugins(plugins as any);

    if (!fullRender) {
      // BubbleSets 只在 AFTER_RENDER 事件时重算气泡路径（draw() 只触发 AFTER_DRAW），
      // 这里手动补发一次 afterrender 让插件用新半径重算轮廓——不重布局、不重定视口
      (g as unknown as { emit: (e: string) => void }).emit("afterrender");
      return;
    }
    nodeById.current = new Map(nodes.map((n) => [n.id, n]));
    g.setData({
      nodes: nodes.map((n) => ({
        id: n.id,
        data: { ir: n.data },
        style: { size: n.size * 4.2, fill: n.fill, labelText: showLabels ? n.label : "" },
      })),
      edges: edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        style: {
          stroke: e.fill,
          lineDash: e.dashed ? [5, 4] : undefined,
        },
      })),
    });
    const baseCfg = LAYOUT_CONFIG[layout] ?? LAYOUT_CONFIG.force;
    const cfg = layout === "dagre-tb" || layout === "dagre-lr"
      ? buildDagreConfig(baseCfg, DAGRE_SPACING)
      : baseCfg;
    (g as unknown as { setLayout: (o: unknown) => void }).setLayout(cfg);
    void g.render().catch((err) => console.error("[IR Graph] G6 渲染失败:", err));
  }, [nodes, edges, layout, showLabels]);

  return <div ref={containerRef} className="g6canvas" style={{ position: "absolute", inset: 0 }} />;
}
