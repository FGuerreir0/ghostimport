const IMPORT_PATTERNS: RegExp[] = [
  /import\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'".\n][^'"]*)['"]/g,
  /require\s*\(\s*['"]([^'".\n][^'"]*)['"]\s*\)/g,
  /import\s*\(\s*['"]([^'".\n][^'"]*)['"]\s*\)/g,
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

function isBuiltin(name: string): boolean {
  if (name.startsWith('node:')) return true
  return BUILTIN_MODULES.has(name)
}

function toPackageName(importPath: string): string | null {
  // Path aliases: @/, ~/, #imports, $lib/ (SvelteKit)
  if (importPath.startsWith('@/') || importPath.startsWith('~/') || importPath.startsWith('#') || importPath.startsWith('$')) {
    return null
  }
  // URL/protocol imports
  if (/^[a-z][a-z0-9+.-]*:/i.test(importPath)) {
    return null
  }
  // Virtual modules (Vite/Rollup)
  if (importPath.startsWith('\0') || importPath.startsWith('virtual:')) {
    return null
  }
  if (importPath.startsWith('@')) {
    const parts = importPath.split('/')
    if (parts.length < 2) return null
    return `${parts[0]}/${parts[1]}`
  }
  return importPath.split('/')[0]
}

export function extractImports(code: string): string[] {
  const found = new Set<string>()
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
