// Finds every registry package a shell command would fetch — to install it, or to
// download and run it on the spot (`npx`, `pnpm dlx`, `npm create`, `bunx`).
//
// The second kind matters as much as the first: `npx <name>` executes the package's
// bin immediately, no postinstall needed. A hallucinated name spread this way in
// 2026 (react-codeshift), through agent skills that told the agent to run it.

import fs from 'fs'
import path from 'path'
import { splitCommands, stripPrefixes, inlineShellScript, binName } from './shell'
import type { ShellDialect } from './shell'

export type CommandAction = 'install' | 'exec'

export interface CommandTarget {
  ecosystem: 'npm'
  /** Registry package name, version stripped. */
  name: string
  /** `install` adds it to the project; `exec` downloads it and runs its bin now. */
  action: CommandAction
  /**
   * `exec` only: the package is fetched whatever is installed locally (`dlx`, `create`,
   * `--package`, an explicit version). When false, a local bin of the same name wins.
   */
  pinned: boolean
  /** `exec` only: the bin that would run, when it differs from the package or matters. */
  bin?: string
  /** The command form that produced it, e.g. `npx`, `pnpm dlx`, `npm create`. */
  via: string
}

export interface ExtractOptions {
  /**
   * Working directory. When given, an unpinned `npx tsc` whose bin already exists in
   * `node_modules/.bin` (here or in a parent) is dropped — it runs the local copy.
   */
  cwd?: string
  /** Quoting rules for the command line. `powershell` for the PowerShell tool. Default `posix`. */
  dialect?: ShellDialect
}

// ─── Package-manager grammar ─────────────────────────────────────────────────

// npm tolerates a long list of aliases and typos for `install`
const NPM_INSTALL = new Set([
  'install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta',
  'isntal', 'isntall', 'add',
])
const NPM_EXEC = new Set(['exec', 'x'])
const NPM_CREATE = new Set(['create', 'init', 'innit'])

interface Grammar {
  install: Set<string>
  exec: Set<string>
  create: Set<string>
}

const GRAMMARS: Record<string, Grammar> = {
  npm: { install: NPM_INSTALL, exec: NPM_EXEC, create: NPM_CREATE },
  // `pnpm exec` and `yarn exec` only run binaries already installed locally
  pnpm: { install: new Set(['add', 'install', 'i']), exec: new Set(['dlx']), create: new Set(['create']) },
  yarn: { install: new Set(['add']), exec: new Set(['dlx']), create: new Set(['create']) },
  bun: { install: new Set(['add', 'install', 'i']), exec: new Set(['x']), create: new Set(['create']) },
}

// Global options that take a value, so the value is not mistaken for the subcommand
const GLOBAL_VALUE_FLAGS = new Set([
  '--prefix', '-C', '--dir', '--cwd', '--registry', '--cache', '--userconfig',
  '-w', '--workspace', '--filter', '-F', '--loglevel',
])

// Exec options that take a value. `-p`/`--package` and `-c`/`--call` are handled apart.
const EXEC_VALUE_FLAGS = new Set([
  '--registry', '--cache', '--prefix', '--userconfig', '-w', '--workspace',
  '--node-options', '--script-shell', '--shell', '--scope', '--loglevel', '-C', '--cwd',
])

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'npx', 'pnpx', 'bunx'])

const MAX_DEPTH = 3

// ─── Entry ───────────────────────────────────────────────────────────────────

/** Every registry package the command would install or run, de-duplicated. */
export function extractCommandTargets(command: string, opts: ExtractOptions = {}): CommandTarget[] {
  const found = new Map<string, CommandTarget>()
  for (const t of parseLine(command, 0, opts.dialect)) {
    if (opts.cwd && t.action === 'exec' && !t.pinned && hasLocalBin(t.bin ?? binOf(t.name), opts.cwd)) continue
    const key = `${t.action}:${t.name}`
    if (!found.has(key)) found.set(key, t)
  }
  return [...found.values()]
}

