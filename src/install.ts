// Kept for the public API. The parser itself lives in `commands.ts`, which also
// finds the packages a command would download and run (`npx`, `dlx`, `create`).

import { extractCommandTargets } from './commands'

export { specToPackageName } from './commands'

/**
 * Extract the registry packages a shell command would install.
 *
 * Returns `[]` for commands that install nothing new (`npm install` with no args,
 * `npm ci`, `yarn`), and for non-install commands. For the packages a command would
 * run on the spot (`npx`, `pnpm dlx`, `npm create`), use `extractCommandTargets`.
 */
export function extractInstallTargets(command: string): string[] {
  return extractCommandTargets(command).filter(t => t.action === 'install').map(t => t.name)
}
