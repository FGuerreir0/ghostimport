import https from 'https'
import type { NpmCheckResult, ScaryCheckResult } from './types'

interface PackageMeta {
  time?: { created?: string; modified?: string }
  versions?: Record<string, unknown>
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

    const flags: string[] = []
    if (ageDays < 30) flags.push(`created ${ageDays} days ago`)
    if (downloads !== null && downloads < 50) flags.push(`${downloads} weekly downloads`)
    if (meta.versions && Object.keys(meta.versions).length <= 1) flags.push('single version published')

    const risk: 'low' | 'medium' | 'high' =
      flags.length >= 2 ? 'high' : flags.length === 1 ? 'medium' : 'low'

    return {
      exists: true,
      created: created?.toISOString().slice(0, 10) ?? 'unknown',
      downloads,
      versions: meta.versions ? Object.keys(meta.versions).length : 0,
      risk,
      flags,
    }
  } catch (err) {
    return { exists: null, error: (err as Error).message }
  }
}
