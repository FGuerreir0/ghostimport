import fs from 'fs'
import path from 'path'
import os from 'os'
import type { CacheEntry } from './types'

const CACHE_TTL = 24 * 60 * 60 * 1000

function getCacheDir(): string {
  const dir = path.join(os.homedir(), '.ghostimport')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function getCachePath(): string {
  return path.join(getCacheDir(), 'registry-cache.json')
}

export function loadCache(): Record<string, CacheEntry> {
  const cachePath = getCachePath()
  if (!fs.existsSync(cachePath)) return {}
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8')) as Record<string, CacheEntry>
  } catch {
    return {}
  }
}

export function saveCache(cache: Record<string, CacheEntry>): void {
  fs.writeFileSync(getCachePath(), JSON.stringify(cache, null, 2), 'utf8')
}

export function getCached(cache: Record<string, CacheEntry>, pkgName: string): CacheEntry | null {
  const entry = cache[pkgName]
  if (!entry) return null
  if (Date.now() - entry.ts > CACHE_TTL) return null
  return entry
}
