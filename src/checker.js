import fs from 'fs'
import path from 'path'
import https from 'https'
import os from 'os'

// ─── Regex patterns to extract imports ──────────────────────────────────────

const IMPORT_PATTERNS = [
  // import x from 'pkg'
  /import\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'".\n][^'"]*)['"]/g,
  // require('pkg')
  /require\s*\(\s*['"]([^'".\n][^'"]*)['"]\s*\)/g,
  // import('pkg')
  /import\s*\(\s*['"]([^'".\n][^'"]*)['"]\s*\)/g,
  // export ... from 'pkg'
  /export\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'".\n][^'"]*)['"]/g,
]

const BUILTIN_MODULES = new Set([
  'assert', 'assert/strict', 'async_hooks', 'buffer', 'child_process',
  'cluster', 'console', 'constants', 'crypto', 'dgram',
  'diagnostics_channel', 'dns', 'dns/promises', 'domain', 'events', 'fs',
  'fs/promises', 'http', 'http2', 'https', 'inspector', 'inspector/promises',
  'module', 'net', 'os', 'path', 'path/posix', 'path/win32', 'perf_hooks',
  'process', 'punycode', 'querystring', 'readline', 'readline/promises',
  'repl', 'sea', 'stream', 'stream/consumers', 'stream/promises',
  'stream/web', 'string_decoder', 'sys', 'test', 'timers', 'timers/promises',
  'tls', 'trace_events', 'tty', 'url', 'util', 'util/types', 'v8', 'vm',
  'wasi', 'worker_threads', 'zlib',
])

// ─── Extract package name from import path ───────────────────────────────────

function isBuiltin(name) {
  if (name.startsWith('node:')) return true
  return BUILTIN_MODULES.has(name)
}

function toPackageName(importPath) {
  if (importPath.startsWith('@')) {
    // scoped: @scope/name(/...rest)
    const parts = importPath.split('/')
    if (parts.length < 2) return null
    return `${parts[0]}/${parts[1]}`
  }
  // regular: name(/...rest)
  return importPath.split('/')[0]
}

// ─── Extract all imports from a file ─────────────────────────────────────────

export function extractImports(code) {
  const found = new Set()
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(code)) !== null) {
      const raw = match[1]
      const pkg = toPackageName(raw)
      if (pkg && !isBuiltin(raw) && !isBuiltin(pkg)) {
        found.add(pkg)
      }
    }
  }
  return [...found]
}

// ─── Cache ───────────────────────────────────────────────────────────────────

const CACHE_TTL = 24 * 60 * 60 * 1000 // 24 hours

function getCacheDir() {
  const dir = path.join(os.homedir(), '.ghostimport')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function getCachePath() {
  return path.join(getCacheDir(), 'registry-cache.json')
}

export function loadCache() {
  const cachePath = getCachePath()
  if (!fs.existsSync(cachePath)) return {}
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'))
  } catch {
    return {}
  }
}

export function saveCache(cache) {
  fs.writeFileSync(getCachePath(), JSON.stringify(cache, null, 2), 'utf8')
}

function getCached(cache, pkgName) {
  const entry = cache[pkgName]
  if (!entry) return null
  if (Date.now() - entry.ts > CACHE_TTL) return null
  return entry
}

// ─── Config ──────────────────────────────────────────────────────────────────

export function loadConfig(dir) {
  const defaults = { ignore: [], includeUndeclared: true }
  const configPath = path.join(dir, '.ghostimportrc.json')
  if (!fs.existsSync(configPath)) return defaults
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    return { ...defaults, ...raw }
  } catch {
    return defaults
  }
}

function matchesIgnore(pkg, patterns) {
  for (const pattern of patterns) {
    if (pattern === pkg) return true
    // Support wildcard: @scope/* matches any @scope/xxx
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -1)
      if (pkg.startsWith(prefix)) return true
    }
  }
  return false
}

// ─── Check if a package exists on npm ────────────────────────────────────────

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Accept: 'application/json' }, timeout: 8000 }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data)) } catch { reject(new Error('Invalid JSON')) }
        } else if (res.statusCode === 404) {
          resolve(null)
        } else {
          reject(new Error(`HTTP ${res.statusCode}`))
        }
      })
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.on('error', reject)
  })
}

