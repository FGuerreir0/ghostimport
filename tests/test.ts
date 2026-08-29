import {
  extractImports, checkNpm, checkPackageRisk, detectTyposquat,
  verifyPackages, extractInstallTargets, scan,
} from '../src/index'
// Internals — deliberately not part of the public API
import { extractSfcScripts } from '../src/sfc'
import { loadConfig } from '../src/config'
import { loadCache, saveCache } from '../src/cache'
import { hasBlockingVerdict } from '../src/verify'
import { specToPackageName } from '../src/install'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawn } from 'child_process'

let passed = 0
let failed = 0

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ ${label}`)
    failed++
  }
}

function includes(arr: string[], value: string): boolean {
  return arr.includes(value)
}

// ─── extractImports ───────────────────────────────────────────────────────────

console.log('\nextractImports()')

assert(includes(extractImports(`import React from 'react'`), 'react'), 'detects default import')
assert(includes(extractImports(`import { useState } from 'react'`), 'react'), 'detects named import')
assert(includes(extractImports(`const x = require('express')`), 'express'), 'detects require()')
assert(includes(extractImports(`const x = await import('lodash')`), 'lodash'), 'detects dynamic import()')
assert(includes(extractImports(`import x from '@tanstack/react-query'`), '@tanstack/react-query'), 'detects scoped package')
assert(!includes(extractImports(`import fs from 'fs'`), 'fs'), 'ignores node builtins')
assert(!includes(extractImports(`import x from 'node:path'`), 'node:path'), 'ignores node: prefixed builtins')
assert(!includes(extractImports(`import test from 'node:test'`), 'node:test'), 'ignores node:test')
assert(!includes(extractImports(`import { readFile } from 'node:fs/promises'`), 'node:fs/promises'), 'ignores node: subpath builtins')
assert(!includes(extractImports(`import x from './utils'`), './utils'), 'ignores relative imports')
assert(!includes(extractImports(`import x from '../config'`), '../config'), 'ignores parent relative imports')
assert(includes(extractImports(`import x from 'zod/v3'`), 'zod'), 'extracts base name from subpath import')
assert(includes(extractImports(`export { x } from 'some-pkg'`), 'some-pkg'), 'detects re-export from')
assert(!includes(extractImports(`var x = ' + obj.partner'`), ' + obj.partner'), 'rejects expressions with spaces and operators')
assert(!includes(extractImports(`require(' + ISO_CODES[obj.partner.toLowerCase()]')`), ' + ISO_CODES[obj.partner.toLowerCase()]'), 'rejects expressions with brackets')
assert(!includes(extractImports("import 'multi\nline'"), 'multi'), 'rejects cross-line matches')

// ─── extractSfcScripts ───────────────────────────────────────────────────────

console.log('\nextractSfcScripts()')

const vueSfc = `<template>
  <p>To install, write: import x from 'template-fake-pkg'</p>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import axios from 'axios'
</script>

<script>
import legacy from 'vue-legacy-helper'
</script>`

const vueImports = extractImports(extractSfcScripts(vueSfc, '.vue'))
assert(includes(vueImports, 'vue'), 'vue: detects import in <script setup>')
assert(includes(vueImports, 'axios'), 'vue: detects second import in same block')
assert(includes(vueImports, 'vue-legacy-helper'), 'vue: detects import in second <script> block')
assert(!includes(vueImports, 'template-fake-pkg'), 'vue: ignores package names in template markup')

const svelteSfc = `<script context="module">
  import { writable } from 'svelte/store'
</script>

<script>
  import dayjs from 'dayjs'
</script>

<h1>import nothing from 'markup-fake-pkg'</h1>`

const svelteImports = extractImports(extractSfcScripts(svelteSfc, '.svelte'))
assert(includes(svelteImports, 'svelte'), 'svelte: detects import in module script')
assert(includes(svelteImports, 'dayjs'), 'svelte: detects import in instance script')
assert(!includes(svelteImports, 'markup-fake-pkg'), 'svelte: ignores package names in markup')

const astroSfc = `---
import Layout from '../layouts/Layout.astro'
import { z } from 'zod'
---

