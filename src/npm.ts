import https from 'https'
import type { NpmCheckResult, PackageRiskResult } from './types'

interface VersionMeta {
  scripts?: Record<string, string>
}

interface PackageMeta {
  time?: { created?: string; modified?: string }
  versions?: Record<string, VersionMeta>
  maintainers?: Array<{ name: string }>
  'dist-tags'?: { latest?: string }
}

interface NpmDownloads {
  downloads?: number
}

function httpGetJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Accept: 'application/json' }, timeout: 8000 }, (res) => {
      let data = ''
      res.on('data', (chunk: string) => { data += chunk })
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

function encodePackageName(pkgName: string): string {
  return pkgName.startsWith('@')
    ? '@' + encodeURIComponent(pkgName.slice(1))
    : encodeURIComponent(pkgName)
}

function levenshtein(a: string, b: string): number {
  const n = b.length
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1])
      prev = tmp
    }
  }
  return dp[n]
}

// Top npm packages to check typosquatting against (names < 5 chars skipped at runtime)
const POPULAR_PACKAGES = [
  'react', 'react-dom', 'svelte', 'angular',
  'express', 'fastify',
  'lodash', 'axios', 'moment', 'dayjs', 'date-fns', 'ramda',
  'webpack', 'vite', 'esbuild', 'rollup', 'parcel', 'turbo',
  'next', 'nuxt', 'gatsby', 'remix', 'astro',
  'vitest', 'cypress', 'playwright', 'puppeteer', 'mocha', 'jasmine',
  'eslint', 'prettier', 'husky',
  'nodemon', 'dotenv', 'cross-env',
  'helmet', 'passport', 'bcrypt', 'bcryptjs', 'jsonwebtoken',
  'mongoose', 'sequelize', 'prisma', 'typeorm', 'knex',
  'mysql2', 'sqlite3', 'ioredis',
  'redux', 'mobx', 'zustand', 'recoil', 'jotai',
  'rxjs', 'graphql',
  'zod', 'yup', 'joi', 'ajv',
  'chalk', 'picocolors', 'kleur', 'commander', 'yargs',
  'glob', 'micromatch', 'chokidar',
  'uuid', 'nanoid', 'semver', 'cheerio', 'jsdom',
  'sharp', 'multer', 'yaml',
  'tailwindcss', 'bootstrap', 'lerna', 'typescript',
  'socket.io',
] as const

const POPULAR_SET: ReadonlySet<string> = new Set(POPULAR_PACKAGES)

/**
 * The popular package this name is 1-2 edits from, judged by the name alone.
 *
 * A name match is a hint, not a verdict: `preact`, `redis` and `cypress` are all
 * close to a popular name and all legitimate. `checkPackageRisk` only treats a
 * match as a typosquat when the package also has no adoption of its own.
 */
export function detectTyposquat(pkgName: string): string | null {
  const name = pkgName.startsWith('@') ? (pkgName.split('/')[1] ?? pkgName) : pkgName
  const lower = name.toLowerCase()
  if (lower.length < 5) return null
  // Checked up front: otherwise `redux` matches `remix` before the loop reaches `redux`
  if (POPULAR_SET.has(lower)) return null
  for (const popular of POPULAR_PACKAGES) {
    if (popular.length < 5) continue
    if (lower === popular) return null
    if (levenshtein(lower, popular) <= 2) return popular
  }
  return null
}