export function checkNpm(pkgName) {
  return new Promise((resolve) => {
    const encoded = pkgName.startsWith('@')
      ? '@' + encodeURIComponent(pkgName.slice(1))
      : encodeURIComponent(pkgName)

    const options = {
      hostname: 'registry.npmjs.org',
      path: `/${encoded}`,
      method: 'GET',
      headers: { Accept: 'application/json' },
      timeout: 8000,
    }

    const req = https.request(options, (res) => {
      // Drain body to free socket
      res.resume()
      if (res.statusCode === 200) {
        resolve({ exists: true })
      } else if (res.statusCode === 404) {
        resolve({ exists: false })
      } else {
        resolve({ exists: null, error: `HTTP ${res.statusCode}` })
      }
    })

    req.on('timeout', () => {
      req.destroy()
      resolve({ exists: null, error: 'timeout' })
    })

    req.on('error', (err) => {
      resolve({ exists: null, error: err.message })
    })

    req.end()
  })
}

// ─── Scary mode: check package metadata for supply chain risk ────────────────

export async function checkScary(pkgName) {
  const encoded = pkgName.startsWith('@')
    ? '@' + encodeURIComponent(pkgName.slice(1))
    : encodeURIComponent(pkgName)

  try {
    // Get package metadata
    const meta = await httpGetJson(`https://registry.npmjs.org/${encoded}`)
    if (!meta) return { exists: false, squatRisk: 'available' }

    const created = meta.time?.created ? new Date(meta.time.created) : null
    const modified = meta.time?.modified ? new Date(meta.time.modified) : null
    const ageMs = created ? Date.now() - created.getTime() : Infinity
    const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24))

    // Get weekly downloads
    let downloads = null
    try {
      const dl = await httpGetJson(`https://api.npmjs.org/downloads/point/last-week/${encoded}`)
      downloads = dl?.downloads ?? null
    } catch { /* ignore */ }

    // Risk heuristics
    const flags = []
    if (ageDays < 30) flags.push(`created ${ageDays} days ago`)
    if (downloads !== null && downloads < 50) flags.push(`${downloads} weekly downloads`)
    if (meta.versions && Object.keys(meta.versions).length <= 1) flags.push('single version published')

    const risk = flags.length >= 2 ? 'high' : flags.length === 1 ? 'medium' : 'low'

    return {
      exists: true,
      created: created?.toISOString().slice(0, 10) ?? 'unknown',
      downloads,
      versions: meta.versions ? Object.keys(meta.versions).length : 0,
      risk,
      flags,
    }
  } catch (err) {
    return { exists: null, error: err.message }
  }
}

// ─── Read package.json dependencies ──────────────────────────────────────────

export function readPackageJsonDeps(dir) {
  const pkgPath = path.join(dir, 'package.json')
  if (!fs.existsSync(pkgPath)) return new Set()
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    return new Set([
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.devDependencies || {}),
      ...Object.keys(pkg.peerDependencies || {}),
      ...Object.keys(pkg.optionalDependencies || {}),
    ])
  } catch {
    return new Set()
  }
}

// ─── Read workspace packages (monorepo support) ──────────────────────────────

function readWorkspacePackages(dir) {
  const names = new Set()
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    const workspaces = Array.isArray(pkg.workspaces)
      ? pkg.workspaces
      : (pkg.workspaces?.packages || [])
    const patterns = Array.isArray(workspaces) ? workspaces : []
    for (const pattern of patterns) {
      // Simple glob: packages/* or apps/*
      const base = pattern.replace(/\/?\*$/, '')
      const wsDir = path.join(dir, base)
      if (!fs.existsSync(wsDir)) continue
      const entries = fs.readdirSync(wsDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const wsPkgPath = path.join(wsDir, entry.name, 'package.json')
        if (fs.existsSync(wsPkgPath)) {
          try {
            const wsPkg = JSON.parse(fs.readFileSync(wsPkgPath, 'utf8'))
            if (wsPkg.name) names.add(wsPkg.name)
          } catch { /* skip */ }
        }
      }
    }
  } catch { /* not a monorepo */ }

  // Also check pnpm-workspace.yaml
  const pnpmPath = path.join(dir, 'pnpm-workspace.yaml')
  if (fs.existsSync(pnpmPath)) {
    try {
      const content = fs.readFileSync(pnpmPath, 'utf8')
      const matches = content.matchAll(/- ['"]?([^'"\n]+)['"]?/g)
      for (const m of matches) {
        const base = m[1].replace(/\/?\*$/, '')
        const wsDir = path.join(dir, base)
        if (!fs.existsSync(wsDir)) continue
        const entries = fs.readdirSync(wsDir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const wsPkgPath = path.join(wsDir, entry.name, 'package.json')
          if (fs.existsSync(wsPkgPath)) {
            try {
              const wsPkg = JSON.parse(fs.readFileSync(wsPkgPath, 'utf8'))
              if (wsPkg.name) names.add(wsPkg.name)
            } catch { /* skip */ }
          }
        }
      }
    } catch { /* skip */ }
  }

  return names
}