<Layout>
  <script>
    import confetti from 'canvas-confetti'
  </script>
</Layout>`

const astroImports = extractImports(extractSfcScripts(astroSfc, '.astro'))
assert(includes(astroImports, 'zod'), 'astro: detects import in frontmatter')
assert(includes(astroImports, 'canvas-confetti'), 'astro: detects import in <script> block')
assert(!includes(astroImports, '../layouts/Layout.astro'), 'astro: ignores relative imports in frontmatter')

assert(extractSfcScripts('<template><p>no scripts here</p></template>', '.vue') === '', 'returns empty string when no script blocks exist')
assert(!includes(extractImports(extractSfcScripts(`---\nnot frontmatter\n---`, '.vue')), 'not'), 'vue: does not treat --- fences as frontmatter')

// ─── checkNpm (live) ──────────────────────────────────────────────────────────

console.log('\ncheckNpm() — live npm registry calls')

const [reactResult, fakeResult] = await Promise.all([
  checkNpm('react'),
  checkNpm('this-package-absolutely-does-not-exist-ghostimport-test-xyz123'),
])

if (reactResult.exists === null) {
  console.log(`  ℹ network unavailable (${reactResult.error}) — skipping live registry tests`)
} else {
  assert(reactResult.exists === true, '"react" exists on npm')
  assert(fakeResult.exists === false, 'fake package returns exists: false')
}

// ─── Cache ────────────────────────────────────────────────────────────────────

console.log('\nCache')

const testKey = '__ghostimport_test__'
const testTs = Date.now()
const priorCache = loadCache()
saveCache({ ...priorCache, [testKey]: { exists: true, ts: testTs } })

const loaded = loadCache()
assert(typeof loaded === 'object', 'loadCache() returns an object')
assert(loaded[testKey]?.exists === true, 'cache round-trips exists value')
assert(loaded[testKey]?.ts === testTs, 'cache round-trips timestamp')

const restored = { ...loaded }
delete restored[testKey]
saveCache(restored)

// ─── Config ───────────────────────────────────────────────────────────────────

console.log('\nConfig')

const tmpDir = path.join(os.tmpdir(), 'ghostimport-test-' + Date.now())
fs.mkdirSync(tmpDir, { recursive: true })

const defaultConfig = loadConfig(tmpDir)
assert(Array.isArray(defaultConfig.ignore), 'default config has ignore array')
assert(defaultConfig.includeUndeclared === true, 'default config has includeUndeclared: true')

fs.writeFileSync(path.join(tmpDir, '.ghostimportrc.json'), JSON.stringify({
  ignore: ['@company/*', 'internal-lib'],
  includeUndeclared: false,
}))
const customConfig = loadConfig(tmpDir)
assert(customConfig.ignore.length === 2, 'custom config loads ignore patterns')
assert(customConfig.ignore[0] === '@company/*', 'custom config preserves pattern values')
assert(customConfig.includeUndeclared === false, 'custom config overrides includeUndeclared')

fs.rmSync(tmpDir, { recursive: true })

// ─── detectTyposquat ─────────────────────────────────────────────────────────

console.log('\ndetectTyposquat()')

assert(detectTyposquat('axois') === 'axios', 'catches transposition (axois → axios)')
assert(detectTyposquat('expres') === 'express', 'catches missing char (expres → express)')
assert(detectTyposquat('webpakc') === 'webpack', 'catches character swap (webpakc → webpack)')
assert(detectTyposquat('lodsh') === 'lodash', 'catches missing char (lodsh → lodash)')
assert(detectTyposquat('lodash') === null, 'returns null for exact match (lodash)')
assert(detectTyposquat('react') === null, 'returns null for exact match (react)')
assert(detectTyposquat('pg') === null, 'returns null for names shorter than 5 chars')
assert(detectTyposquat('zxcvbn') === null, 'returns null for unrelated names')
assert(detectTyposquat('@types/reakt') === 'react', 'strips scope before comparing (@types/reakt → react)')

// ─── checkScary (live) ───────────────────────────────────────────────────────

console.log('\ncheckPackageRisk() — live npm registry calls')

const [scaryFake, scaryReact] = await Promise.all([
  checkPackageRisk('this-package-absolutely-does-not-exist-ghostimport-test-xyz123'),
  checkPackageRisk('react'),
])

if (scaryFake.exists === null) {
  console.log(`  ℹ network unavailable (${scaryFake.error}) — skipping checkPackageRisk tests`)
} else {
  assert(scaryFake.exists === false, 'non-existent package returns exists: false')

  if (scaryReact.exists === true) {
    assert(scaryReact.risk === 'low', '"react" has low supply chain risk')
    assert(Array.isArray(scaryReact.installScripts), '"react" has installScripts array')
    assert(scaryReact.installScripts.length === 0, '"react" has no install hooks')
    assert(scaryReact.typosquatOf === null, '"react" is not flagged as a typosquat')
    assert(typeof scaryReact.maintainers === 'number', '"react" has maintainers count')
    assert(scaryReact.maintainers > 0, '"react" has at least one maintainer')
    // single maintainer should not trigger risk alone for established packages
    assert(!scaryReact.flags.includes('single maintainer'), '"react" single-maintainer flag not set without other signals')
  }
}

// ─── extractInstallTargets ───────────────────────────────────────────────────

console.log('\nextractInstallTargets()')

function targets(cmd: string): string[] {
  return extractInstallTargets(cmd).sort()
}

assert(targets('npm install axios').join() === 'axios', 'npm install')
assert(targets('npm i axios zod').join() === 'axios,zod', 'multiple packages')
assert(targets('npm i -D typescript').join() === 'typescript', 'skips flags')
assert(targets('npm install --save-dev @types/node').join() === '@types/node', 'scoped package')
assert(targets('npm i axios@1.6.0').join() === 'axios', 'strips version')
assert(targets('npm i @scope/pkg@^2.0.0').join() === '@scope/pkg', 'strips version from scoped package')
assert(targets('pnpm add react').join() === 'react', 'pnpm add')
assert(targets('yarn add lodash').join() === 'lodash', 'yarn add')
assert(targets('bun add hono').join() === 'hono', 'bun add')
assert(targets('npm isntall axios').join() === 'axios', 'npm typo alias (isntall)')
assert(targets('sudo npm i -g pm2').join() === 'pm2', 'tolerates sudo and -g')
assert(targets('npm run build && npm i axios').join() === 'axios', 'finds install in a chained command')
assert(targets('npm i left-pad; npm i right-pad').join() === 'left-pad,right-pad', 'handles multiple chained installs')
assert(targets('alias@npm:real-package').length === 0, 'a bare spec is not a command')
assert(targets('npm i alias@npm:real-package').join() === 'real-package', 'resolves npm: alias to the real package')

assert(targets('npm install').length === 0, 'bare npm install has no targets')
assert(targets('npm ci').length === 0, 'npm ci has no targets')
assert(targets('yarn install').length === 0, 'yarn install has no targets')
assert(targets('npm run test').length === 0, 'npm run is not an install')
assert(targets('echo npm install axios').length === 0, 'ignores install mentioned as an argument')
assert(targets('npm i ./local-package').length === 0, 'ignores local paths')
assert(targets('npm i https://example.com/pkg.tgz').length === 0, 'ignores URLs')
assert(targets('npm i user/repo').length === 0, 'ignores GitHub shorthand')
assert(targets('npm i github:user/repo').length === 0, 'ignores github: protocol')
assert(targets('npm i ../sibling').length === 0, 'ignores parent paths')

assert(specToPackageName('axios@~1.2.3') === 'axios', 'specToPackageName strips range')
assert(specToPackageName('@a/b') === '@a/b', 'specToPackageName keeps scoped name')
assert(specToPackageName('-D') === null, 'specToPackageName rejects flags')

// ─── verifyPackages ──────────────────────────────────────────────────────────

console.log('\nverifyPackages()')

const networkAvailable = scaryFake.exists !== null

assert((await verifyPackages([])).length === 0, 'empty input returns empty result')

if (!networkAvailable) {
  console.log('  ℹ network unavailable — skipping live verifyPackages tests')
} else {
  const verdicts = await verifyPackages(['react', 'this-package-absolutely-does-not-exist-ghostimport-test-xyz123'])
  const byName = new Map(verdicts.map(v => [v.pkg, v]))
  assert(byName.get('react')?.status === 'ok', 'existing package is ok')
  assert(byName.get('this-package-absolutely-does-not-exist-ghostimport-test-xyz123')?.status === 'missing', 'unpublished package is missing')
  assert(hasBlockingVerdict(verdicts), 'missing package is blocking')
  assert(!hasBlockingVerdict([{ pkg: 'x', status: 'unknown', typosquatOf: null }]), 'unknown verdict never blocks')
}

// ─── scan ────────────────────────────────────────────────────────────────────

console.log('\nscan()')

const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostimport-scan-'))
fs.writeFileSync(path.join(scanDir, 'package.json'), JSON.stringify({ dependencies: { react: '^18.0.0' } }))
fs.writeFileSync(path.join(scanDir, 'app.ts'), [
  `import React from 'react'`,                                                        // declared, exists
  `import { z } from 'zod'`,                                                          // undeclared, exists
  `import x from 'this-package-absolutely-does-not-exist-ghostimport-test-xyz123'`,   // missing
  `import './local'`,                                                                 // ignored
].join('\n'))

if (!networkAvailable) {
  console.log('  ℹ network unavailable — skipping scan tests')
} else {
  const result = await scan(scanDir)
  assert(result.scanned === 1, 'counts scanned files')
  assert(result.packages === 3, 'counts unique packages, ignoring relative imports')
  assert(result.missing.map(p => p.pkg).join() === 'this-package-absolutely-does-not-exist-ghostimport-test-xyz123', 'missing holds only non-existent packages')
  assert(result.missing[0].files.join() === 'app.ts', 'missing entries carry their source files')
  assert(result.undeclared.map(p => p.pkg).join() === 'zod', 'undeclared excludes declared deps')
  assert(result.risks.some(r => r.type === 'unregistered' && r.pkg === result.missing[0].pkg), 'every missing name yields an unregistered risk')
  assert(!result.risks.some(r => r.pkg === 'zod'), 'a healthy undeclared package raises no risk')

  // deep: false must still report squattable names — that layer costs no extra requests
  const fast = await scan(scanDir, { deep: false })
  assert(fast.risks.some(r => r.type === 'unregistered'), 'deep:false still flags unregistered names')
}

fs.rmSync(scanDir, { recursive: true })

// ─── MCP server (subprocess) ─────────────────────────────────────────────────

console.log('\nMCP server')

interface RpcMessage { id?: number; result?: Record<string, unknown>; error?: unknown }

/** Drive the stdio server with a batch of requests and collect the responses. */
function runMcp(requests: unknown[]): Promise<RpcMessage[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'mcp'], {
      cwd: path.join(import.meta.dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => { out += d.toString() })
    child.stderr.on('data', (d: Buffer) => { err += d.toString() })
    child.on('error', reject)
    child.on('close', () => {
      const messages: RpcMessage[] = []
      for (const line of out.split('\n')) {
        if (!line.trim()) continue
        try { messages.push(JSON.parse(line) as RpcMessage) } catch { reject(new Error(`non-JSON on stdout: ${line}\n${err}`)); return }
      }
      resolve(messages)
    })
    for (const req of requests) child.stdin.write(JSON.stringify(req) + '\n')
    child.stdin.end()
  })
}

const mcpBase = await runMcp([
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  { jsonrpc: '2.0', id: 3, method: 'ping' },
  { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } },
])

const init = mcpBase.find(m => m.id === 1)
assert(init?.result?.protocolVersion === '2025-06-18', 'initialize echoes a supported protocol version')
assert((init?.result?.serverInfo as { name?: string } | undefined)?.name === 'ghostimport', 'initialize reports serverInfo')
assert(!!(init?.result?.capabilities as { tools?: unknown } | undefined)?.tools, 'initialize advertises tools capability')

assert(!mcpBase.some(m => m.id === undefined && m.result !== undefined), 'notifications produce no response')

const toolList = (mcpBase.find(m => m.id === 2)?.result?.tools ?? []) as Array<{ name: string; inputSchema?: unknown }>
assert(toolList.length === 3, 'tools/list returns three tools')
assert(toolList.every(t => !!t.name && !!t.inputSchema), 'every tool has a name and inputSchema')
assert(toolList.some(t => t.name === 'check_packages'), 'exposes check_packages')
assert(toolList.some(t => t.name === 'check_install_command'), 'exposes check_install_command')
assert(toolList.some(t => t.name === 'scan_project'), 'exposes scan_project')

assert(mcpBase.find(m => m.id === 3)?.result !== undefined, 'ping responds')
assert(mcpBase.find(m => m.id === 4)?.error !== undefined, 'unknown tool returns an error')

if (networkAvailable) {
  const [called] = await runMcp([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'check_packages', arguments: { packages: ['this-package-absolutely-does-not-exist-ghostimport-test-xyz123'] } },
    },
  ]).then(msgs => [msgs.find(m => m.id === 2)])

  const text = ((called?.result?.content ?? []) as Array<{ text?: string }>)[0]?.text ?? ''
  assert(text.includes('DOES NOT EXIST'), 'check_packages reports a hallucinated package')
} else {
  console.log('  ℹ network unavailable — skipping live tools/call test')
}

// ─── Agent hook (subprocess) ─────────────────────────────────────────────────

console.log('\nAgent hook')

function runHookProcess(payload: unknown): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'hook'], {
      cwd: path.join(import.meta.dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stdout.resume()
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 0, stderr }))
    child.stdin.write(JSON.stringify(payload))
    child.stdin.end()
  })
}

assert((await runHookProcess({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} })).code === 0, 'ignores unrelated tools')
assert((await runHookProcess({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls -la' } })).code === 0, 'allows non-install commands')
assert((await runHookProcess({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm ci' } })).code === 0, 'allows npm ci')
assert((await runHookProcess({ tool_name: 'Write', tool_input: { file_path: 'README.md' } })).code === 0, 'ignores non-code files')

if (networkAvailable) {
  const blocked = await runHookProcess({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'npm install this-package-absolutely-does-not-exist-ghostimport-test-xyz123' },
    cwd: path.join(import.meta.dirname, '..'),
  })
  assert(blocked.code === 2, 'blocks installing a package that does not exist')
  assert(blocked.stderr.includes('DOES NOT EXIST'), 'block message explains why')

  const allowed = await runHookProcess({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'npm install react' },
    cwd: path.join(import.meta.dirname, '..'),
  })
  assert(allowed.code === 0, 'allows installing a real, low-risk package')

  const hookTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostimport-hook-'))
  const badFile = path.join(hookTmp, 'bad.ts')
  fs.writeFileSync(badFile, `import x from 'this-package-absolutely-does-not-exist-ghostimport-test-xyz123'\n`)
  const edited = await runHookProcess({
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: badFile },
    cwd: hookTmp,
  })
  assert(edited.code === 2, 'flags a hallucinated import written into a file')
  fs.rmSync(hookTmp, { recursive: true })
} else {
  console.log('  ℹ network unavailable — skipping live hook tests')
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
