![ghost imports](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/FGuerreir0/BADGE_GIST_ID/raw/ghostimport-badge.json)
![CI](https://github.com/FGuerreir0/ghostimport/actions/workflows/ci.yml/badge.svg)

# ghostimport

**Detects ghost imports — npm packages that don't exist, hallucinated by AI coding tools like Cursor, Copilot, and Claude**

AI coding tools sometimes generate `import` statements for packages that don't exist on npm. `ghostimport` scans your codebase and flags them before they cause a build failure — or worse, before an attacker registers the name with a malicious payload.

```
$ npx ghostimport

  ghostimport v0.1.0
  Scanning /my-project

  Scanned 142 files · 38 unique packages checked

  ✗ 2 hallucinated packages (do not exist on npm):

  ● @openai/functions-runtime
    ↳ src/agents/runner.ts
    ↳ src/agents/tools.ts

  ● react-server-fetch
    ↳ src/data/loader.ts

  Found 2 issues.
```

---

## Why this exists

When an LLM generates code, it predicts the most likely next token — not the most accurate one. It will confidently write `import { createAgent } from '@langchain/agent-runtime'` even if that exact package doesn't exist.

The result: your build fails, or your CI breaks at 2am, or — in the worst case — an attacker who monitors public GitHub repos for unregistered package names [registers it with a `postinstall` script that exfiltrates your `.env`](https://vibedoctor.io/blog/hallucinated-imports-ai-packages-dont-exist).

`ghostimport` catches this in seconds.

---

## Install

```bash
# Run once (no install needed)
npx ghostimport

# Or install globally
npm install -g ghostimport

# Or as a dev dependency
npm install --save-dev ghostimport
```

---

## Usage

```bash
# Scan current directory
ghostimport

# Scan a specific folder
ghostimport ./src

# Only show problems (great for CI)
ghostimport --quiet

# JSON output (pipe to other tools)
ghostimport --json

# Skip "missing from package.json" warnings
ghostimport --no-undeclared

# Help
ghostimport --help
```

### Add to CI (GitHub Actions)

```yaml
- name: Check for hallucinated packages
  run: npx ghostimport --quiet
```

This step will fail (exit code 1) if any hallucinated packages are found.

---

## Programmatic API

```ts
import { scan, extractImports, checkNpm } from 'ghostimport'

// Scan a directory
const results = await scan('./src')

console.log(results.hallucinated)
// [{ pkg: '@openai/functions-runtime', files: ['src/agents/runner.ts'] }]

console.log(results.notInPackageJson)
// [{ pkg: 'zod', files: ['src/validate.ts'] }]

// Check a single package
const { exists } = await checkNpm('some-package-name')
// exists: true | false | null (null = network error)

// Extract imports from a string
const imports = extractImports(`
  import React from 'react'
  import { createAgent } from '@fake/pkg'
`)
// ['react', '@fake/pkg']
```

### TypeScript types

The package ships with full TypeScript declarations. Key types:

```ts
import type { ScanResult, ScanOptions, ScaryEntry, NpmCheckResult } from 'ghostimport'

interface ScanResult {
  scanned: number          // total files scanned
  packages: number         // unique packages found
  hallucinated: {          // packages that DON'T exist on npm
    pkg: string
    files: string[]
  }[]
  notInPackageJson: {      // packages that exist but aren't declared
    pkg: string
    files: string[]
  }[]
  errors: {                // packages that couldn't be checked (network)
    pkg: string
    error: string
    files: string[]
  }[]
  scary: ScaryEntry[]      // supply chain risk entries (--scary mode)
  cacheHits: number
}

interface ScanOptions {
  onProgress?: (p: { pkg: string; exists: boolean | null; done: number; total: number }) => void
  useCache?: boolean       // default: true
  scary?: boolean          // default: false
  config?: Config
}
```

---

## What it scans

- `import x from 'pkg'`
- `import { x } from 'pkg'`
- `import * as x from 'pkg'`
- `require('pkg')`
- `await import('pkg')`
- `export { x } from 'pkg'`
- Scoped packages: `@scope/name`
- Subpath imports: `pkg/utils` → checks `pkg`

**Automatically ignores:**
- Node.js built-ins (`fs`, `path`, `crypto`, `node:*`, ...)
- Relative imports (`./`, `../`)
- `node_modules/`, `dist/`, `.git/`, `build/`

**Supported file types:** `.js` `.jsx` `.ts` `.tsx` `.mjs` `.cjs`

---

## Supply chain risk (`--scary`)

```bash
ghostimport --scary
```

In scary mode, `ghostimport` also checks whether hallucinated package names are available for malicious registration, and flags recently-published packages with suspicious signals (new, few downloads, single version).

---

## Config file

Create `.ghostimportrc.json` in your project root:

```json
{
  "ignore": ["@company/*", "internal-lib"],
  "includeUndeclared": true
}
```

| Field | Default | Description |
|---|---|---|
| `ignore` | `[]` | Packages or scope patterns to skip (`@scope/*` supported) |
| `includeUndeclared` | `true` | Warn on packages that exist on npm but aren't in `package.json` |

---

## Zero dependencies

`ghostimport` has **no runtime dependencies**. The published package uses only Node.js built-ins. This means:

- No supply chain risk from the tool itself
- Fast install
- Works offline for the scan phase (network only needed to check npm)

---

## Contributing

```bash
git clone https://github.com/FGuerreir0/ghostimport
cd ghostimport
npm install

npm run build   # type-check + emit .d.ts + bundle with esbuild
npm test        # run test suite
npm run dev     # run CLI from source (no build needed)
npm run typecheck  # type-check only (no output)
```

Source layout:

| File | Purpose |
|---|---|
| `src/types.ts` | All exported TypeScript interfaces |
| `src/imports.ts` | Import extraction (regex) |
| `src/cache.ts` | Local registry cache (`~/.ghostimport/`) |
| `src/config.ts` | `.ghostimportrc.json` loading |
| `src/npm.ts` | npm registry checks, supply chain heuristics |
| `src/files.ts` | File walker, `package.json` deps, monorepo support |
| `src/scan.ts` | Main `scan()` orchestrator |
| `src/cli.ts` | CLI interface |

---

## License

MIT
