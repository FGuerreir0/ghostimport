// Agent hook entry point (`ghostimport hook`).
//
// Reads a hook payload on stdin and exits 2 with a message on stderr when it finds
// a problem — the convention Claude Code uses to block a tool call (PreToolUse) or
// feed a correction back to the model (PostToolUse).
//
// Two guards:
//   PreToolUse  + Bash  → vet packages an install command would fetch, before it runs
//   PostToolUse + edits → check imports the agent just wrote into a source file
//
// Fails open. A network outage, a malformed payload or an internal error must never
// wedge the agent loop, so anything unexpected exits 0 silently.

import fs from 'fs'
import path from 'path'
import { extractImports } from './imports'
import { extractSfcScripts, SFC_EXTS } from './sfc'
import { CODE_EXTS, readWorkspacePackages, readTsconfigPaths } from './files'
import { loadConfig, matchesIgnore } from './config'
import { extractInstallTargets } from './install'
import { verifyPackages, describeVerdict } from './verify'
import type { PackageVerdict } from './types'

const ALLOW = 0
const BLOCK = 2

// Bounded so a slow registry can never stall the agent
const BUDGET_MS = 20_000
const MAX_PACKAGES = 40

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

interface HookPayload {
  hook_event_name?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  cwd?: string
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => { data += chunk })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', () => resolve(''))
  })
}

/** Packages that are legitimately unresolvable against the registry in this project. */
function localNames(cwd: string): (pkg: string) => boolean {
  const config = loadConfig(cwd)
  const workspaces = readWorkspacePackages(cwd)
  const aliases = readTsconfigPaths(cwd)
  return (pkg) => matchesIgnore(pkg, config.ignore) || workspaces.has(pkg) || aliases.has(pkg)
}

function report(verdicts: PackageVerdict[], context: string, guidance: string): string {
  const problems = verdicts.filter(v => v.status === 'missing' || (v.status === 'suspicious' && v.risk === 'high'))
  const lines = [`ghostimport blocked this: ${context}`, '']
  for (const v of problems) lines.push(`  • ${describeVerdict(v)}`)
  lines.push('', guidance)
  return lines.join('\n')
}

// ─── Guards ───────────────────────────────────────────────────────────────────

async function checkInstallCommand(payload: HookPayload): Promise<{ code: number; message?: string }> {
  const command = typeof payload.tool_input?.command === 'string' ? payload.tool_input.command : ''
  if (!command) return { code: ALLOW }

  const isLocal = localNames(payload.cwd ?? process.cwd())
  const targets = extractInstallTargets(command).filter(pkg => !isLocal(pkg)).slice(0, MAX_PACKAGES)
  if (targets.length === 0) return { code: ALLOW }

  // Deep check: this is the moment a postinstall script would execute, so the
  // extra requests are worth it here even though they are too slow per-edit.
  const verdicts = await verifyPackages(targets, { deep: true })
  const problems = verdicts.filter(v => v.status === 'missing' || (v.status === 'suspicious' && v.risk === 'high'))
  if (problems.length === 0) return { code: ALLOW }

  return {
    code: BLOCK,
    message: report(
      verdicts,
      'the install command below would fetch packages that are unsafe or do not exist.',
      'Do not retry this command as written. Remove the flagged packages, correct the name if it was a typo, ' +
      'and tell the user what was flagged and why.',
    ),
  }
}

async function checkEditedFile(payload: HookPayload): Promise<{ code: number; message?: string }> {
  const filePath = typeof payload.tool_input?.file_path === 'string' ? payload.tool_input.file_path : ''
  if (!filePath) return { code: ALLOW }

  const ext = path.extname(filePath)
  if (!CODE_EXTS.has(ext)) return { code: ALLOW }

  let code: string
  try { code = fs.readFileSync(filePath, 'utf8') } catch { return { code: ALLOW } }
  if (SFC_EXTS.has(ext)) code = extractSfcScripts(code, ext)

  const isLocal = localNames(payload.cwd ?? process.cwd())
  const imported = extractImports(code).filter(pkg => !isLocal(pkg)).slice(0, MAX_PACKAGES)
  if (imported.length === 0) return { code: ALLOW }

  // Existence only — this runs after every single edit, so it has to stay cheap.
  // The 24h registry cache means the common case is zero network calls.
  const verdicts = await verifyPackages(imported)
  const problems = verdicts.filter(v => v.status === 'missing')
  if (problems.length === 0) return { code: ALLOW }

  return {
    code: BLOCK,
    message: report(
      verdicts,
      `${path.relative(payload.cwd ?? process.cwd(), filePath)} imports packages that do not exist on npm.`,
      'Fix the imports now: use a package that is actually published, or write the functionality yourself. ' +
      'Do not add these names to package.json.',
    ),
  }
}

// ─── Entry ────────────────────────────────────────────────────────────────────

export async function runHook(): Promise<number> {
  let payload: HookPayload
  try {
    const raw = await readStdin()
    if (!raw.trim()) return ALLOW
    payload = JSON.parse(raw) as HookPayload
  } catch {
    return ALLOW
  }

  const guard =
    payload.tool_name === 'Bash' ? checkInstallCommand
    : EDIT_TOOLS.has(payload.tool_name ?? '') ? checkEditedFile
    : null

  if (!guard) return ALLOW

  let result: { code: number; message?: string }
  try {
    result = await Promise.race([
      guard(payload),
      new Promise<{ code: number }>((resolve) => setTimeout(() => resolve({ code: ALLOW }), BUDGET_MS).unref()),
    ])
  } catch {
    return ALLOW
  }

  if (result.code === BLOCK && result.message) process.stderr.write(result.message + '\n')
  return result.code
}
