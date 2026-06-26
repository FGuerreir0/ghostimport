import fs from 'fs'
import path from 'path'

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.cache'])
const CODE_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'])

export function walkFiles(dir: string): string[] {
  const results: string[] = []

  function walk(current: string): void {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(current, entry.name))
      } else if (entry.isFile()) {
        if (CODE_EXTS.has(path.extname(entry.name))) results.push(path.join(current, entry.name))
      }
    }
  }

  walk(dir)
  return results
}

export function readPackageJsonDeps(dir: string): Set<string> {
  const pkgPath = path.join(dir, 'package.json')
  if (!fs.existsSync(pkgPath)) return new Set()
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    return new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ])
  } catch {
    return new Set()
  }
}

export function readWorkspacePackages(dir: string): Set<string> {
  const names = new Set<string>()

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      workspaces?: string[] | { packages?: string[] }
    }
    const workspaces = Array.isArray(pkg.workspaces)
      ? pkg.workspaces
      : (pkg.workspaces?.packages ?? [])

    for (const pattern of workspaces) {
      const base = pattern.replace(/\/?\*$/, '')
      const wsDir = path.join(dir, base)
      if (!fs.existsSync(wsDir)) continue
      for (const entry of fs.readdirSync(wsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const wsPkgPath = path.join(wsDir, entry.name, 'package.json')
        if (!fs.existsSync(wsPkgPath)) continue
        try {
          const wsPkg = JSON.parse(fs.readFileSync(wsPkgPath, 'utf8')) as { name?: string }
          if (wsPkg.name) names.add(wsPkg.name)
        } catch { /* skip */ }
      }
    }
  } catch { /* not a monorepo */ }

  // Check pnpm-workspace.yaml
  const pnpmPath = path.join(dir, 'pnpm-workspace.yaml')
  if (!fs.existsSync(pnpmPath)) return names

  try {
    const content = fs.readFileSync(pnpmPath, 'utf8')
    for (const m of content.matchAll(/- ['"]?([^'"\n]+)['"]?/g)) {
      const base = m[1].replace(/\/?\*$/, '')
      const wsDir = path.join(dir, base)
      if (!fs.existsSync(wsDir)) continue
      for (const entry of fs.readdirSync(wsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const wsPkgPath = path.join(wsDir, entry.name, 'package.json')
        if (!fs.existsSync(wsPkgPath)) continue
        try {
          const wsPkg = JSON.parse(fs.readFileSync(wsPkgPath, 'utf8')) as { name?: string }
          if (wsPkg.name) names.add(wsPkg.name)
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }

  return names
}

export function readTsconfigPaths(dir: string): Set<string> {
  const aliases = new Set<string>()
  const candidates = ['tsconfig.json', 'tsconfig.app.json', 'jsconfig.json']

  for (const name of candidates) {
    const configPath = path.join(dir, name)
    if (!fs.existsSync(configPath)) continue
    try {
      const raw = fs.readFileSync(configPath, 'utf8')
      // Strip single-line comments for JSON parsing
      const stripped = raw.replace(/\/\/.*$/gm, '')
      const config = JSON.parse(stripped) as {
        compilerOptions?: { paths?: Record<string, string[]> }
      }
      const paths = config.compilerOptions?.paths
      if (!paths) continue
      for (const key of Object.keys(paths)) {
        // Extract the prefix before * or / (e.g. "@components/*" → "@components")
        const prefix = key.replace(/\/\*$/, '').replace(/\*$/, '')
        if (prefix) aliases.add(prefix)
      }
    } catch { /* skip */ }
  }

  return aliases
}
