export interface Config {
  ignore: string[]
  includeUndeclared: boolean
}

export interface ScanOptions {
  onProgress?: (progress: ScanProgress) => void
  useCache?: boolean
  /**
   * Run supply-chain heuristics on packages that exist but aren't declared.
   * Costs two extra requests per package. Default true.
   */
  deep?: boolean
  config?: Config
}

export interface ScanProgress {
  pkg: string
  exists: boolean | null
  error?: string
  total: number
  done: number
}

export interface PackageRef {
  pkg: string
  files: string[]
}

export interface PackageError extends PackageRef {
  error: string
}

/**
 * A supply-chain finding.
 *
 * `unregistered` — the name has no owner, so anyone can publish it. This is the
 * slopsquatting case: the import is already in your code, waiting to resolve.
 * `suspicious`   — the name is published, but the heuristics rate it risky.
 */
export type RiskEntry =
  | { pkg: string; files: string[]; type: 'unregistered'; typosquatOf: string | null }
  | {
      pkg: string
      files: string[]
      type: 'suspicious'
      created: string
      downloads: number | null
      versions: number
      risk: 'medium' | 'high'
      flags: string[]
      installScripts: string[]
      typosquatOf: string | null
      maintainers: number
    }

export interface ScanResult {
  scanned: number
  packages: number
  /** Imported names that do not exist on npm. */
  missing: PackageRef[]
  /** Names that exist on npm but aren't declared in package.json. */
  undeclared: PackageRef[]
  /** Supply-chain findings, covering both missing and undeclared names. */
  risks: RiskEntry[]
  /** Names that could not be checked (network/timeout). */
  errors: PackageError[]
  cacheHits: number
}

export interface NpmCheckResult {
  exists: boolean | null
  error?: string
}

export type PackageRiskResult =
  | {
      exists: true
      created: string
      downloads: number | null
      versions: number
      risk: 'low' | 'medium' | 'high'
      flags: string[]
      installScripts: string[]
      typosquatOf: string | null
      maintainers: number
    }
  | { exists: false }
  | { exists: null; error: string }

/**
 * - `ok`           — exists on npm, no risk signals
 * - `missing`      — does not exist on npm; the name is free for anyone to register
 * - `suspicious`   — exists, but the risk heuristics rate it medium/high
 * - `unknown`      — could not be checked (network/timeout); never treated as a failure
 */
export type VerdictStatus = 'ok' | 'missing' | 'suspicious' | 'unknown'

export interface PackageVerdict {
  pkg: string
  status: VerdictStatus
  typosquatOf: string | null
  risk?: 'medium' | 'high'
  flags?: string[]
  installScripts?: string[]
  downloads?: number | null
  created?: string
  maintainers?: number
  error?: string
}

export interface VerifyOptions {
  /** Also run risk heuristics on packages that do exist. Default false. */
  deep?: boolean
  useCache?: boolean
}

export interface CacheEntry {
  exists: boolean
  ts: number
}
