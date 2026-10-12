import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { readFile, open } from 'node:fs/promises'
import { readdirSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

const LOG_ROOT = process.env.AUTO_PERF_LOG_DIR || '/tmp/auto_perf_logs'

function findMlirFiles(dir: string, base: string, out: string[], depth = 0): void {
  if (depth > 4) return
  for (const name of readdirSyncSafe(dir)) {
    const full = join(dir, name)
    const rel = join(base, name)
    const st = statSyncSafe(full)
    if (!st) continue
    if (st.isDirectory()) findMlirFiles(full, rel, out, depth + 1)
    else if (name.endsWith('.mlir')) out.push(rel.split(sep).join('/'))
  }
}

function readdirSyncSafe(dir: string): string[] {
  try { return readdirSync(dir) } catch { return [] }
}

function statSyncSafe(p: string) {
  try { return statSync(p) } catch { return null }
}

type Middleware = (req: any, res: any, next: () => void) => void

// REST-ish API over the auto_perf log root so the browser can browse tasks
// and fetch dumped pass IR files. Paths are validated to stay under LOG_ROOT.
// Shared by dev server and production preview so both serve the task panel.
function autoPerfMiddleware(req: any, res: any, next: () => void): void {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (!url.pathname.startsWith('/api/autoperf/')) return next()

  const json = (code: number, body: unknown) => {
    res.statusCode = code
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(body))
  }

  if (url.pathname === '/api/autoperf/tasks') {
    let entries: string[] = []
    try { entries = readdirSyncSafe(LOG_ROOT) } catch { /* root missing */ }
    const tasks = []
    for (const name of entries.filter((e) => e.startsWith('task-')).sort().reverse()) {
      const dir = join(LOG_ROOT, name)
      const st = statSyncSafe(dir)
      if (!st?.isDirectory()) continue
      const files: string[] = []
      findMlirFiles(dir, '', files)
      const s = statSyncSafe(join(dir, 'result.json'))
      tasks.push({
        name,
        mtime: st.mtimeMs,
        hasResult: !!s,
        files,
      })
    }
    return json(200, { root: LOG_ROOT, tasks })
  }

  if (url.pathname === '/api/autoperf/file' || url.pathname === '/api/autoperf/head') {
    const task = url.searchParams.get('task') ?? ''
    const file = url.searchParams.get('path') ?? ''
    const base = resolve(LOG_ROOT, task)
    const full = resolve(base, file)
    if (!full.startsWith(resolve(LOG_ROOT) + sep) || !full.startsWith(base + sep)) {
      return json(403, { error: 'path escapes log root' })
    }
    if (!full.endsWith('.mlir')) return json(400, { error: 'only .mlir files' })
    if (url.pathname === '/api/autoperf/head') {
      // read only the first N bytes (module-name detection needs just the head)
      const n = Math.min(Math.max(Number(url.searchParams.get('n')) || 1200, 1), 4096)
      open(full, 'r').then(async (fh) => {
        try {
          const buf = Buffer.alloc(n)
          const { bytesRead } = await fh.read(buf, 0, n, 0)
          json(200, { path: file, text: buf.subarray(0, bytesRead).toString('utf-8') })
        } finally { await fh.close() }
      }).catch((e) => json(404, { error: String(e) }))
      return
    }
    readFile(full, 'utf-8')
      .then((text) => json(200, { path: file, text }))
      .catch((e) => json(404, { error: String(e) }))
    return
  }

  next()
}

function autoPerfApi(): Plugin {
  return {
    name: 'auto-perf-api',
    configureServer(server) {
      server.middlewares.use(autoPerfMiddleware as Middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(autoPerfMiddleware as Middleware)
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), autoPerfApi()],
})
