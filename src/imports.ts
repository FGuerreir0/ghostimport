// Capture group uses [^'"\r\n] to prevent cross-line matches on CRLF files.
// The lookbehind keeps `bundle.require("x")` and `loader.import("x")` out: a method
// that happens to be called require is not a module load.
const IMPORT_PATTERNS: RegExp[] = [
  /(?<![\w$.])import\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'".\r\n][^'"\r\n]*)['"]/g,
  /(?<![\w$.])require\s*\(\s*['"]([^'".\r\n][^'"\r\n]*)['"]\s*\)/g,
  /(?<![\w$.])import\s*\(\s*['"]([^'".\r\n][^'"\r\n]*)['"]\s*\)/g,
  /(?<![\w$.])export\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'".\r\n][^'"\r\n]*)['"]/g,
]

// A string literal is kept only where a module specifier can stand.
const SPECIFIER_CONTEXT = /(?:(?<![\w$.])(?:from|import|export)|(?<![\w$.])(?:require|import)\s*\()\s*$/
// After one of these, a `/` starts a regex literal rather than a division.
const REGEX_PRECEDER = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|(?<![\w$])(?:return|typeof|case|do|else|in|of|void|yield|await|delete|throw|new))\s*$/

/**
 * Blank out everything that cannot hold an import: comments, template literals and
 * the contents of strings that aren't in specifier position. Offsets and newlines are
 * kept, so the patterns above still see real imports exactly where they were.
 *
 * Without this, `// import x from 'old-pkg'`, a JSDoc usage example, or code inside a
 * template string (`esbuild({ stdin: { contents: \`export * from 'fixture'\` } })`)
 * all read as imports.
 */
export function stripNonCode(code: string): string {
  const out: string[] = []
  const blank = (s: string) => s.replace(/[^\n]/g, ' ')
  // Template literal nesting: each entry is the brace depth at which a `${` opened.
  const templates: number[] = []
  let depth = 0
  let i = 0
  const n = code.length

  // The output just before the current position, holding at least `len` non-blank
  // characters. Whitespace is pushed a character at a time, so a fixed number of
  // entries can be nothing but the indentation before `'pkg'` on its own line.
  const tail = (len: number): string => {
    let s = ''
    for (let k = out.length - 1; k >= 0 && k >= out.length - 400; k--) {
      s = out[k] + s
      if (s.replace(/\s+/g, '').length >= len) break
    }
    return s
  }

  const readTemplateBody = () => {
    // Inside a template literal, up to the closing backtick or a `${`.
    let j = i
    while (j < n) {
      const c = code[j]
      if (c === '\\') { j += 2; continue }
      if (c === '`') break
      if (c === '$' && code[j + 1] === '{') break
      j++
    }
    out.push(blank(code.slice(i, j)))
    i = j
    if (code[i] === '`') { out.push('`'); i++ }
    else if (i < n) { out.push('${'); i += 2; templates.push(depth); depth++ }
  }

  while (i < n) {
    const c = code[i]
    const next = code[i + 1]
    if (c === '/' && next === '/') {
      const end = code.indexOf('\n', i)
      const stop = end === -1 ? n : end
      out.push(blank(code.slice(i, stop)))
      i = stop
    } else if (c === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      out.push(blank(code.slice(i, stop)))
      i = stop
    } else if (c === '`') {
      out.push('`'); i++
      readTemplateBody()
    } else if (c === '}' && templates.length && templates[templates.length - 1] === depth - 1) {
      templates.pop(); depth--
      out.push('}'); i++
      readTemplateBody()
    } else if (c === "'" || c === '"') {
      // Strings never span lines (a line continuation aside), so a stray apostrophe in
      // JSX text can only blank the rest of its own line.
      let j = i + 1
      while (j < n && code[j] !== c && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1
      const body = code.slice(i + 1, Math.min(j, n))
      const keep = SPECIFIER_CONTEXT.test(tail(40))
      out.push(c, keep ? body : blank(body))
      if (code[j] === c) out.push(c)
      i = code[j] === c ? j + 1 : j
    } else if (c === '/' && REGEX_PRECEDER.test(tail(20))) {
      // Regex literal: skip it so a quote inside /['"]/ doesn't open a fake string.
      let j = i + 1
      let inClass = false
      while (j < n && code[j] !== '\n') {
        const d = code[j]
        if (d === '\\') { j += 2; continue }
        if (d === '[') inClass = true
        else if (d === ']') inClass = false
        else if (d === '/' && !inClass) break
        j++
      }
      if (code[j] === '/') { out.push(blank(code.slice(i, j + 1))); i = j + 1 }
      else { out.push(c); i++ } // not a regex after all
    } else {
      if (c === '{') depth++
      else if (c === '}') depth--
      out.push(c); i++
    }
  }
  return out.join('')
}

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

// `import type X from`, `import type { A } from`, `export type * from`. Not
// `import type from 'x'`, which is a default import named `type`. Inline
// `import { type A }` is left out: under `verbatimModuleSyntax` it still emits the import.
const TYPE_ONLY = /^(?:import|export)\s+type(?:\s*[{*]|\s+(?!from\b)[\w$])/

/**
 * Every package a source file imports, mapped to whether any of those imports loads
 * it at runtime. `false` means only type-only imports name it, which TypeScript erases.
 */
export function extractImportKinds(source: string): Map<string, boolean> {
  const code = stripNonCode(source)
  const found = new Map<string, boolean>()
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(code)) !== null) {
      const raw = match[1]
      const pkg = toPackageName(raw)
      if (pkg && !isBuiltin(raw) && !isBuiltin(pkg)) {
        const runtime = !TYPE_ONLY.test(match[0])
        found.set(pkg, (found.get(pkg) ?? false) || runtime)
      }
    }
  }
  return found
}

export function extractImports(source: string): string[] {
  return [...extractImportKinds(source).keys()]
}

/** A TypeScript declaration file: every import in it is type-only. */
export function isDeclarationFile(file: string): boolean {
  return /\.d\.[mc]?ts$/.test(file)
}
