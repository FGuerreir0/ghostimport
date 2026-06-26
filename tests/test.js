// Simple test runner — zero dependencies
import { extractImports, checkNpm, loadConfig, loadCache, saveCache } from '../src/checker.js'
import fs from 'fs'
import path from 'path'
import os from 'os'

let passed = 0
let failed = 0

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ ${label}`)
    failed++
  }
}

function deepIncludes(arr, value) {
  return arr.includes(value)
}

// ─── extractImports tests ─────────────────────────────────────────────────────

console.log('\nextractImports()')

assert(
  deepIncludes(extractImports(`import React from 'react'`), 'react'),
  'detects default import'
)

assert(
  deepIncludes(extractImports(`import { useState } from 'react'`), 'react'),
  'detects named import'
)

assert(
  deepIncludes(extractImports(`const x = require('express')`), 'express'),
  'detects require()'
)

assert(
  deepIncludes(extractImports(`const x = await import('lodash')`), 'lodash'),
  'detects dynamic import()'
)

assert(
  deepIncludes(extractImports(`import x from '@tanstack/react-query'`), '@tanstack/react-query'),
  'detects scoped package'
)

assert(
  !deepIncludes(extractImports(`import fs from 'fs'`), 'fs'),
  'ignores node builtins'
)

assert(
  !deepIncludes(extractImports(`import x from 'node:path'`), 'node:path'),
  'ignores node: prefixed builtins'
)

assert(
  !deepIncludes(extractImports(`import test from 'node:test'`), 'node:test'),
  'ignores node:test'
)

assert(
  !deepIncludes(extractImports(`import { readFile } from 'node:fs/promises'`), 'node:fs/promises'),
  'ignores node: subpath builtins'
)

assert(
  !deepIncludes(extractImports(`import x from './utils'`), './utils'),
  'ignores relative imports'
)

assert(
  !deepIncludes(extractImports(`import x from '../config'`), '../config'),
  'ignores parent relative imports'
)

assert(
  deepIncludes(extractImports(`import x from 'zod/v3'`), 'zod'),
  'extracts base name from subpath import'
)

assert(
  deepIncludes(extractImports(`export { x } from 'some-pkg'`), 'some-pkg'),
  'detects re-export from'
)

// ─── checkNpm tests (live) ────────────────────────────────────────────────────

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

// ─── Cache tests ──────────────────────────────────────────────────────────────

console.log('\nCache')

const testKey = '__ghostimport_test__'
const testTs = Date.now()
const priorCache = loadCache()
saveCache({ ...priorCache, [testKey]: { exists: true, ts: testTs } })

const loaded = loadCache()
assert(typeof loaded === 'object', 'loadCache() returns an object')
assert(loaded[testKey]?.exists === true, 'cache round-trips exists value')
assert(loaded[testKey]?.ts === testTs, 'cache round-trips timestamp')

// Restore cache without the test key
const { [testKey]: _removed, ...restored } = loaded
saveCache(restored)

// ─── Config tests ─────────────────────────────────────────────────────────────

console.log('\nConfig')

// Test default config (no .ghostimportrc.json in temp dir)
const tmpDir = path.join(os.tmpdir(), 'ghostimport-test-' + Date.now())
fs.mkdirSync(tmpDir, { recursive: true })
const defaultConfig = loadConfig(tmpDir)
assert(Array.isArray(defaultConfig.ignore), 'default config has ignore array')
assert(defaultConfig.includeUndeclared === true, 'default config has includeUndeclared: true')

// Test custom config
fs.writeFileSync(path.join(tmpDir, '.ghostimportrc.json'), JSON.stringify({
  ignore: ['@company/*', 'internal-lib'],
  includeUndeclared: false,
}))
const customConfig = loadConfig(tmpDir)
assert(customConfig.ignore.length === 2, 'custom config loads ignore patterns')
assert(customConfig.ignore[0] === '@company/*', 'custom config preserves pattern values')
assert(customConfig.includeUndeclared === false, 'custom config overrides includeUndeclared')

// Cleanup
fs.rmSync(tmpDir, { recursive: true })

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)