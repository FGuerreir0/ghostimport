// Capture group uses [^'"\r\n] to prevent cross-line matches on CRLF files
const IMPORT_PATTERNS: RegExp[] = [
  /import\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'".\r\n][^'"\r\n]*)['"]/g,
  /require\s*\(\s*['"]([^'".\r\n][^'"\r\n]*)['"]\s*\)/g,
  /import\s*\(\s*['"]([^'".\r\n][^'"\r\n]*)['"]\s*\)/g,
  /export\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'".\r\n][^'"\r\n]*)['"]/g,
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

// Valid npm package name segment: letters, digits, hyphens, underscores, dots
const VALID_PKG_NAME = /^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/

// Dots are legal in npm names (socket.io, uWebSockets.js), so a specifier is only
// rejected on an extension that no npm package could plausibly end in.
const NON_JS_EXT = /\.(dart|css|s[ac]ss|less|json|svg|png|jpe?g|gif|webp|avif|wasm|txt|md|ya?ml|toml|html?|py|rb|go|rs|java|php|sh)$/i

function isValidNpmName(name: string): boolean {
  return VALID_PKG_NAME.test(name)
}

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
    const scope = parts[0].slice(1)
    const name = parts[1]
    if (!isValidNpmName(scope) || !isValidNpmName(name)) return null
    return `${parts[0]}/${parts[1]}`
  }
  const name = importPath.split('/')[0]
  if (NON_JS_EXT.test(name)) return null
  return isValidNpmName(name) ? name : null
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
