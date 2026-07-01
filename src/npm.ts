import https from 'https'
import type { NpmCheckResult, ScaryCheckResult } from './types'

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

export function detectTyposquat(pkgName: string): string | null {
  const name = pkgName.startsWith('@') ? (pkgName.split('/')[1] ?? pkgName) : pkgName
  const lower = name.toLowerCase()
  if (lower.length < 5) return null
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

const INSTALL_HOOKS = new Set(['preinstall', 'install', 'postinstall'])

export async function checkScary(pkgName: string): Promise<ScaryCheckResult> {
  const encoded = encodePackageName(pkgName)

  try {
    const meta = await httpGetJson(`https://registry.npmjs.org/${encoded}`) as PackageMeta | null
    if (!meta) return { exists: false, squatRisk: 'available' }

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
    const typosquatOf = detectTyposquat(pkgName)

    const flags: string[] = []
    if (installScripts.length > 0) flags.push(`has ${installScripts.join(', ')} script`)
    if (typosquatOf) flags.push(`name is 1-2 chars from '${typosquatOf}'`)
    if (ageDays < 30) flags.push(`created ${ageDays} days ago`)
    if (downloads !== null && downloads < 50) flags.push(`${downloads} weekly downloads`)
    if (meta.versions && Object.keys(meta.versions).length <= 1) flags.push('single version published')
    // Only amplifies existing risk — a popular single-maintainer package (lodash, zod) is not suspicious alone
    if (maintainers === 1 && flags.length > 0) flags.push('single maintainer')

    const risk: 'low' | 'medium' | 'high' =
      installScripts.length > 0 || typosquatOf !== null ? 'high' :
      flags.length >= 2 ? 'high' :
      flags.length === 1 ? 'medium' : 'low'

    return {
      exists: true,
      created: created?.toISOString().slice(0, 10) ?? 'unknown',
      downloads,
      versions: meta.versions ? Object.keys(meta.versions).length : 0,
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
