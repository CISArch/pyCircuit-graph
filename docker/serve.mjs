// Minimal zero-dependency production server for pyCircuit-graph.
// Serves the built SPA from dist/ and the auto_perf log API that vite.config.ts
// provides in dev/preview mode (same routes, same path-validation rules).
import { createReadStream, existsSync, statSync } from 'node:fs'
import { readdir, readFile, stat, open } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'

const PORT = Number(process.env.PORT || 4173)
const DIST = resolve(process.env.DIST_DIR || 'dist')
const LOG_ROOT = resolve(process.env.AUTO_PERF_LOG_DIR || '/data/auto_perf_logs')
const MAX_DEPTH = 4

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function findMlirFiles(dir, base, out, depth = 0) {
  if (depth > MAX_DEPTH) return
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const rel = base ? `${base}/${e.name}` : e.name
    if (e.isDirectory()) await findMlirFiles(join(dir, e.name), rel, out, depth + 1)
    else if (e.name.endsWith('.mlir')) out.push(rel)
  }
}

// tasks response is expensive (walks every task dir); cache it briefly so
// concurrent pollers reuse one walk. TTL is short enough to stay fresh.
const TASKS_TTL_MS = 3000
let tasksCache = { at: 0, body: null, inflight: null }

async function computeTasks() {
  const tasks = []
  try {
    const entries = (await readdir(LOG_ROOT)).filter((e) => e.startsWith('task-')).sort().reverse()
    for (const name of entries) {
      const dir = join(LOG_ROOT, name)
      const st = await stat(dir).catch(() => null)
      if (!st?.isDirectory()) continue
      const files = []
      await findMlirFiles(dir, '', files)
      const hasResult = await stat(join(dir, 'result.json')).then(() => true, () => false)
      tasks.push({ name, mtime: st.mtimeMs, hasResult, files })
    }
  } catch { /* log root missing -> empty list */ }
  return JSON.stringify({ root: LOG_ROOT, tasks })
}

function handleTasks(res) {
  const fresh = Date.now() - tasksCache.at < TASKS_TTL_MS
  if (fresh && tasksCache.body) return sendCached(res)
  if (tasksCache.inflight) return tasksCache.inflight.then(() => sendCached(res))
  tasksCache.inflight = computeTasks()
    .then((body) => { tasksCache = { at: Date.now(), body, inflight: null } })
    .catch(() => { tasksCache.inflight = null })
    .then(() => sendCached(res))
}

function sendCached(res) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(tasksCache.body || '{"root":' + JSON.stringify(LOG_ROOT) + ',"tasks":[]}')
}

// First-N-bytes variant of /file: same validation, reads only the head of the
// file (enough for `pyc.base = "..."` / first `func.func @name` detection).
const HEAD_DEFAULT = 1200
const HEAD_MAX = 4096

function resolveInLogRoot(task, file) {
  if (task.includes('..') || file.includes('..')) return null
  const base = resolve(LOG_ROOT, normalize(task))
  const full = resolve(base, normalize(file))
  if (!full.startsWith(resolve(LOG_ROOT) + sep) || !full.startsWith(base + sep)) return null
  if (!full.endsWith('.mlir')) return null
  return full
}

async function handleHead(res, url) {
  const full = resolveInLogRoot(url.searchParams.get('task') ?? '', url.searchParams.get('path') ?? '')
  if (!full) return json(res, 403, { error: 'path escapes log root' })
  const n = Math.min(Math.max(Number(url.searchParams.get('n')) || HEAD_DEFAULT, 1), HEAD_MAX)
  try {
    const fh = await open(full, 'r')
    try {
      const buf = Buffer.alloc(n)
      const { bytesRead } = await fh.read(buf, 0, n, 0)
      json(res, 200, { path: url.searchParams.get('path'), text: buf.subarray(0, bytesRead).toString('utf-8') })
    } finally { await fh.close() }
  } catch (e) {
    json(res, 404, { error: String(e) })
  }
}

// Same containment rules as vite.config.ts: resolved path must stay inside
// LOG_ROOT/<task>/ and only .mlir files are readable.
async function handleFile(req, res, url) {
  const task = url.searchParams.get('task') ?? ''
  const file = url.searchParams.get('path') ?? ''
  if (task.includes('..') || file.includes('..')) return json(res, 403, { error: 'path escapes log root' })
  const base = resolve(LOG_ROOT, normalize(task))
  const full = resolve(base, normalize(file))
  if (!full.startsWith(resolve(LOG_ROOT) + sep) || !full.startsWith(base + sep)) {
    return json(res, 403, { error: 'path escapes log root' })
  }
  if (!full.endsWith('.mlir')) return json(res, 400, { error: 'only .mlir files' })
  try {
    const text = await readFile(full, 'utf-8')
    json(res, 200, { path: file, text })
  } catch (e) {
    json(res, 404, { error: String(e) })
  }
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname)
  if (rel.endsWith('/')) rel += 'index.html'
  const full = resolve(DIST, '.' + (rel.startsWith('/') ? rel : '/' + rel))
  if (!full.startsWith(DIST + sep)) { res.writeHead(403); return res.end('forbidden') }
  if (!existsSync(full) || !statSyncIsFile(full)) {
    // SPA fallback
    const index = join(DIST, 'index.html')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return createReadStream(index).pipe(res)
  }
  const hashed = /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(full)
  res.writeHead(200, {
    'Content-Type': MIME[extname(full)] || 'application/octet-stream',
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  createReadStream(full).pipe(res)
}

function statSyncIsFile(p) { try { return statSync(p).isFile() } catch { return false } }

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname === '/api/autoperf/tasks') return handleTasks(res)
  if (url.pathname === '/api/autoperf/file') return handleFile(req, res, url)
  if (url.pathname === '/api/autoperf/head') return handleHead(res, url)
  if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' })
  serveStatic(req, res, url.pathname)
}).listen(PORT, () => console.log(`pycircuit-graph serving ${DIST} + logs ${LOG_ROOT} on :${PORT}`))
