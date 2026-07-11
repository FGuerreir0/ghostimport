export { extractImports } from './imports'
export { extractSfcScripts } from './sfc'
export { loadCache, saveCache } from './cache'
export { loadConfig } from './config'
export { checkNpm, checkScary, detectTyposquat } from './npm'
export { walkFiles, readPackageJsonDeps } from './files'
export { scan } from './scan'
export type {
  Config,
  ScanOptions,
  ScanProgress,
  ScanResult,
  PackageRef,
  PackageError,
  ScaryEntry,
  NpmCheckResult,
  ScaryCheckResult,
  CacheEntry,
} from './types'

