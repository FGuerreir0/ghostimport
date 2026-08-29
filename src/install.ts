// Parses package-manager install commands so the agent hook can vet package names
// *before* npm runs them — the point at which a postinstall script would fire.

// npm tolerates a long list of aliases and typos for `install`
const NPM_INSTALL = new Set([
  'install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta',
  'isntal', 'isntall', 'add',
])
const YARN_INSTALL = new Set(['add'])
const PNPM_INSTALL = new Set(['add', 'install', 'i'])
const BUN_INSTALL = new Set(['add', 'install', 'i'])

const MANAGERS: Record<string, Set<string>> = {
  npm: NPM_INSTALL,
  pnpm: PNPM_INSTALL,
  yarn: YARN_INSTALL,
  bun: BUN_INSTALL,
}

const VALID_SEGMENT = /^[a-z0-9_][a-z0-9._-]*$/

/** Split a shell line into the individual commands a package manager could appear in. */
function splitCommands(command: string): string[] {
  return command.split(/&&|\|\||[;\n|]/g).map(s => s.trim()).filter(Boolean)
}

function tokenize(segment: string): string[] {
  const tokens: string[] = []
  // Keep quoted spans intact so `npm i "left-pad"` still yields a clean name
  for (const m of segment.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    tokens.push(m[1] ?? m[2] ?? m[3])
  }
  return tokens
}

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
  if (/^(github|gitlab|bitbucket|gist):/i.test(spec)) return null
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

/**
 * Extract the registry packages a shell command would install.
 *
 * Returns `[]` for commands that install nothing new (`npm install` with no args,
 * `npm ci`, `yarn`), and for non-install commands.
 */
export function extractInstallTargets(command: string): string[] {
  const found = new Set<string>()

  for (const segment of splitCommands(command)) {
    const tokens = tokenize(segment)
    if (tokens.length < 2) continue

    // Tolerate `sudo npm i x` and `npx -y npm i x`
    let idx = 0
    while (idx < tokens.length && (tokens[idx] === 'sudo' || tokens[idx] === 'command')) idx++

    const bin = (tokens[idx] ?? '').replace(/\.(cmd|exe)$/i, '').toLowerCase()
    const subcommands = MANAGERS[bin]
    if (!subcommands) continue

    // Skip global flags that precede the subcommand (`npm --prefix ./x install y`)
    let sub = idx + 1
    while (sub < tokens.length && tokens[sub].startsWith('-')) sub++
    if (!subcommands.has((tokens[sub] ?? '').toLowerCase())) continue

    for (const token of tokens.slice(sub + 1)) {
      const name = specToPackageName(token)
      if (name) found.add(name)
    }
  }

  return [...found]
}
