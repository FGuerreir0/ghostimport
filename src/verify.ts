import { loadCache, saveCache, getCached } from './cache'
import { checkNpm, checkPackageRisk, detectTyposquat } from './npm'
import type { CacheEntry, NpmCheckResult, PackageVerdict, VerifyOptions } from './types'

const CONCURRENCY = 10

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

  if (useCache && cacheDirty) {
    try { saveCache(cache) } catch { /* cache is best-effort */ }
  }

  if (!deep) return verdicts

  // Upgrade existing packages to `suspicious` where the risk heuristics fire.
  // Only runs for packages that exist — missing names have nothing to inspect.
  for (const verdict of verdicts) {
    if (verdict.status !== 'ok') continue
    const info = await checkPackageRisk(verdict.pkg)
    if (info.exists !== true || info.risk === 'low') continue
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
