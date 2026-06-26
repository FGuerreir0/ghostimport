export interface Config {
  ignore: string[]
  includeUndeclared: boolean
}

export interface ScanOptions {
  onProgress?: (progress: ProgressEvent) => void
  useCache?: boolean
  scary?: boolean
  config?: Config
}

export interface ProgressEvent {
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

export interface ScaryCheckResult {
  exists: boolean | null
  error?: string
  squatRisk?: 'available'
  created?: string
  downloads?: number | null
  versions?: number
  risk?: 'low' | 'medium' | 'high'
  flags?: string[]
}

export interface CacheEntry {
  exists: boolean
  ts: number
}

export function scan(targetDir: string, options?: ScanOptions): Promise<ScanResult>
export function extractImports(code: string): string[]
export function checkNpm(pkgName: string): Promise<NpmCheckResult>
export function checkScary(pkgName: string): Promise<ScaryCheckResult>
export function walkFiles(dir: string): string[]
export function readPackageJsonDeps(dir: string): Set<string>
export function loadConfig(dir: string): Config
export function loadCache(): Record<string, CacheEntry>
export function saveCache(cache: Record<string, CacheEntry>): void
