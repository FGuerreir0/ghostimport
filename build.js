import { build } from 'esbuild'
import { spawnSync } from 'child_process'

// Type-check and emit declarations first; abort on type errors
const tsc = spawnSync(
  process.execPath,
  ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'],
  { stdio: 'inherit' },
)
if (tsc.status !== 0) process.exit(tsc.status ?? 1)

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  external: [],
}

await Promise.all([
  build({
    ...shared,
    entryPoints: ['src/index.ts'],
    outfile: 'dist/index.js',
    format: 'esm',
  }),
  build({
    ...shared,
    entryPoints: ['src/index.ts'],
    outfile: 'dist/index.cjs',
    format: 'cjs',
  }),
  build({
    ...shared,
    entryPoints: ['src/cli.ts'],
    outfile: 'dist/cli.js',
    format: 'esm',
    banner: { js: '#!/usr/bin/env node' },
  }),
])

console.log('Built dist/index.js, dist/index.cjs, dist/cli.js, dist/index.d.ts')
