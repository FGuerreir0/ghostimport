// A minimal MCP (Model Context Protocol) server over stdio.
//
// Implemented directly against the JSON-RPC wire format rather than the official
// SDK so the published package keeps its zero-runtime-dependency guarantee — a
// supply-chain tool that drags in a dependency tree undermines its own pitch.

import { createInterface } from 'readline'
import path from 'path'
import { scan } from './scan'
import { loadConfig } from './config'
import { verifyPackages, describeVerdict } from './verify'
import { extractInstallTargets } from './install'
import type { PackageVerdict } from './types'

const KNOWN_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']
const LATEST_PROTOCOL_VERSION = '2025-06-18'

interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (args: Record<string, unknown>) => Promise<string>
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function formatVerdicts(verdicts: PackageVerdict[], subject: string): string {
  const bad = verdicts.filter(v => v.status === 'missing')
  const risky = verdicts.filter(v => v.status === 'suspicious')
  const unknown = verdicts.filter(v => v.status === 'unknown')
  const ok = verdicts.filter(v => v.status === 'ok')

  const lines: string[] = []

  if (bad.length === 0 && risky.length === 0) {
    lines.push(`VERIFIED: all ${verdicts.length} ${subject} check out.`)
  } else {
    lines.push(`STOP — ${bad.length + risky.length} of ${verdicts.length} ${subject} failed verification.`)
  }

  for (const v of bad) lines.push(`\n[DOES NOT EXIST] ${describeVerdict(v)}`)
  for (const v of risky) lines.push(`\n[SUPPLY CHAIN RISK] ${describeVerdict(v)}`)
  for (const v of unknown) lines.push(`\n[UNVERIFIED] ${describeVerdict(v)}`)
  if (ok.length > 0) lines.push(`\nOK: ${ok.map(v => v.pkg).join(', ')}`)

  if (bad.length > 0) {
    lines.push(
      '\nDo not write imports for, or install, the packages marked DOES NOT EXIST. ' +
      'Pick a package that is actually published, or implement the functionality directly.',
    )
  }
  if (risky.length > 0) {
    lines.push('\nSurface the SUPPLY CHAIN RISK findings to the user before installing.')
  }

  return lines.join('\n')
}

// ─── Tools ────────────────────────────────────────────────────────────────────

function buildTools(): ToolDefinition[] {
  return [
    {
      name: 'check_packages',
      description:
        'Verify that npm packages actually exist on the public registry before you import or install them. ' +
        'Language models routinely invent plausible-sounding package names that were never published ("slopsquatting"); ' +
        'attackers watch for those names and register them with malicious install scripts. ' +
        'Call this whenever you are about to write an import statement or add a dependency you have not verified in this session.',
      inputSchema: {
        type: 'object',
        properties: {
          packages: {
            type: 'array',
            items: { type: 'string' },
            description: "npm package names, e.g. ['axios', '@scope/name']. Omit version ranges and subpaths.",
          },
          deep: {
            type: 'boolean',
            description:
              'Also run supply-chain heuristics on packages that do exist (install scripts, age, ' +
              'download volume, typosquat distance). Slower. Default false.',
          },
        },
        required: ['packages'],
      },
      handler: async (args) => {
        const packages = Array.isArray(args.packages) ? args.packages.filter((p): p is string => typeof p === 'string') : []
        if (packages.length === 0) return 'No package names provided.'
        const verdicts = await verifyPackages(packages, { deep: args.deep === true })
        return formatVerdicts(verdicts, 'packages')
      },
    },

    {
      name: 'check_install_command',
      description:
        'Vet a package-manager install command (npm/pnpm/yarn/bun) before running it. ' +
        'Extracts every package the command would install and checks each one for non-existence, ' +
        'typosquatting, and install-time scripts that execute arbitrary code. ' +
        'Call this before running any command that adds a dependency.',
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: "The full shell command, e.g. 'npm install axios zod'.",
          },
        },
        required: ['command'],
      },
      handler: async (args) => {
        const command = typeof args.command === 'string' ? args.command : ''
        const targets = extractInstallTargets(command)
        if (targets.length === 0) {
          return 'This command does not install any new packages from the npm registry. Safe to run.'
        }
        const verdicts = await verifyPackages(targets, { deep: true })
        return formatVerdicts(verdicts, 'packages to be installed')
      },
    },

    {
      name: 'scan_project',
      description:
        'Scan a project directory for imports of npm packages that do not exist, and for packages ' +
        'imported but missing from package.json. Use this to audit a codebase — for a single package ' +
        'name, use check_packages instead.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory to scan. Defaults to the current working directory.' },
        },
      },
      handler: async (args) => {
        const target = path.resolve(typeof args.path === 'string' && args.path ? args.path : process.cwd())
        const results = await scan(target, { config: loadConfig(target) })

        const lines = [`Scanned ${results.scanned} files, checked ${results.packages} unique packages in ${target}.`]

        if (results.missing.length === 0) {
          lines.push('\nEvery imported package exists on npm.')
        } else {
          lines.push(`\n${results.missing.length} package(s) DO NOT EXIST on npm:`)
          for (const { pkg, files } of results.missing) {
            lines.push(`  - ${pkg}  (${files.slice(0, 5).join(', ')}${files.length > 5 ? `, +${files.length - 5} more` : ''})`)
          }
          lines.push('These imports will fail to install and the names are free for an attacker to register. Fix them.')
        }

        for (const entry of results.risks) {
          if (entry.type === 'unregistered') {
            lines.push(`\n[SQUATTABLE] '${entry.pkg}' is unregistered${entry.typosquatOf ? ` and 1-2 chars from '${entry.typosquatOf}'` : ''}.`)
          } else {
            lines.push(`\n[${entry.risk.toUpperCase()} RISK] '${entry.pkg}': ${entry.flags.join('; ')}.`)
          }
        }

        if (results.undeclared.length > 0) {
          lines.push(`\n${results.undeclared.length} package(s) imported but not declared in package.json:`)
          lines.push('  ' + results.undeclared.slice(0, 20).map(p => p.pkg).join(', '))
        }

        if (results.errors.length > 0) {
          lines.push(`\n${results.errors.length} package(s) could not be checked (network).`)
        }

        return lines.join('\n')
      },
    },
  ]
}

