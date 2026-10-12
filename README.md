# pyCircuit-graph

基于 [AntV G6](https://g6.antv.antgroup.com/) 的 pyCircuit IR（pyc MLIR 方言）节点可视化工具。

pyCircuit 编译器产出的 pyc 方言 .mlir 文件（供 DavinciBaseLine 使用）是 SSA 形式的硬件 IR。
本仓库提供两部分：

1. **scripts/export_ir.py** — 把 .mlir 解析为 graph.json（纯 Python 正则 SSA 解析，无需 MLIR 绑定）
2. **Web 界面** — Vite + React + AntV G6，按函数渲染 use-def 图

## 使用

### 本地开发

```bash
# 1a. 导出普通 IR（单文件或整个目录）
python scripts/export_ir.py <mlir目录或文件> -o graph.json

# 1b. 按 pass 导出：逐个 pass 执行 pyc-opt，dump 每步 IR（PassIRDumper 命名格式）
python scripts/run_passes.py <input.mlir> \
    -p pyc-state-optimize,pyc-eliminate-wires,pyc-fuse-comb -o pass_ir
python scripts/export_ir.py pass_ir -o graph.json

# 2. 启动界面（public/graph.json 会被加载；也可以直接拖拽 .mlir 文件到页面）
cp graph.json public/graph.json   # 若内容有更新
npm install && npm run dev
```

### Docker 部署

```bash
docker compose up -d --build
# 服务监听 http://localhost:4173
```

- 镜像两阶段构建：build 阶段产出 dist；serve 阶段用 `docker/serve.mjs`
  （零依赖纯 Node 静态 + API 服务器，无 node_modules，常驻内存 ~25MB）。
- `compose.yaml` 把日志目录只读挂载为 `/data/auto_perf_logs`
  （改挂载路径即可接自己的日志），资源限制 1 CPU / 128M，带 healthcheck 与日志轮转。

## auto_perf 任务监控

dev/serve 均内置 API（vite.config.ts 的 autoPerfApi 插件 / docker/serve.mjs），监控
`AUTO_PERF_LOG_DIR`（默认 `/tmp/auto_perf_logs`，容器内 `/data/auto_perf_logs`）下的 `task-*` 目录：

- UI 顶栏第二行每 15s 轮询任务列表；选中任务后自动把该任务目录下所有 `.mlir`
  （主要来自 `pass_ir/`）作为 pass 时间线载入，左侧按 pass 执行层级展示文件树，
  ◀▶/diff 跨 IR 对比。
- API：
  - `GET /api/autoperf/tasks` — 任务列表与文件清单（短 TTL 缓存）
  - `GET /api/autoperf/file?task=<name>&path=<rel>` — 读整个 .mlir
  - `GET /api/autoperf/head?task=<name>&path=<rel>&n=<bytes>` — 只读文件前 N 字节（模块名检测用）
  - 均有路径校验，禁止越出日志根目录。

## 跨 pass 查看

选中任务后左侧是**执行树**：dump 文件名按 PassIRDumper 命名解析
（`NNNN_<phase>_<NN>_<pass>__L<level>__via_<链>.mlir`），via 链为嵌套 pass 实例路径；
MLIR 的 `mlir__detail__OpToOpPassAdaptor` 包装层会被展开跳过，真实 pass 直接显示。
每个 pass 节点带 前/后/⇄diff 三个按钮。

**module 识别与筛选**：工具从每个 dump 文件头部（`pyc.base` 或首个 `func.func`）检测
所属 module，pass 名后缀 `@<module>` 显示；工具栏提供 module 下拉筛选，
树与时间线只显示所选 module 的 IR，不选显示全部。

工具栏 **pass 时间线** ◀ ▶ 逐步切换；diff 模式下新增节点 label 前缀 `+`，
消失的 SSA 值以 ghost 节点显示并计为 `−`，统计栏显示 `(+N / −M)`。

注：pyc-opt 的 `--dump-pass-ir` 在 MLIR 19 上与 `--pass-pipeline` 互斥
（setup 回调会替换文本 pipeline），所以用 run_passes.py 增量执行代替；官方入口
`pycc --dump-pass-ir=auto` 落盘的目录同样可以直接用 export_ir.py 导出。

## 界面功能

- 函数下拉选择（每个 func 一个子图）
- 布局切换（force、forceatlas2、dagre 层次 TB/LR（默认）、radial、circular、concentric、grid、fruchterman、mds）
- **wire 旁路**：有入边的 `pyc.wire` 节点不显示——其全部出边改为从驱动节点发出（wire 链一路传递到最终驱动）；无入边的 wire（外部输入）保留
- 左侧文件树宽度可拖拽；右侧 IR 原文面板宽度可拖拽，悬停行高亮图中节点（悬停 wire 行会高亮其驱动节点）
- 按操作类别着色与过滤：input（绿）/ constant（灰）/ seq（红）/ comb（蓝）/ **comb 域折叠节点（橙，独立配色）** / output（黄）
- 按 SSA 名或 op 搜索过滤
- 点击节点查看 op、类型、属性与前驱/后继
- 节点可拖拽；comb（pyc.comb）分组以 G6 combo 容器展示，可折叠为聚合节点

## graph.json 结构

```json
{
  "files": {"<path>": ["@func", ...]},
  "functions": [{
    "name": "@state_retime_codegen",
    "args": [{"name": "clk", "type": "!pyc.clock"}],
    "results": [{"name": "stage0", "type": "i8"}],
    "nodes": [{"id": "%q0", "op": "pyc.reg", "kind": "seq", "type": "i8"}],
    "edges": [{"source": "%clk", "target": "%q0", "label": "op0"}]
  }]
}
```

数据流来源：pyCircuit 编译器 → pyc 方言 .mlir → graph.json / pass_ir → 本工具。
