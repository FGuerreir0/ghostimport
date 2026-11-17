import { loadCache, saveCache, getCached } from './cache'
import { checkNpm, checkPackageRisk, checkScope, detectTyposquat, punctuationVariants } from './npm'
import type { CacheEntry, Claim, NpmCheckResult, PackageVerdict, VerifyOptions } from './types'

const CONCURRENCY = 10

/**
 * Does each name exist on npm? Through the registry cache; `null` when unreachable.
 * Mutates `cache`; the caller saves it.
 */
async function existsMany(
  names: string[],
  cache: Record<string, CacheEntry>,
  useCache: boolean,
): Promise<Map<string, boolean | null>> {
  const unique = [...new Set(names)]
  const result = new Map<string, boolean | null>()
  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    const batch = unique.slice(i, i + CONCURRENCY)
    const answers = await Promise.all(batch.map(async (name) => {
      const cached = getCached(cache, name)
      if (cached) return cached.exists
      const { exists } = await checkNpm(name)
      if (exists !== null && useCache) cache[name] = { exists, ts: Date.now() }
      return exists
    }))
    batch.forEach((name, j) => result.set(name, answers[j]))
  }
  return result
}

/**
 * Which of these missing names could a stranger publish? Not a name with capital
 * letters, one in a scope someone owns, or one npm would refuse as a punctuation
 * variant of an existing package. `claimable: null` when the scope could not be checked.
 *
 * Scope answers share the registry cache under the bare `@scope` key — never a valid
 * package name, so it cannot collide — with `exists` meaning the scope is owned.
 * Mutates `cache`; the caller saves it.
 */
export async function checkClaimable(
  pkgs: string[],
  cache: Record<string, CacheEntry>,
  useCache: boolean,
): Promise<Map<string, Claim>> {
  const scopes = [...new Set(pkgs.filter(p => p.startsWith('@')).map(p => p.split('/')[0]))]
  const owned = new Map<string, boolean | null>()

  for (let i = 0; i < scopes.length; i += CONCURRENCY) {
    const batch = scopes.slice(i, i + CONCURRENCY)
    const answers = await Promise.all(batch.map(async (scope) => {
      const cached = getCached(cache, scope)
      if (cached) return cached.exists
      const { owned: isOwned } = await checkScope(scope)
      if (isOwned !== null && useCache) cache[scope] = { exists: isOwned, ts: Date.now() }
      return isOwned
    }))
    batch.forEach((scope, j) => owned.set(scope, answers[j]))
  }

  const claims = new Map<string, Claim>()
  for (const pkg of pkgs) {
    // npm rejects new names with capital letters, so nobody can take `Install` or `@AIRoute/x`
    if (pkg !== pkg.toLowerCase()) {
      claims.set(pkg, { claimable: false, reason: 'case' })
      continue
    }
    if (!pkg.startsWith('@')) {
      claims.set(pkg, { claimable: true })
      continue
    }
    const isOwned = owned.get(pkg.split('/')[0]) ?? null
    claims.set(pkg, isOwned === null ? { claimable: null }
      : isOwned ? { claimable: false, reason: 'scope' }
      : { claimable: true })
  }

  // An unscoped name npm would refuse because an existing package differs from it only
  // in punctuation (`opencode` vs `open-code`). All variants go out in one pool.
  const variantsOf = new Map<string, string[]>()
  for (const [pkg, claim] of claims) {
    if (claim.claimable !== true || pkg.startsWith('@')) continue
    const variants = punctuationVariants(pkg)
    if (variants.length > 0) variantsOf.set(pkg, variants)
  }
  if (variantsOf.size > 0) {
    const exists = await existsMany([...variantsOf.values()].flat(), cache, useCache)
    for (const [pkg, variants] of variantsOf) {
      const similarTo = variants.find(v => exists.get(v) === true)
      if (similarTo) claims.set(pkg, { claimable: false, reason: 'similar', similarTo })
    }
  }
  return claims
}

/** Why nobody can claim a missing name, as a sentence. Empty when the name is claimable. */
export function describeUnclaimable(pkg: string, claim: Pick<Claim, 'reason' | 'similarTo'>): string {
  switch (claim.reason) {
    case 'scope':
      return `The ${pkg.split('/')[0]} scope already has an owner, so only they could publish it.`
    case 'case':
      return 'npm does not accept new names with capital letters, so nobody can register it.'
    case 'similar':
      return `npm will not accept it because '${claim.similarTo}' already exists and differs only in punctuation, so nobody can register it.`
    default:
      return ''
  }
}

/** The DefinitelyTyped package for a module: `@types/estree`, `@types/babel__core`. */
export function typesPackageFor(pkg: string): string {
  return pkg.startsWith('@') ? `@types/${pkg.slice(1).replace('/', '__')}` : `@types/${pkg}`
}

/**
 * Of these missing names, the ones TypeScript resolves through an `@types/*` package,
 * so they were never meant to come from npm under their own name: `estree` exists only
 * as `@types/estree`.
 *
 * A name counts when the project declares its `@types` package, or when it is imported
 * only for types (`import type`, a `.d.ts` file) and the `@types` package exists. Pass
 * only names that came from code — a missing name in package.json is fetched by
 * `npm install` regardless. Mutates `cache`; the caller saves it.
 */