// ─── Server ───────────────────────────────────────────────────────────────────

export async function runMcpServer(version: string): Promise<void> {
  const tools = buildTools()
  const byName = new Map(tools.map(t => [t.name, t]))

  // stdout is the protocol channel — anything else written there corrupts the stream
  const send = (msg: unknown): void => { process.stdout.write(JSON.stringify(msg) + '\n') }

  const respond = (id: string | number | null, result: unknown): void =>
    send({ jsonrpc: '2.0', id, result })

  const fail = (id: string | number | null, code: number, message: string): void =>
    send({ jsonrpc: '2.0', id, error: { code, message } })

  async function handle(req: JsonRpcRequest): Promise<void> {
    const { method, params = {} } = req
    // Notifications carry no id and must never be answered
    const id = req.id ?? null
    const isNotification = req.id === undefined || req.id === null

    switch (method) {
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : null
        respond(id, {
          protocolVersion: requested && KNOWN_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'ghostimport', version },
        })
        return
      }

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return

      case 'ping':
        respond(id, {})
        return

      case 'tools/list':
        respond(id, {
          tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        })
        return

      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : ''
        const tool = byName.get(name)
        if (!tool) {
          fail(id, -32602, `Unknown tool: ${name}`)
          return
        }
        const args = (params.arguments ?? {}) as Record<string, unknown>
        try {
          const text = await tool.handler(args)
          respond(id, { content: [{ type: 'text', text }] })
        } catch (err) {
          // Tool failures are reported in-band so the model can react, per the MCP spec
          respond(id, {
            content: [{ type: 'text', text: `ghostimport failed: ${(err as Error).message}` }],
            isError: true,
          })
        }
        return
      }

      default:
        if (!isNotification) fail(id, -32601, `Method not found: ${method}`)
    }
  }

  const rl = createInterface({ input: process.stdin })

  // Requests are handled in arrival order; each is cheap and network-bound
  let queue: Promise<void> = Promise.resolve()

  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return

    let req: JsonRpcRequest
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest
    } catch {
      fail(null, -32700, 'Parse error')
      return
    }

    queue = queue.then(() => handle(req)).catch((err: Error) => {
      fail(req.id ?? null, -32603, err.message)
    })
  })

  await new Promise<void>((resolve) => { rl.on('close', () => resolve()) })
}
