import { extractImports, extractSfcScripts, checkNpm, checkScary, detectTyposquat, loadConfig, loadCache, saveCache } from '../src/index'
import fs from 'fs'
import path from 'path'
import os from 'os'

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

console.log('\ncheckScary() — live npm registry calls')

const [scaryFake, scaryReact] = await Promise.all([
  checkScary('this-package-absolutely-does-not-exist-ghostimport-test-xyz123'),
  checkScary('react'),
])

if (scaryFake.exists === null) {
  console.log(`  ℹ network unavailable (${scaryFake.error}) — skipping checkScary tests`)
} else {
  assert(scaryFake.exists === false, 'non-existent package returns exists: false')
  if (scaryFake.exists === false) {
    assert(scaryFake.squatRisk === 'available', 'non-existent package has squatRisk: available')
  }

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

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
