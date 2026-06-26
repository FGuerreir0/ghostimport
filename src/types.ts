export interface Config {
  ignore: string[]
  includeUndeclared: boolean
}

export interface ScanOptions {
  onProgress?: (progress: ScanProgress) => void
  useCache?: boolean
  scary?: boolean
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

export type ScaryEntry =
  | { pkg: string; files: string[]; type: 'available' }
  | {
      pkg: string
      files: string[]
      type: 'suspicious'
      exists: true
      created: string
      downloads: number | null
      versions: number
      risk: 'medium' | 'high'
      flags: string[]
    }

export interface ScanResult {
  scanned: number
  packages: number
  hallucinated: PackageRef[]
  notInPackageJson: PackageRef[]
  errors: PackageError[]
  scary: ScaryEntry[]
  cacheHits: number
}

export interface NpmCheckResult {
  exists: boolean | null
  error?: string
}

export type ScaryCheckResult =
  | {
      exists: true
      created: string
      downloads: number | null
      versions: number
      risk: 'low' | 'medium' | 'high'
      flags: string[]
    }
  | { exists: false; squatRisk: 'available' }
  | { exists: null; error: string }

export interface CacheEntry {
  exists: boolean
  ts: number
}
