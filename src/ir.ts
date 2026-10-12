export interface IRNode {
  id: string;
  op: string;
  kind: string;
  type: string;
  attrs?: Record<string, unknown>;
  /** original MLIR source line of this instruction */
  src?: string;
  /** 1-based line number in the source .mlir file */
  lineNo?: number;
  /** cluster this node belongs to (e.g. its enclosing pyc.comb region) */
  cluster?: string;
}
export interface IREdge {
  source: string;
  target: string;
  label: string;
}
export interface IRFunction {
  name: string;
  args: { name: string; type: string }[];
  results: { name: string; type: string }[];
  attrs: Record<string, unknown>;
  nodes: IRNode[];
  edges: IREdge[];
  /** PassIRDumper dump tag this function instance came from (if any). */
  origin?: string;
}
export interface IRPass {
  tag: string;
  seq: number;
  phase: "before" | "after";
  inner: number;
  pass: string;
  level: number;
  failed?: boolean;
}
export interface IRDoc {
  module: Record<string, unknown>;
  files: Record<string, string[]>;
  functions: IRFunction[];
  /** Present only when the input was a PassIRDumper dump directory. */
  passes?: IRPass[];
}

export const KIND_COLORS: Record<string, string> = {
  input: "#4caf50",
  const: "#9e9e9e",
  seq: "#e53935",
  comb: "#1e88e5",
  combbox: "#0d47a1",
  output: "#ffc107",
};

export const KIND_LABELS: Record<string, string> = {
  input: "input (arg)",
  const: "constant",
  seq: "seq (reg/delay/fifo)",
  comb: "comb (组合逻辑)",
  combbox: "comb 域 (折叠)",
  output: "output (result)",
};

/** 旧 kind 名 -> 新四大类（input/comb/seq/const/output），兼容旧 graph.json */
export const KIND_ALIASES: Record<string, string> = {
  boundary: "input",
  logic: "comb",
  cmp: "comb",
  arith: "comb",
  call: "comb",
  terminator: "output",
};

/** 归一化 kind：旧名映射到新分类 */
export function normalizeKind(kind: string): string {
  return KIND_ALIASES[kind] ?? kind;
}

export const LAYOUTS = [
  "force", "forceatlas2", "dagre-tb", "dagre-lr", "radial",
  "circular", "concentric", "grid", "fruchterman", "mds",
] as const;
export type Layout = (typeof LAYOUTS)[number];