// ─── Walk directory and collect JS/TS files ───────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.cache'])
const CODE_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'])

export function walkFiles(dir) {
  const results = []
  function walk(current) {
    let entries
    try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(current, entry.name))
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name)
        if (CODE_EXTS.has(ext)) results.push(path.join(current, entry.name))
      }
    }
  }
  walk(dir)
  return results
}

// ─── Main scan function ───────────────────────────────────────────────────────

export async function scan(targetDir, { onProgress, useCache = true, scary = false, config } = {}) {
  const conf = config || loadConfig(targetDir)
  const files = walkFiles(targetDir)
  const declaredDeps = readPackageJsonDeps(targetDir)
  const workspacePkgs = readWorkspacePackages(targetDir)

  // Load cache
  const cache = useCache ? loadCache() : {}
  let cacheHits = 0

  // Collect all unique imports across all files, with file references
  const importMap = new Map() // pkgName -> [files]
  for (const file of files) {
    let code
    try { code = fs.readFileSync(file, 'utf8') } catch { continue }
    const imports = extractImports(code)
    for (const pkg of imports) {
      if (!importMap.has(pkg)) importMap.set(pkg, [])
      importMap.get(pkg).push(path.relative(targetDir, file))
    }
  }

  // Filter ignored packages
  let allPkgs = [...importMap.keys()].filter(pkg => {
    if (matchesIgnore(pkg, conf.ignore)) return false
    if (workspacePkgs.has(pkg)) return false
    return true
  })

  const results = {
    scanned: files.length,
    packages: allPkgs.length,
    hallucinated: [],
    notInPackageJson: [],
    errors: [],
    scary: [],
    cacheHits: 0,
  }

  // Check each package concurrently (max 10 at a time)
  const CONCURRENCY = 10
  for (let i = 0; i < allPkgs.length; i += CONCURRENCY) {
    const batch = allPkgs.slice(i, i + CONCURRENCY)
    const checks = await Promise.all(batch.map(pkg => {
      const cached = getCached(cache, pkg)
      if (cached) {
        cacheHits++
        return Promise.resolve({ exists: cached.exists })
      }
      return checkNpm(pkg)
    }))

    for (let j = 0; j < batch.length; j++) {
      const pkg = batch[j]
      const { exists, error } = checks[j]
      const matchedFiles = importMap.get(pkg)

      // Update cache
      if (exists !== null && useCache) {
        cache[pkg] = { exists, ts: Date.now() }
      }

      if (onProgress) onProgress({ pkg, exists, error, total: allPkgs.length, done: i + j + 1 })

      if (exists === false) {
        results.hallucinated.push({ pkg, files: matchedFiles })
      } else if (exists === null && error) {
        results.errors.push({ pkg, error, files: matchedFiles })
      } else if (exists === true && !declaredDeps.has(pkg)) {
        results.notInPackageJson.push({ pkg, files: matchedFiles })
      }
    }
  }

  // Save cache
  if (useCache) saveCache(cache)
  results.cacheHits = cacheHits

  // Scary mode: deep check hallucinated packages + suspicious existing ones
  if (scary) {
    const scaryChecks = []

    // Check if hallucinated names are available for squatting
    for (const { pkg, files: matchedFiles } of results.hallucinated) {
      scaryChecks.push({ pkg, files: matchedFiles, type: 'available' })
    }

    // Check recently-published packages that might be squats
    for (const { pkg, files: matchedFiles } of results.notInPackageJson) {
      const info = await checkScary(pkg)
      if (info.exists && info.risk !== 'low') {
        scaryChecks.push({ pkg, files: matchedFiles, type: 'suspicious', ...info })
      }
    }

    results.scary = scaryChecks
  }

  return results
}