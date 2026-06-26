import fs from 'fs'
import path from 'path'
import { extractImports } from './imports'
import { loadCache, saveCache, getCached } from './cache'
import { loadConfig, matchesIgnore } from './config'
import { checkNpm, checkScary } from './npm'
import { walkFiles, readPackageJsonDeps, readWorkspacePackages, readTsconfigPaths } from './files'
import type { CacheEntry, NpmCheckResult, ScanOptions, ScanResult } from './types'

const CONCURRENCY = 10

export async function scan(
  targetDir: string,
  { onProgress, useCache = true, scary = false, config }: ScanOptions = {},
): Promise<ScanResult> {
  const conf = config ?? loadConfig(targetDir)
  const files = walkFiles(targetDir)
  const declaredDeps = readPackageJsonDeps(targetDir)
  const workspacePkgs = readWorkspacePackages(targetDir)
  const tsconfigAliases = readTsconfigPaths(targetDir)

  const cache: Record<string, CacheEntry> = useCache ? loadCache() : {}
  let cacheHits = 0

  // Collect all unique imports across all files, with file references
  const importMap = new Map<string, string[]>()
  for (const file of files) {
    let code: string
    try { code = fs.readFileSync(file, 'utf8') } catch { continue }
    for (const pkg of extractImports(code)) {
      if (!importMap.has(pkg)) importMap.set(pkg, [])
      importMap.get(pkg)!.push(path.relative(targetDir, file))
    }
  }

  const allPkgs = [...importMap.keys()].filter(
    pkg => !matchesIgnore(pkg, conf.ignore) && !workspacePkgs.has(pkg) && !tsconfigAliases.has(pkg),
  )

  const results: ScanResult = {
    scanned: files.length,
    packages: allPkgs.length,
    hallucinated: [],
    notInPackageJson: [],
    errors: [],
    scary: [],
    cacheHits: 0,
  }

  // Check each package against npm registry, max CONCURRENCY at a time
  for (let i = 0; i < allPkgs.length; i += CONCURRENCY) {
    const batch = allPkgs.slice(i, i + CONCURRENCY)
    const checks = await Promise.all(
      batch.map((pkg): Promise<NpmCheckResult> => {
        const cached = getCached(cache, pkg)
        if (cached) {
          cacheHits++
          return Promise.resolve({ exists: cached.exists })
        }
        return checkNpm(pkg)
      }),
    )

    for (let j = 0; j < batch.length; j++) {
      const pkg = batch[j]
      const { exists, error } = checks[j]
      const matchedFiles = importMap.get(pkg)!

      if (exists !== null && useCache) {
        cache[pkg] = { exists, ts: Date.now() }
      }

      onProgress?.({ pkg, exists, error, total: allPkgs.length, done: i + j + 1 })

      if (exists === false) {
        results.hallucinated.push({ pkg, files: matchedFiles })
      } else if (exists === null && error) {
        results.errors.push({ pkg, error, files: matchedFiles })
      } else if (exists === true && !declaredDeps.has(pkg)) {
        results.notInPackageJson.push({ pkg, files: matchedFiles })
      }
    }
  }

  if (useCache) saveCache(cache)
  results.cacheHits = cacheHits

  // Scary mode: flag hallucinated names as available for squatting,
  // and deep-check undeclared packages for supply chain risk heuristics
  if (scary) {
    for (const { pkg, files: matchedFiles } of results.hallucinated) {
      results.scary.push({ pkg, files: matchedFiles, type: 'available' })
    }

    for (const { pkg, files: matchedFiles } of results.notInPackageJson) {
      const info = await checkScary(pkg)
      if (info.exists === true && info.risk !== 'low') {
        results.scary.push({
          pkg,
          files: matchedFiles,
          type: 'suspicious',
          exists: true,
          created: info.created,
          downloads: info.downloads,
          versions: info.versions,
          risk: info.risk as 'medium' | 'high',
          flags: info.flags,
        })
      }
    }
  }

  return results
}