export async function providedByTypes(
  missing: string[],
  { declared, typeOnly }: { declared: ReadonlySet<string>; typeOnly: (pkg: string) => boolean },
  cache: Record<string, CacheEntry>,
  useCache: boolean,
): Promise<Set<string>> {
  const provided = new Set<string>()
  const lookup: string[] = []
  for (const pkg of missing) {
    if (declared.has(typesPackageFor(pkg))) provided.add(pkg)
    else if (typeOnly(pkg)) lookup.push(pkg)
  }
  if (lookup.length > 0) {
    const exists = await existsMany(lookup.map(typesPackageFor), cache, useCache)
    for (const pkg of lookup) if (exists.get(typesPackageFor(pkg)) === true) provided.add(pkg)
  }
  return provided
}

/**
 * Verify a list of package names against the npm registry.
 *
 * Shared by the CLI, the MCP server and the agent hook. Unlike `scan()`, this takes
 * names directly rather than walking a directory, and never throws — an unreachable
 * registry yields `status: 'unknown'` so callers can fail open.
 */
export async function verifyPackages(
  pkgs: string[],
  { deep = false, useCache = true }: VerifyOptions = {},
): Promise<PackageVerdict[]> {
  const unique = [...new Set(pkgs)]
  if (unique.length === 0) return []

  const cache: Record<string, CacheEntry> = useCache ? loadCache() : {}
  const verdicts: PackageVerdict[] = []
  let cacheDirty = false

  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    const batch = unique.slice(i, i + CONCURRENCY)
    const checks = await Promise.all(
      batch.map((pkg): Promise<NpmCheckResult> => {
        const cached = getCached(cache, pkg)
        return cached ? Promise.resolve({ exists: cached.exists }) : checkNpm(pkg)
      }),
    )

    for (let j = 0; j < batch.length; j++) {
      const pkg = batch[j]
      const { exists, error } = checks[j]

      if (exists !== null && useCache) {
        cache[pkg] = { exists, ts: Date.now() }
        cacheDirty = true
      }

      if (exists === false) {
        verdicts.push({ pkg, status: 'missing', typosquatOf: detectTyposquat(pkg) })
      } else if (exists === null) {
        verdicts.push({ pkg, status: 'unknown', typosquatOf: null, error: error ?? 'unreachable' })
      } else {
        verdicts.push({ pkg, status: 'ok', typosquatOf: detectTyposquat(pkg) })
      }
    }
  }

  // A missing name is only squattable if npm would let a stranger publish it
  const missing = verdicts.filter(v => v.status === 'missing')
  if (missing.length > 0) {
    const claims = await checkClaimable(missing.map(v => v.pkg), cache, useCache)
    for (const v of missing) applyClaim(v, claims.get(v.pkg))
    cacheDirty = true
  }

  if (useCache && cacheDirty) {
    try { saveCache(cache) } catch { /* cache is best-effort */ }
  }

  if (!deep) return verdicts

  // Upgrade existing packages to `suspicious` where the risk heuristics fire.
  // Only runs for packages that exist — missing names have nothing to inspect.
  for (const verdict of verdicts) {
    if (verdict.status !== 'ok') continue
    const info = await checkPackageRisk(verdict.pkg)
    if (info.exists !== true) continue
    // The adoption-aware answer replaces the name-only hint: `preact` is near
    // `react` by name, but with millions of weekly downloads it is no typosquat
    verdict.typosquatOf = info.typosquatOf
    if (info.risk === 'low') continue
    verdict.status = 'suspicious'
    verdict.risk = info.risk as 'medium' | 'high'
    verdict.flags = info.flags
    verdict.installScripts = info.installScripts
    verdict.downloads = info.downloads
    verdict.created = info.created
    verdict.maintainers = info.maintainers
    verdict.typosquatOf = info.typosquatOf
  }

  return verdicts
}

/** Copy a claim onto a missing verdict or `MissingRef`. */
export function applyClaim(
  target: { claimable?: boolean | null; unclaimableReason?: Claim['reason']; similarTo?: string },
  claim: Claim | undefined,
): void {
  target.claimable = claim?.claimable ?? null
  if (claim?.reason) target.unclaimableReason = claim.reason
  if (claim?.similarTo) target.similarTo = claim.similarTo
}

/** True if anything in the list warrants blocking. `unknown` never blocks. */
export function hasBlockingVerdict(verdicts: PackageVerdict[]): boolean {
  return verdicts.some(v => v.status === 'missing' || (v.status === 'suspicious' && v.risk === 'high'))
}

/** One-line human summary of a single verdict, used by both the hook and the MCP server. */
export function describeVerdict(v: PackageVerdict): string {
  switch (v.status) {
    case 'missing': {
      const squat = v.typosquatOf
        ? ` It is 1-2 characters from '${v.typosquatOf}', which is a classic typosquat pattern — you may have meant '${v.typosquatOf}'.`
        : ''
      if (v.claimable === false) {
        const why = describeUnclaimable(v.pkg, { reason: v.unclaimableReason ?? 'scope', similarTo: v.similarTo })
        return `'${v.pkg}' DOES NOT EXIST on npm.${squat} ${why} It cannot be installed, but nobody else can claim the name either.`
      }
      return `'${v.pkg}' DOES NOT EXIST on npm.${squat} The name is unregistered, so installing it could hand an attacker code execution the moment they claim it.`
    }
    case 'suspicious': {
      const reasons = (v.flags ?? []).join('; ')
      const critical = (v.installScripts ?? []).length > 0
        ? ` It runs a ${v.installScripts!.join('/')} script, which executes arbitrary code on install.`
        : ''
      return `'${v.pkg}' exists but is ${v.risk} risk: ${reasons}.${critical}`
    }
    case 'unknown':
      return `'${v.pkg}' could not be verified (${v.error}).`
    default:
      return `'${v.pkg}' exists on npm.`
  }
}
