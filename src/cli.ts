import path from 'path'
import { readFileSync, watch as fsWatch, statSync } from 'fs'
import { fileURLToPath } from 'url'
import { scan } from './scan'
import { loadConfig } from './config'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
) as { version: string }

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
  scary:        args.includes('--scary'),
  help:         args.includes('--help') || args.includes('-h'),
  version:      args.includes('--version') || args.includes('-v'),
}

if (flags.version) {
  console.log(`ghostimport v${version}`)
  process.exit(0)
}

if (flags.help) {
  console.log(`
${c.bold('ghostimport')} — detect hallucinated npm packages in your code

${c.bold('Usage:')}
  ghostimport [dir] [options]

${c.bold('Options:')}
  --quiet, -q       Only show problems (no progress)
  --json            Output results as JSON
  --watch, -w       Watch for file changes and re-scan
  --no-undeclared   Skip "imported but not in package.json" warnings
  --scary           Check for supply chain attack risk (squatting)
  --no-cache        Skip the local registry cache
  --version, -v     Show version
  --help, -h        Show this help

${c.bold('Config:')}
  Create ${c.cyan('.ghostimportrc.json')} in your project root:
  {
    "ignore": ["@company/*", "internal-lib"],
    "includeUndeclared": true
  }

${c.bold('Examples:')}
  ghostimport                  scan current directory
  ghostimport ./src            scan specific folder
  ghostimport --quiet          only show issues
  ghostimport --scary          check supply chain risk
  ghostimport --json           machine-readable output
`)
  process.exit(0)
}

// ─── Run ──────────────────────────────────────────────────────────────────────

const config = loadConfig(targetDir)

async function runScan() {
  if (!flags.quiet && !flags.json) {
    console.log(`\n${c.bold('ghostimport')} ${c.gray(`v${version}`)}`)
    console.log(c.gray(`Scanning ${targetDir}`))
    if (flags.scary) console.log(c.magenta('  ⚠  Scary mode: checking supply chain risk'))
    console.log()
  }

  let lastProgress = ''

  const results = await scan(targetDir, {
  useCache: !flags.noCache,
  scary: flags.scary,
  config,
  onProgress: flags.json || flags.quiet ? undefined : ({ pkg, done, total }) => {
    const pct = Math.round((done / total) * 100)
    const bar = '█'.repeat(Math.floor(pct / 5)) + '░'.repeat(20 - Math.floor(pct / 5))
    const line = `  ${c.gray(bar)} ${pct}%  ${c.dim(pkg.slice(0, 30))}`
    process.stdout.write('\r' + line + ' '.repeat(Math.max(0, lastProgress.length - line.length)))
    lastProgress = line
  },
})

  if (!flags.json && !flags.quiet && lastProgress) {
    process.stdout.write('\r' + ' '.repeat(lastProgress.length + 5) + '\r')
  }

  // ─── JSON output ──────────────────────────────────────────────────────────────

  if (flags.json) {
    console.log(JSON.stringify(results, null, 2))
    return results.hallucinated.length
  }

  // ─── Human output ────────────────────────────────────────────────────────────

  const totalIssues = results.hallucinated.length +
    (flags.noUndeclared ? 0 : results.notInPackageJson.length)

  console.log(
    `  ${c.gray('Scanned')} ${c.cyan(results.scanned + ' files')}` +
    ` · ${c.cyan(results.packages + ' unique packages')} checked` +
    (results.cacheHits > 0 ? ` ${c.gray(`(${results.cacheHits} cached)`)}` : '') +
    '\n',
  )

  // ── Hallucinated packages ────────────────────────────────────────────────────
  if (results.hallucinated.length === 0) {
    console.log(c.green('  ✓ No hallucinated packages found'))
  } else {
    console.log(c.bold(c.red(`  ✗ ${results.hallucinated.length} hallucinated package${results.hallucinated.length > 1 ? 's' : ''} (do not exist on npm):\n`)))
    for (const { pkg, files } of results.hallucinated) {
      console.log(`  ${c.red('●')} ${c.bold(pkg)}`)
      for (const f of files.slice(0, 3)) console.log(`    ${c.gray('↳')} ${c.dim(f)}`)
      if (files.length > 3) console.log(`    ${c.gray(`↳ ...and ${files.length - 3} more files`)}`)
    }
  }

  // ── Scary mode output ────────────────────────────────────────────────────────
  if (flags.scary && results.scary.length > 0) {
    console.log()
    const available = results.scary.filter(s => s.type === 'available')
    const suspicious = results.scary.filter(s => s.type === 'suspicious')

    if (available.length > 0) {
      console.log(c.bold(c.magenta(`  💀 ${available.length} package name${available.length > 1 ? 's' : ''} available for malicious registration:\n`)))
      for (const { pkg } of available) {
        console.log(`  ${c.magenta('●')} ${c.bold(pkg)}`)
        console.log(`    ${c.red('↳ Anyone can register this name with a malicious postinstall script')}`)
        console.log(`    ${c.red('↳ If installed, it could exfiltrate .env, tokens, SSH keys')}`)
      }
    }

    if (suspicious.length > 0) {
      console.log()
      console.log(c.bold(c.magenta(`  🕵️  ${suspicious.length} suspicious package${suspicious.length > 1 ? 's' : ''} (potential squats):\n`)))
      for (const entry of suspicious) {
        if (entry.type !== 'suspicious') continue
        console.log(`  ${c.magenta('●')} ${c.bold(entry.pkg)} ${c.gray(`(created ${entry.created}, ${entry.downloads ?? '?'} downloads/week)`)}`)
        for (const flag of entry.flags) console.log(`    ${c.yellow('↳')} ${flag}`)
      }
    }
  }

  // ── Not in package.json ──────────────────────────────────────────────────────
  if (!flags.noUndeclared && results.notInPackageJson.length > 0) {
    console.log()
    console.log(c.bold(c.yellow(`  ⚠  ${results.notInPackageJson.length} package${results.notInPackageJson.length > 1 ? 's' : ''} imported but missing from package.json:\n`)))
    for (const { pkg, files } of results.notInPackageJson.slice(0, 10)) {
      console.log(`  ${c.yellow('●')} ${c.bold(pkg)}`)
      for (const f of files.slice(0, 2)) console.log(`    ${c.gray('↳')} ${c.dim(f)}`)
    }
    if (results.notInPackageJson.length > 10) {
      console.log(`  ${c.gray(`  ...and ${results.notInPackageJson.length - 10} more`)}`)
    }
  }

  // ── Errors ───────────────────────────────────────────────────────────────────
  if (results.errors.length > 0) {
    console.log()
    console.log(c.gray(`  ⚡ ${results.errors.length} package(s) could not be checked (network/timeout)`))
  }

  // ── Final verdict ─────────────────────────────────────────────────────────────
  console.log()
  if (totalIssues === 0 && results.scary.length === 0) {
    console.log(c.green(c.bold('  All good! ✓\n')))
  } else if (flags.scary && results.scary.length > 0) {
    const scaryCount = results.scary.filter(s => s.type === 'available').length
    console.log(c.red(c.bold(`  Found ${totalIssues} issue${totalIssues > 1 ? 's' : ''} · ${scaryCount} supply chain risk${scaryCount > 1 ? 's' : ''}\n`)))
  } else {
    console.log(c.red(c.bold(`  Found ${totalIssues} issue${totalIssues > 1 ? 's' : ''}.\n`)))
  }

  return results.hallucinated.length
}

// ─── Execute ──────────────────────────────────────────────────────────────────

const issues = await runScan()

if (flags.watch) {
  const CODE_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'])
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