export function checkNpm(pkgName: string): Promise<NpmCheckResult> {
  return new Promise((resolve) => {
    const options = {
      hostname: 'registry.npmjs.org',
      path: `/${encodePackageName(pkgName)}`,
      method: 'GET',
      headers: { Accept: 'application/json' },
      timeout: 8000,
    }

    const req = https.request(options, (res) => {
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

    req.on('error', (err: Error) => {
      resolve({ exists: null, error: err.message })
    })

    req.end()
  })
}

/**
 * Does anyone own this npm scope? Only a scope's owner can publish names under it,
 * so a missing `@scope/name` is squattable only when the scope itself is free.
 *
 * The org endpoint answers for user scopes as well as organisations, without auth:
 * 200 for an owned scope, 404 ("Scope not found") for a free one.
 */
export function checkScope(scope: string): Promise<{ owned: boolean | null; error?: string }> {
  return new Promise((resolve) => {
    const options = {
      hostname: 'registry.npmjs.org',
      path: `/-/org/${encodeURIComponent(scope.replace(/^@/, ''))}/package`,
      method: 'GET',
      headers: { Accept: 'application/json' },
      timeout: 8000,
    }

    const req = https.request(options, (res) => {
      res.resume()
      if (res.statusCode === 200) {
        resolve({ owned: true })
      } else if (res.statusCode === 404) {
        resolve({ owned: false })
      } else {
        resolve({ owned: null, error: `HTTP ${res.statusCode}` })
      }
    })

    req.on('timeout', () => {
      req.destroy()
      resolve({ owned: null, error: 'timeout' })
    })

    req.on('error', (err: Error) => {
      resolve({ owned: null, error: err.message })
    })

    req.end()
  })
}

const INSTALL_HOOKS = new Set(['preinstall', 'install', 'postinstall'])

/**
 * Weekly downloads above which a package has a track record of its own. Typosquats
 * live on accidental installs and stay far below this; the legitimate packages that
 * sit near a popular name (`preact`, `redis`, `cypress`, `jsdoc`) are far above it.
 */
const ESTABLISHED_WEEKLY_DOWNLOADS = 10_000

export interface RiskSignals {
  /** Install-time lifecycle scripts in the latest version. */
  installScripts: string[]
  /** `detectTyposquat()` of the name — similarity alone, before adoption is considered. */
  nearName: string | null
  /** Days since the package was created; `Infinity` when unknown. */
  ageDays: number
  /** Last-week downloads; `null` when the downloads API did not answer. */
  downloads: number | null
  /** Published versions; `null` when unknown. */
  versions: number | null
  maintainers: number
}

export interface RiskScore {
  risk: 'low' | 'medium' | 'high'
  flags: string[]
  /** The near name, kept only when the package has no adoption of its own. */
  typosquatOf: string | null
}

/**
 * Score a package's risk from its registry signals. Pure, so it can be tested
 * without the network.
 *
 * - Trust deficits (medium): created < 30 days ago, < 50 weekly downloads, a single
 *   version. A single maintainer counts only alongside one of those.
 * - Critical: a typosquat (a near name on a package that is not established), or an
 *   install script on a package with any trust deficit.
 * - `high` on any critical signal or 2+ deficits; `medium` on one; else `low`.
 *
 * An install script alone is not a risk: esbuild, puppeteer and core-js all ship one.
 * It is how a malicious package runs, so it turns a package with no track record from
 * merely unproven into high risk.
 */
export function scoreRisk(s: RiskSignals): RiskScore {
  const established =
    (s.downloads !== null && s.downloads >= ESTABLISHED_WEEKLY_DOWNLOADS) ||
    // Downloads API unavailable: fall back to a long, active history
    (s.downloads === null && s.ageDays >= 365 && (s.versions ?? 0) >= 10)
  const typosquatOf = established ? null : s.nearName

  const deficits: string[] = []
  if (s.ageDays < 30) deficits.push(`created ${s.ageDays} days ago`)
  if (s.downloads !== null && s.downloads < 50) deficits.push(`${s.downloads} weekly downloads`)
  if (s.versions !== null && s.versions <= 1) deficits.push('single version published')
  // Only amplifies existing risk — a popular single-maintainer package (lodash, zod) is not suspicious alone
  if (s.maintainers === 1 && deficits.length > 0) deficits.push('single maintainer')

  const flags: string[] = []
  if (s.installScripts.length > 0) flags.push(`has ${s.installScripts.join(', ')} script`)
  if (typosquatOf) flags.push(`name is 1-2 chars from '${typosquatOf}'`)
  flags.push(...deficits)

  const critical = typosquatOf !== null || (s.installScripts.length > 0 && deficits.length > 0)
  const risk: RiskScore['risk'] =
    critical || deficits.length >= 2 ? 'high' :
    deficits.length === 1 ? 'medium' : 'low'

  return { risk, flags, typosquatOf }
}

/** Full supply-chain check for one package: registry metadata plus risk heuristics. */
export async function checkPackageRisk(pkgName: string): Promise<PackageRiskResult> {
  const encoded = encodePackageName(pkgName)

  try {
    const meta = await httpGetJson(`https://registry.npmjs.org/${encoded}`) as PackageMeta | null
    if (!meta) return { exists: false }

    const created = meta.time?.created ? new Date(meta.time.created) : null
    const ageMs = created ? Date.now() - created.getTime() : Infinity
    const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24))

    let downloads: number | null = null
    try {
      const dl = await httpGetJson(`https://api.npmjs.org/downloads/point/last-week/${encoded}`) as NpmDownloads | null
      downloads = dl?.downloads ?? null
    } catch { /* ignore */ }

    const latestVersion = meta['dist-tags']?.latest
    const latestMeta = latestVersion ? meta.versions?.[latestVersion] : undefined
    const installScripts = Object.keys(latestMeta?.scripts ?? {}).filter(k => INSTALL_HOOKS.has(k))

    const maintainers = meta.maintainers?.length ?? 0
    const versions = meta.versions ? Object.keys(meta.versions).length : null

    const { risk, flags, typosquatOf } = scoreRisk({
      installScripts,
      nearName: detectTyposquat(pkgName),
      ageDays,
      downloads,
      versions,
      maintainers,
    })

    return {
      exists: true,
      created: created?.toISOString().slice(0, 10) ?? 'unknown',
      downloads,
      versions: versions ?? 0,
      risk,
      flags,
      installScripts,
      typosquatOf,
      maintainers,
    }
  } catch (err) {
    return { exists: null, error: (err as Error).message }
  }
}
