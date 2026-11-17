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
 * Why npm would refuse to let a stranger publish a missing name.
 *
 * - `scope`   — the name is scoped, and someone already owns the scope
 * - `case`    — npm rejects new names with capital letters
 * - `similar` — npm rejects a name that matches an existing one with punctuation
 *               removed (`opencode` is refused because `open-code` exists)
 */
export type UnclaimableReason = 'scope' | 'case' | 'similar'

export interface Claim {
  claimable: boolean | null
  /** Set when `claimable` is false. */
  reason?: UnclaimableReason
  /** `similar` only: the existing package that blocks the name. */
  similarTo?: string
}

export interface MissingRef extends PackageRef {
  /**
   * Could a stranger publish this name? Not when it sits in a scope someone owns, has
   * capital letters, or matches an existing name once punctuation is removed — the
   * import is broken, but not squattable. `null` when the scope could not be checked.
   */
  claimable: boolean | null
  /** Why `claimable` is false. */
  unclaimableReason?: UnclaimableReason
  /** For `unclaimableReason: 'similar'`: the existing package that blocks the name. */
  similarTo?: string
}

/**
 * A supply-chain finding.
 *
 * `unregistered` — the name has no owner, so anyone can publish it. This is the
 * slopsquatting case: the import is already in your code, waiting to resolve.
 *                  A missing name inside a scope someone owns is not listed.
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
  /** Names imported in code, or declared in any package.json, that do not exist on npm. */
  missing: MissingRef[]
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
  /** `missing` only: could a stranger publish this name? See `MissingRef.claimable`. */
  claimable?: boolean | null
  /** `missing` only: why `claimable` is false. */
  unclaimableReason?: UnclaimableReason
  /** `missing` only: the existing package that blocks the name. */
  similarTo?: string
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
