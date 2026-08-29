import path from 'path'
import { readFileSync, watch as fsWatch, statSync } from 'fs'
import { fileURLToPath } from 'url'
import { scan } from './scan'
import { loadConfig } from './config'
import { CODE_EXTS } from './files'
import { runMcpServer } from './mcp'
import { runHook } from './hook'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
) as { version: string }

// ─── Subcommands ──────────────────────────────────────────────────────────────
// Dispatched before flag parsing; each takes over the process entirely.

if (process.argv[2] === 'mcp') {
  await runMcpServer(version)
  process.exit(0)
}

if (process.argv[2] === 'hook') {
  process.exit(await runHook())
}

// ─── Minimal color helpers (no dependencies) ─────────────────────────────────

const c = {
  red:     (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow:  (s: string) => `\x1b[33m${s}\x1b[0m`,
  green:   (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan:    (s: string) => `\x1b[36m${s}\x1b[0m`,
  gray:    (s: string) => `\x1b[90m${s}\x1b[0m`,
  bold:    (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim:     (s: string) => `\x1b[2m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
}

// ─── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const targetDir = path.resolve(args.find(a => !a.startsWith('--') && !a.startsWith('-')) ?? '.')
const flags = {
  quiet:        args.includes('--quiet') || args.includes('-q'),
  json:         args.includes('--json'),
  watch:        args.includes('--watch') || args.includes('-w'),
  noUndeclared: args.includes('--no-undeclared'),
  noCache:      args.includes('--no-cache'),
  fast:         args.includes('--fast'),
  badge:        args.includes('--badge'),
  help:         args.includes('--help') || args.includes('-h'),
  version:      args.includes('--version') || args.includes('-v'),
}

if (flags.version) {
  console.log(`ghostimport v${version}`)
  process.exit(0)
}

if (flags.help) {
  console.log(`
${c.bold('ghostimport')} — find npm packages your AI wrote that don't exist, or shouldn't be trusted

${c.bold('Usage:')}
  ghostimport [dir] [options]
  ghostimport mcp | hook

${c.bold('Commands:')}
  mcp               Run as an MCP server, so your AI agent can verify a package
                    before importing it        ${c.gray('claude mcp add ghostimport -- npx -y ghostimport mcp')}
  hook              Run as an agent hook — blocks installs of packages that
                    don't exist or look malicious

${c.bold('Options:')}
  --quiet, -q       Only show problems
  --json            Output results as JSON
  --watch, -w       Re-scan on file changes
  --badge           Print a README badge after scanning
  --help, -h        Show this help
  --version, -v     Show version

${c.gray('Less common:')}
  ${c.gray('--fast            Skip the deep supply-chain check on undeclared packages')}
  ${c.gray('--no-undeclared   Hide "imported but not in package.json" warnings')}
  ${c.gray('--no-cache        Bypass the 24h registry cache')}

${c.bold('Config')} ${c.gray('— optional')} ${c.cyan('.ghostimportrc.json')}${c.gray(' in your project root:')}
  { "ignore": ["@company/*"], "includeUndeclared": true }
`)
  process.exit(0)
}

// ─── Badge ────────────────────────────────────────────────────────────────────

function badgeMarkdown(problems: number): string {
  const clean = problems === 0
  const msg   = clean ? '%E2%9C%93%20clean' : `%F0%9F%91%BB%20${problems}%20ghost${problems > 1 ? 's' : ''}`
  const color = clean ? 'brightgreen' : 'red'
  const url   = `https://img.shields.io/badge/ghostimport-${msg}-${color}`
  return `[![ghostimport](${url})](https://github.com/FGuerreir0/ghostimport)`
}

// ─── Run ──────────────────────────────────────────────────────────────────────

const config = loadConfig(targetDir)

async function runScan() {
  if (!flags.quiet && !flags.json) {
    console.log(`\n${c.bold('ghostimport')} ${c.gray(`v${version}`)}`)
    console.log(c.gray(`Scanning ${targetDir}`))
    console.log()
  }

  let lastProgress = ''

  // \r only redraws on a terminal; piping to a file or a CI log would otherwise
  // accumulate every progress frame as literal output
  const showProgress = !flags.json && !flags.quiet && process.stdout.isTTY

  const results = await scan(targetDir, {
    useCache: !flags.noCache,
    deep: !flags.fast,
    config,
    onProgress: !showProgress ? undefined : ({ pkg, done, total }) => {
      const pct = Math.round((done / total) * 100)
      const bar = '█'.repeat(Math.floor(pct / 5)) + '░'.repeat(20 - Math.floor(pct / 5))
      const line = `  ${c.gray(bar)} ${pct}%  ${c.dim(pkg.slice(0, 30))}`
      process.stdout.write('\r' + line + ' '.repeat(Math.max(0, lastProgress.length - line.length)))
      lastProgress = line
    },
  })

  if (showProgress && lastProgress) {
    process.stdout.write('\r' + ' '.repeat(lastProgress.length + 5) + '\r')
  }

  // ─── JSON output ──────────────────────────────────────────────────────────────

  if (flags.json) {
    console.log(JSON.stringify(results, null, 2))
    return results.missing.length
  }

  // ─── Human output ────────────────────────────────────────────────────────────
  //
  // One list, worst first. Every problem is a package name with its reasons
  // underneath — the previous four-section layout made readers reassemble the
  // story for a single package from findings scattered across the output.

  const riskFor = new Map(results.risks.map(r => [r.pkg, r]))

  console.log(
    `  ${c.gray('Scanned')} ${c.cyan(results.scanned + ' files')}` +
    ` · ${c.cyan(results.packages + ' packages')}` +
    (results.cacheHits > 0 ? ` ${c.gray(`(${results.cacheHits} cached)`)}` : ''),
  )
  console.log()

  const problems = [
    ...results.missing.map(p => ({ ...p, kind: 'missing' as const })),
    ...results.undeclared
      .filter(p => riskFor.get(p.pkg)?.type === 'suspicious')
      .map(p => ({ ...p, kind: 'risky' as const })),
  ]

  for (const problem of problems) {
    const risk = riskFor.get(problem.pkg)
    const label = problem.kind === 'missing'
      ? c.red('does not exist on npm')
      : c.red(`${risk?.type === 'suspicious' ? risk.risk : 'high'} risk`)

    console.log(`  ${c.red('✗')} ${c.bold(problem.pkg)}  ${label}`)

    for (const f of problem.files.slice(0, 3)) console.log(`    ${c.gray('↳')} ${c.dim(f)}`)
    if (problem.files.length > 3) console.log(`    ${c.gray(`↳ +${problem.files.length - 3} more files`)}`)

    if (risk?.typosquatOf) {
      console.log(`    ${c.gray('↳')} ${c.yellow(`1-2 chars from '${risk.typosquatOf}' — likely a typo`)}`)
    }
    if (risk?.type === 'unregistered') {
      console.log(`    ${c.gray('↳')} ${c.yellow('unregistered — anyone could claim this name with a malicious postinstall')}`)
    }
    if (risk?.type === 'suspicious') {
      if (risk.installScripts.length > 0) {
        console.log(`    ${c.gray('↳')} ${c.yellow(`has ${risk.installScripts.join('/')} script — runs code on npm install`)}`)
      }
      const rest = risk.flags.filter(f => !f.startsWith('has ') && !f.startsWith('name is'))
      for (const flag of rest) console.log(`    ${c.gray('↳')} ${c.yellow(flag)}`)
      console.log(`    ${c.gray(`created ${risk.created} · ${risk.downloads ?? '?'}/week · ${risk.versions} version${risk.versions !== 1 ? 's' : ''}`)}`)
    }
    console.log()
  }

  // Undeclared-but-safe packages are a tidiness issue, not a security one —
  // collapsed to a single line so they never crowd out real findings.
  const tidy = results.undeclared.filter(p => riskFor.get(p.pkg)?.type !== 'suspicious')
  if (!flags.noUndeclared && tidy.length > 0) {
    const names = tidy.slice(0, 8).map(p => p.pkg).join(', ')
    const more = tidy.length > 8 ? `, +${tidy.length - 8} more` : ''
    console.log(`  ${c.yellow('⚠')} ${c.gray('not in package.json:')} ${names}${more}\n`)
  }

  if (results.errors.length > 0) {
    console.log(c.gray(`  · ${results.errors.length} package(s) could not be checked (network)\n`))
  }

  if (problems.length === 0) {
    console.log(c.green(c.bold('  No problems found ✓\n')))
  } else {
    console.log(c.red(c.bold(`  ${problems.length} problem${problems.length > 1 ? 's' : ''} found.\n`)))
  }

  if (flags.badge) {
    console.log(c.gray('  README badge:'))
    console.log(`  ${badgeMarkdown(problems.length)}\n`)
  }

  return results.missing.length
}

// ─── Execute ──────────────────────────────────────────────────────────────────

const issues = await runScan()

if (flags.watch) {
  let debounce: ReturnType<typeof setTimeout> | null = null

  console.log(c.gray(`  Watching for changes in ${targetDir}...\n`))

  fsWatch(targetDir, { recursive: true }, (_event, filename) => {
    if (!filename) return
    const ext = path.extname(filename)
    if (!CODE_EXTS.has(ext)) return
    if (filename.includes('node_modules') || filename.includes('dist')) return

    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(async () => {
      console.clear()
      await runScan()
      console.log(c.gray(`  Watching for changes...\n`))
    }, 300)
  })
} else {
  process.exit(issues > 0 ? 1 : 0)
}

