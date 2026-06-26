import { build } from 'esbuild'
import { copyFileSync } from 'fs'

const shared = {
  entryPoints: ['src/index.js'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  external: [],
}

await Promise.all([
  build({
    ...shared,
    outfile: 'dist/index.js',
    format: 'esm',
  }),
  build({
    ...shared,
    outfile: 'dist/index.cjs',
    format: 'cjs',
  }),
  build({
    ...shared,
    entryPoints: ['src/cli.js'],
    outfile: 'dist/cli.js',
    format: 'esm',
    banner: { js: '#!/usr/bin/env node' },
  }),
])

copyFileSync('src/index.d.ts', 'dist/index.d.ts')

console.log('Built dist/index.js, dist/index.cjs, dist/cli.js, dist/index.d.ts')