function parseLine(command: string, depth: number, dialect: ShellDialect = 'posix'): CommandTarget[] {
  if (depth > MAX_DEPTH) return []
  const out: CommandTarget[] = []
  for (const raw of splitCommands(command, dialect)) out.push(...parseTokens(stripPrefixes(raw), depth))
  return out
}

function parseTokens(tokens: string[], depth: number): CommandTarget[] {
  if (tokens.length === 0) return []

  const inline = inlineShellScript(tokens)
  if (inline !== null) return parseLine(inline.script, depth + 1, inline.dialect)

  const bin = binName(tokens[0])
  const args = tokens.slice(1)

  switch (bin) {
    case 'npx': return parseExec(args, 'npx', false, depth)
    case 'pnpx': return parseExec(args, 'pnpx', true, depth)
    case 'bunx': return parseExec(args, 'bunx', false, depth)
  }

  const grammar = GRAMMARS[bin]
  if (!grammar) return []

  let sub = 0
  while (sub < args.length && args[sub].startsWith('-')) {
    sub += GLOBAL_VALUE_FLAGS.has(args[sub]) ? 2 : 1
  }
  const subcommand = (args[sub] ?? '').toLowerCase()
  const rest = args.slice(sub + 1)

  if (grammar.install.has(subcommand)) {
    return registryNames(rest).map(name => ({ ecosystem: 'npm', name, action: 'install', pinned: true, via: `${bin} ${subcommand}` }))
  }
  if (grammar.exec.has(subcommand)) {
    // `dlx` always fetches; `npm exec` / `bun x` prefer a local bin, like npx
    return parseExec(rest, `${bin} ${subcommand}`, subcommand === 'dlx', depth)
  }
  if (grammar.create.has(subcommand)) {
    return parseCreate(rest, bin, subcommand)
  }
  return []
}

// ─── install ─────────────────────────────────────────────────────────────────

const VALID_SEGMENT = /^[a-z0-9_][a-z0-9._-]*$/

/**
 * Reduce an install spec to the registry package it resolves to,
 * or null if it is not a registry install at all (path, tarball, git, URL).
 */
export function specToPackageName(spec: string): string | null {
  if (!spec || spec.startsWith('-')) return null

  // yarn/npm alias syntax: `local-name@npm:real-package@1.0.0` installs `real-package`
  const aliasAt = spec.indexOf('@npm:')
  if (aliasAt !== -1) return specToPackageName(spec.slice(aliasAt + 5))

  // Not a registry spec: paths, URLs, git refs, tarballs, GitHub shorthand
  if (/^[./~]/.test(spec)) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) return null
  if (/\.(tgz|tar\.gz)$/i.test(spec)) return null

  let name = spec
  if (name.startsWith('@')) {
    const at = name.indexOf('@', 1)
    if (at !== -1) name = name.slice(0, at)
  } else {
    const at = name.indexOf('@')
    if (at !== -1) name = name.slice(0, at)
  }

  if (name.startsWith('@')) {
    const parts = name.slice(1).split('/')
    if (parts.length !== 2) return null
    if (!VALID_SEGMENT.test(parts[0].toLowerCase()) || !VALID_SEGMENT.test(parts[1].toLowerCase())) return null
    return name
  }

  // A bare `user/repo` with no scope is GitHub shorthand, not a registry package
  if (name.includes('/')) return null
  return VALID_SEGMENT.test(name.toLowerCase()) ? name : null
}

function registryNames(tokens: string[]): string[] {
  const names: string[] = []
  for (const token of tokens) {
    const name = specToPackageName(token)
    if (name) names.push(name)
  }
  return names
}

// ─── exec: npx, npm exec, pnpm dlx, yarn dlx, bunx ───────────────────────────

