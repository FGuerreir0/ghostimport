import fs from 'fs'
import path from 'path'

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.cache',
  // Build output. Bundled vendor code here is not what anyone imported.
  '.next', '.nuxt', '.output', '.vercel', '.netlify', '.svelte-kit', '.turbo', '.astro', '.vite', '.parcel-cache',
])
export const CODE_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte', '.astro'])

const TSCONFIG_RE = /^(tsconfig|jsconfig)(\..+)?\.json$/
const IMPORT_MAP_FILES = new Set(['deno.json', 'deno.jsonc', 'import_map.json', 'importmap.json'])
// Import maps get named freely — react-hook-form ships one as `Imports.json`. Any
// candidate is shape-checked before it is trusted, so a loose name match is safe.
const IMPORT_MAP_RE = /^[\w.-]*imports?(map)?[\w.-]*\.json$/i
const IMPORT_MAP_KEYS = new Set(['imports', 'scopes', 'integrity'])

/**
 * Strip comments and trailing commas so `JSON.parse` accepts JSONC.
 *
 * Walks the text tracking string state, because a naive `//` strip eats the
 * protocol out of every `"https://..."` value — which is most of a Deno import map.
 */
function parseJsonc<T>(raw: string): T | null {
  let out = ''
  let inString = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    const next = raw[i + 1]
    if (inLine) {
      if (c === '\n') { inLine = false; out += c }
      continue
    }
    if (inBlock) {
      if (c === '*' && next === '/') { inBlock = false; i++ }
      continue
    }
    if (inString) {
      out += c
      // charCodeAt 92 is a backslash; written this way to keep the escape out of the source
      if (c.charCodeAt(0) === 92) { out += next ?? ''; i++ } else if (c === '"') inString = false
      continue
    }
    if (c === '"') { inString = true; out += c; continue }
    if (c === '/' && next === '/') { inLine = true; continue }
    if (c === '/' && next === '*') { inBlock = true; i++; continue }
    out += c
  }
  // Trailing commas
  out = out.replace(/,(\s*[}\]])/g, '$1')
  try { return JSON.parse(out) as T } catch { return null }
}

interface ProjectFiles {
  code: string[]
  packageJson: string[]
  tsconfig: string[]
  importMap: string[]
  denoDetected: boolean
}

/**
 * One traversal that collects both the source files to scan and the config files
 * that say which bare specifiers never reach npm.
 */
export function walkProject(dir: string, maxDepth = Infinity): ProjectFiles {
  const found: ProjectFiles = { code: [], packageJson: [], tsconfig: [], importMap: [], denoDetected: false }

  function walk(current: string, depth: number): void {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(entry.name)) walk(full, depth + 1)
      } else if (entry.isFile()) {
        const name = entry.name
        if (CODE_EXTS.has(path.extname(name))) found.code.push(full)
        else if (name === 'package.json') found.packageJson.push(full)
        else if (TSCONFIG_RE.test(name)) found.tsconfig.push(full)
        else if (IMPORT_MAP_FILES.has(name) || IMPORT_MAP_RE.test(name)) {
          found.importMap.push(full)
          if (name === 'deno.json' || name === 'deno.jsonc') found.denoDetected = true
        }
      }
    }
  }

  walk(dir, 0)
  return found
}

export function walkFiles(dir: string): string[] {
  return walkProject(dir).code
}

/**
 * Everything a project resolves without asking npm.
 *
 * A name that is missing from the registry is only interesting if nothing in the
 * repo already answers for it. Monorepo packages, path aliases, import maps and
 * framework namespaces all resolve through the bundler, so they are not findings.
 */
export interface ProjectContext {
  /** Declared in the `dependencies` of any package.json in the tree. */
  declared: Set<string>
  /** The `name` of any package.json in the tree — a local package, however it is laid out. */
  local: Set<string>
  /** Bare specifiers answered by a tsconfig path alias or an import map. */
  aliases: Set<string>
  /** Scopes a bundler resolves rather than the registry, e.g. Docusaurus `@theme/*`. */
  virtualScopes: Set<string>
}

interface PackageJsonShape {
  name?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

export function readProjectContext(dir: string, maxDepth?: number): ProjectContext {
  const files = walkProject(dir, maxDepth)
  return contextFromFiles(files, dir)
}

export function contextFromFiles(files: ProjectFiles, _dir: string): ProjectContext {
  const declared = new Set<string>()
  const local = new Set<string>()
  const aliases = new Set<string>()
  const virtualScopes = new Set<string>()

  for (const file of files.packageJson) {
    let pkg: PackageJsonShape | null
    try { pkg = parseJsonc<PackageJsonShape>(fs.readFileSync(file, 'utf8')) } catch { continue }
    if (!pkg) continue
    if (pkg.name) local.add(pkg.name)
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      for (const name of Object.keys(pkg[field] ?? {})) declared.add(name)
    }
  }

  for (const file of files.tsconfig) {
    let conf: { compilerOptions?: { paths?: Record<string, string[]> } } | null
    try { conf = parseJsonc(fs.readFileSync(file, 'utf8')) } catch { continue }
    for (const key of Object.keys(conf?.compilerOptions?.paths ?? {})) {
      const prefix = key.replace(/\/\*$/, '').replace(/\*$/, '').replace(/\/$/, '')
      if (prefix) aliases.add(prefix)
    }
  }

  for (const file of files.importMap) {
    let map: { imports?: Record<string, string> } | null
    try { map = parseJsonc(fs.readFileSync(file, 'utf8')) } catch { continue }
    if (!map || typeof map !== 'object' || !map.imports) continue
    // A real import map carries nothing but imports/scopes/integrity. Anything else
    // is some other JSON file that happens to be called Imports.json.
    const known = path.basename(file)
    if (!IMPORT_MAP_FILES.has(known) && !Object.keys(map).every(k => IMPORT_MAP_KEYS.has(k))) continue
    for (const key of Object.keys(map.imports)) {
      const prefix = key.replace(/\/$/, '')
      if (prefix && !prefix.startsWith('.')) aliases.add(prefix)
    }
  }

  // Docusaurus resolves @theme/*, @site/* and a set of @docusaurus/* aliases through
  // its own bundler; only the published @docusaurus packages come from npm.
  for (const name of declared) {
    if (name.startsWith('@docusaurus/')) {
      virtualScopes.add('@theme').add('@site').add('@docusaurus')
      break
    }
  }
  // Deno projects import from JSR, which is not the npm registry.
  if (files.denoDetected) virtualScopes.add('@std').add('@deno')

  return { declared, local, aliases, virtualScopes }
}

/** Does anything in the project already answer for this bare specifier? */
export function isResolvedLocally(pkg: string, ctx: ProjectContext): boolean {
  if (ctx.local.has(pkg) || ctx.aliases.has(pkg)) return true
  // A scoped import matches an alias or virtual scope recorded as its first segment,
  // e.g. the alias "@commands" answers the import "@commands/types".
  const scope = pkg.split('/')[0]
  return ctx.aliases.has(scope) || ctx.virtualScopes.has(scope)
}

export function readPackageJsonDeps(dir: string): Set<string> {
  const pkgPath = path.join(dir, 'package.json')
  if (!fs.existsSync(pkgPath)) return new Set()
  const pkg = parseJsonc<PackageJsonShape>(fs.readFileSync(pkgPath, 'utf8'))
  if (!pkg) return new Set()
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ])
}
