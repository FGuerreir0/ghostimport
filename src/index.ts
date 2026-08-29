// Public API. Everything else in src/ is an implementation detail —
// import it from the module path directly if you really need it.

/** Scan a directory for imports that don't exist or look unsafe. */
export { scan } from './scan'

/** Check a list of package names. The layer the CLI, MCP server and hook share. */
export { verifyPackages } from './verify'

/** Does this one package exist on npm? */
export { checkNpm } from './npm'

/** Full supply-chain check for one package: metadata plus risk heuristics. */
export { checkPackageRisk } from './npm'

/** Is this name 1-2 characters from a popular package? Returns the package, or null. */
export { detectTyposquat } from './npm'

/** Pull the package names out of a source file's import statements. */
export { extractImports } from './imports'

/** Pull the packages a shell command would install. */
export { extractInstallTargets } from './install'

export type {
  Config,
  ScanOptions,
  ScanProgress,
  ScanResult,
  PackageRef,
  PackageError,
  RiskEntry,
  NpmCheckResult,
  PackageRiskResult,
  PackageVerdict,
  VerdictStatus,
  VerifyOptions,
} from './types'
