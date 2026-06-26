import fs from 'fs'
import path from 'path'
import type { Config } from './types'

const defaults: Config = { ignore: [], includeUndeclared: true }

export function loadConfig(dir: string): Config {
  const configPath = path.join(dir, '.ghostimportrc.json')
  if (!fs.existsSync(configPath)) return { ...defaults }
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<Config>
    return { ...defaults, ...raw }
  } catch {
    return { ...defaults }
  }
}

export function matchesIgnore(pkg: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === pkg) return true
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -1)
      if (pkg.startsWith(prefix)) return true
    }
  }
  return false
}
