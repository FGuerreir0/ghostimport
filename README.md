![CI](https://github.com/FGuerreir0/ghostimport/actions/workflows/ci.yml/badge.svg)
[![ghostimport](https://img.shields.io/badge/ghostimport-%E2%9C%93%20clean-brightgreen)](https://github.com/FGuerreir0/ghostimport)
# ghostimport

**Detects ghost imports — npm packages that don't exist, hallucinated by AI coding tools like Cursor, Copilot, and Claude**

AI coding tools sometimes generate `import` statements for packages that don't exist on npm. `ghostimport` scans your codebase and flags them before they cause a build failure — or worse, before an attacker registers the name with a malicious payload.

```
$ npx ghostimport

  ghostimport v0.3.0
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

Requires Node.js 22 or later.

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

# Watch mode (re-scans on file changes)
ghostimport --watch

# Check supply chain attack risk (squatting)
ghostimport --scary

# Skip the local registry cache
ghostimport --no-cache

# Print a README badge after scan
ghostimport --badge

# Help
ghostimport --help
```

### Add to CI (GitHub Actions)

Use the built-in action for the simplest setup:

```yaml
- name: Check for hallucinated packages
  uses: FGuerreir0/ghostimport@v0.3.0
  with:
    path: '.'
    scary: 'false'
```

Or run directly:

```yaml
- name: Check for hallucinated packages
  run: npx ghostimport --quiet
```

This step will fail (exit code 1) if any hallucinated packages are found.

### Pre-commit

Add to `.pre-commit-config.yaml`:

```yaml
repos:
  - repo: https://github.com/FGuerreir0/ghostimport
    rev: v0.3.0
    hooks:
      - id: ghostimport
```

---

## Programmatic API

```ts
import { scan, extractImports, checkNpm, checkScary, detectTyposquat } from 'ghostimport'

// Scan a directory
const results = await scan('./src')

console.log(results.hallucinated)
// [{ pkg: '@openai/functions-runtime', files: ['src/agents/runner.ts'] }]

console.log(results.notInPackageJson)
// [{ pkg: 'zod', files: ['src/validate.ts'] }]

// Scan with scary mode enabled
const scaryResults = await scan('./src', { scary: true })
console.log(scaryResults.scary)
// [{ type: 'available', pkg: 'axois', typosquatOf: 'axios', files: [...] }]

// Check a single package exists on npm
const { exists } = await checkNpm('some-package-name')
// exists: true | false | null (null = network error)

// Deep supply chain check for a single package
const info = await checkScary('some-package-name')
// info.exists, info.risk, info.installScripts, info.typosquatOf, ...

// Check if a name looks like a typosquat of a popular package
detectTyposquat('axois')    // => 'axios'
detectTyposquat('expres')   // => 'express'
detectTyposquat('lodash')   // => null (exact match, not a typosquat)
detectTyposquat('zxcvbn')   // => null (unrelated)

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
import type { ScanResult, ScanOptions, ScaryEntry, ScaryCheckResult, NpmCheckResult } from 'ghostimport'

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

// ScaryEntry is a discriminated union on `type`
type ScaryEntry =
  | {
      type: 'available'      // name does NOT exist on npm — free to squat
      pkg: string
      files: string[]
      typosquatOf: string | null  // e.g. 'axios' if name is 1-2 chars away
    }
  | {
      type: 'suspicious'     // name EXISTS on npm but looks risky
      pkg: string
      files: string[]
      risk: 'medium' | 'high'
      flags: string[]        // human-readable reasons
      installScripts: string[]    // e.g. ['postinstall'] — runs on npm install
      typosquatOf: string | null  // e.g. 'lodash' if name is 1-2 chars away
      maintainers: number         // number of npm maintainers
      created: string        // ISO date, e.g. '2024-11-01'
      downloads: number | null    // weekly downloads
      versions: number       // total published versions
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
- Path aliases (`@/`, `~/`, `$lib/`, and tsconfig `paths`)
- URL/protocol imports (`https:`, `data:`, `bun:`, ...)
- Virtual modules (`virtual:`, Vite/Rollup internals)
- `node_modules/`, `dist/`, `.git/`, `build/`

**Supported file types:** `.js` `.jsx` `.ts` `.tsx` `.mjs` `.cjs`

---

## Supply chain risk (`--scary`)

```bash
ghostimport --scary
```

Scary mode adds two layers of supply chain analysis on top of the standard scan.

### Layer 1 — Available for squatting (💀)

For every hallucinated package (doesn't exist on npm), ghostimport flags it as available for malicious registration and checks whether the name is suspiciously close to a popular package:

```
  💀 1 package name available for malicious registration:

  ● axois
    ↳ TYPOSQUAT: 1-2 chars away from 'axios' — classic squatting pattern
    ↳ Anyone can register this name with a malicious postinstall script
    ↳ If installed, it could exfiltrate .env, tokens, SSH keys
```

The key distinction: these names **do not exist on npm yet**. The risk is that someone registers them before you fix the import.

### Layer 2 — Suspicious existing packages (🕵️)

For packages that exist on npm but aren't in your `package.json`, ghostimport does a deep registry check and flags suspicious signals:

```
  🕵️  1 suspicious package (potential squats):

  ● some-util [high risk]
    ↳ CRITICAL: has postinstall hook — executes code on npm install
    ↳ TYPOSQUAT: 1-2 chars away from 'lodash'
    ↳ single maintainer
    created 2024-11-01 · 12 downloads/week · 1 version
```

### Signals checked

| Signal | Risk weight | Why it matters |
|---|---|---|
| `postinstall` / `preinstall` / `install` script | **critical → high** | Runs arbitrary code on `npm install` |
| Name is 1-2 chars from a popular package | **critical → high** | Classic typosquatting pattern |
| Package created < 30 days ago | medium | New packages with no track record |
| < 50 weekly downloads | medium | Extremely low adoption |
| Single version published | medium | Abandoned or one-shot |
| Single maintainer | medium (amplifier only) | Raises risk when combined with other signals — not suspicious alone |

Risk is `high` if any critical signal is present, or if 2+ medium signals apply. Only `medium` and `high` packages appear in the output.

### `--scary` and JSON

The `scary` array is included in `--json` output with all fields, making it easy to build custom alerting:

```bash
ghostimport --scary --json | jq '.scary[] | select(.type == "suspicious" and (.installScripts | length > 0))'
```

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
| `src/npm.ts` | npm registry checks, `checkScary`, `detectTyposquat` |
| `src/files.ts` | File walker, `package.json` deps, monorepo support |
| `src/scan.ts` | Main `scan()` orchestrator |
| `src/cli.ts` | CLI interface |

---

## License

MIT