function parseExec(args: string[], via: string, alwaysFetch: boolean, depth: number): CommandTarget[] {
  const out: CommandTarget[] = []
  const packages: string[] = []
  const calls: string[] = []
  let positional: number | null = null

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') { positional = i + 1 < args.length ? i + 1 : null; break }
    if (a === '-p' || a === '--package') { if (args[i + 1]) packages.push(args[i + 1]); i++; continue }
    if (a.startsWith('--package=')) { packages.push(a.slice('--package='.length)); continue }
    // `-c` is npm's --call; for pnpm dlx it is a boolean (shell mode) — treat it as a call
    // only when a value follows that is not itself a flag
    if (a === '--call' || (a === '-c' && args[i + 1] && !args[i + 1].startsWith('-'))) {
      if (args[i + 1]) calls.push(args[i + 1]); i++; continue
    }
    if (a.startsWith('--call=')) { calls.push(a.slice('--call='.length)); continue }
    if (EXEC_VALUE_FLAGS.has(a)) { i++; continue }
    if (a.startsWith('-')) continue
    positional = i
    break
  }

  for (const spec of packages) {
    const name = specToPackageName(spec)
    if (name) out.push({ ecosystem: 'npm', name, action: 'exec', pinned: true, via })
  }

  // With --package, the positional names the bin to run, not a package
  if (positional !== null && packages.length === 0) {
    const spec = args[positional]
    const name = specToPackageName(spec)
    if (name) {
      out.push({
        ecosystem: 'npm',
        name,
        action: 'exec',
        pinned: alwaysFetch || hasVersion(spec),
        bin: binOf(name),
        via,
      })
      // `npx -y npm i left-pad`: the package being run is itself a package manager
      if (PACKAGE_MANAGERS.has(name) && depth < MAX_DEPTH) {
        out.push(...parseTokens(args.slice(positional), depth + 1))
      }
    }
  }

  for (const call of calls) out.push(...parseLine(call, depth + 1))
  return out
}

function hasVersion(spec: string): boolean {
  return spec.lastIndexOf('@') > 0
}

/** The bin a package most likely exposes: its name without the scope. */
function binOf(name: string): string {
  return name.startsWith('@') ? (name.split('/')[1] ?? name) : name
}

/** Is `bin` installed in `node_modules/.bin` here or in any parent directory? */
export function hasLocalBin(bin: string, cwd: string): boolean {
  let dir = path.resolve(cwd)
  for (;;) {
    const binDir = path.join(dir, 'node_modules', '.bin')
    for (const candidate of [bin, `${bin}.cmd`]) {
      try {
        if (fs.existsSync(path.join(binDir, candidate))) return true
      } catch { /* unreadable: keep looking */ }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

// ─── create: npm create / npm init <x>, pnpm/yarn/bun create ─────────────────

const INIT_VALUE_FLAGS = new Set(['--scope', '-w', '--workspace', '--init-module'])

function parseCreate(args: string[], manager: string, subcommand: string): CommandTarget[] {
  let initializer: string | null = null
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') break
    if (INIT_VALUE_FLAGS.has(a)) { i++; continue }
    if (a.startsWith('-')) continue
    initializer = a
    break
  }
  // `npm init` / `npm init -y` with no initializer just writes a package.json
  if (!initializer) return []

  const name = createPackageName(initializer, manager)
  if (!name) return []
  return [{ ecosystem: 'npm', name, action: 'exec', pinned: true, bin: binOf(name), via: `${manager} ${subcommand}` }]
}

/**
 * The package an initializer resolves to, following npm's rule:
 * `foo` → `create-foo`, `@usr` → `@usr/create`, `@usr/foo` → `@usr/create-foo`.
 * pnpm leaves a name that already starts with `create-` as it is.
 * Paths, URLs and `user/repo` templates (bun) resolve to nothing on the registry.
 */
export function createPackageName(initializer: string, manager = 'npm'): string | null {
  if (/^[./~]/.test(initializer) || /^[a-z][a-z0-9+.-]*:/i.test(initializer)) return null

  if (initializer.startsWith('@')) {
    const at = initializer.indexOf('@', 1)
    const bare = at === -1 ? initializer : initializer.slice(0, at)
    const [scope, pkg] = bare.split('/')
    const name = pkg ? `${scope}/create-${pkg}` : `${scope}/create`
    return specToPackageName(name)
  }

  if (initializer.includes('/')) return null
  const bare = specToPackageName(initializer)
  if (!bare) return null
  if (manager === 'pnpm' && bare.startsWith('create-')) return bare
  return `create-${bare}`
}
