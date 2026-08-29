<p align="center">
  <img src="assets/logo.png" width="128" alt="ghostimport logo">
</p>

<h1 align="center">ghostimport</h1>

<p align="center">
  <strong>Stops your AI coding agent from installing npm packages that don't exist.</strong>
</p>

<p align="center">
  <img src="https://github.com/FGuerreir0/ghostimport/actions/workflows/ci.yml/badge.svg" alt="CI">
  <a href="https://www.npmjs.com/package/ghostimport"><img src="https://img.shields.io/npm/v/ghostimport" alt="npm"></a>
  <a href="https://github.com/FGuerreir0/ghostimport"><img src="https://img.shields.io/badge/ghostimport-%E2%9C%93%20clean-brightgreen" alt="ghostimport"></a>
</p>

<p align="center">
  <a href="https://fguerreir0.github.io/ghostimport/"><strong>How the attack works →</strong></a>
</p>

---

Your agent invents a package name. It doesn't exist on npm *yet*. Someone is watching for exactly that, and the moment they register it, `npm install` runs their `postinstall` script on your machine.

This is **slopsquatting**. `npm audit`, Snyk and Socket don't catch it — they only inspect packages you've already installed. ghostimport checks names against the live registry at the moment your agent writes or installs them.

```
$ ghostimport

  Scanned 142 files · 38 packages

  ✗ react-server-fetch  does not exist on npm
    ↳ src/data/loader.ts
    ↳ unregistered — anyone could claim this name with a malicious postinstall

  ✗ axois  high risk
    ↳ src/api/client.ts
    ↳ 1-2 chars from 'axios' — likely a typo
    ↳ has postinstall script — runs code on npm install
    created 2019-08-29 · 1245/week · 1 version

  2 problems found.
```

## Install

```bash
npm install -g ghostimport     # or: npx ghostimport
```

Node.js 22+. Zero runtime dependencies — the published package uses only Node built-ins.

## Use it with your AI agent

This is the part that matters. A CI check tells you about a bad package *after* it's in your repo; these stop it at the moment it's written.

### Hooks — the enforcing one

Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "ghostimport hook" }] }
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write|MultiEdit", "hooks": [{ "type": "command", "command": "ghostimport hook" }] }
    ]
  }
}
```

- **`PreToolUse` on Bash** — reads any install command and **denies the tool call** if it would fetch a package that doesn't exist, is a typosquat, or ships an install script. This is the one that stops a real attack.
- **`PostToolUse` on edits** — checks imports the agent just wrote and tells it to fix them.

The agent sees why it was stopped:

```
ghostimport blocked this: the install command below would fetch packages that
are unsafe or do not exist.

  • 'axois' exists but is high risk: name is 1-2 chars from 'axios';
    single version published.

Do not retry this command as written.
```

**It fails open.** Registry unreachable, malformed payload, or a check exceeding its 20-second budget → exits 0 and stays out of the way. A security tool that wedges your agent when you're offline gets uninstalled by Friday.

### MCP — the self-service one

Lets the model verify a name *before* it writes the import. Hooks are mandatory; MCP tools are offered — use both.

```bash
claude mcp add ghostimport -- npx -y ghostimport mcp
```

<details>
<summary>Cursor, Windsurf, and other MCP clients</summary>

Add to `.cursor/mcp.json` or your client's config:

```json
{
  "mcpServers": {
    "ghostimport": {
      "command": "npx",
      "args": ["-y", "ghostimport", "mcp"]
    }
  }
}
```

| Tool | What it does |
|---|---|
| `check_packages` | Verify package names exist on npm. `deep` adds risk heuristics. |
| `check_install_command` | Vet a full `npm`/`pnpm`/`yarn`/`bun` install command. |
| `scan_project` | Audit a whole directory. |

</details>

## CLI

```bash
ghostimport              # scan the current directory
ghostimport ./src        # scan a folder
ghostimport --json       # machine-readable
ghostimport --watch      # re-scan on change
```

Exits `1` if any imported package doesn't exist, so it works as a CI gate as-is.

<details>
<summary>All options</summary>

| Flag | Effect |
|---|---|
| `--quiet`, `-q` | Only show problems |
| `--json` | Output results as JSON |
| `--watch`, `-w` | Re-scan on file changes |
| `--badge` | Print a README badge after scanning |
| `--fast` | Skip the deep supply-chain check on undeclared packages |
| `--no-undeclared` | Hide "imported but not in package.json" warnings |
| `--no-cache` | Bypass the 24h registry cache |
| `--version`, `-v` · `--help`, `-h` | |

Optional `.ghostimportrc.json` in your project root:

```json
{ "ignore": ["@company/*", "internal-lib"], "includeUndeclared": true }
```

</details>

<details>
<summary>CI: GitHub Actions and pre-commit</summary>

```yaml
- uses: FGuerreir0/ghostimport@v0.5.0
  with:
    path: '.'
```

Or just `run: npx ghostimport --quiet`.

For [pre-commit](https://pre-commit.com), in `.pre-commit-config.yaml`:

```yaml
repos:
  - repo: https://github.com/FGuerreir0/ghostimport
    rev: v0.5.0
    hooks:
      - id: ghostimport
```

</details>

## API

```ts
import { verifyPackages, scan } from 'ghostimport'

await verifyPackages(['axios', 'axois'], { deep: true })
// [ { pkg: 'axios', status: 'ok', typosquatOf: null },
//   { pkg: 'axois', status: 'suspicious', risk: 'high', typosquatOf: 'axios', ... } ]

const { missing, undeclared, risks } = await scan('./src')
```

`status` is `'ok' | 'missing' | 'suspicious' | 'unknown'`. `'unknown'` means the registry was unreachable — never treat it as a failure.

<details>
<summary>Full API and TypeScript types</summary>

| Export | Purpose |
|---|---|
| `scan(dir, opts?)` | Scan a directory. Returns `ScanResult`. |
| `verifyPackages(names, opts?)` | Check a list of names. Returns `PackageVerdict[]`. |
| `checkNpm(name)` | Does this one package exist? |
| `checkPackageRisk(name)` | Full supply-chain check for one package. |
| `detectTyposquat(name)` | Returns the popular package it's 1-2 chars from, or `null`. |
| `extractImports(code)` | Package names from a source string. |
| `extractInstallTargets(cmd)` | Packages a shell command would install. |

```ts
interface ScanResult {
  scanned: number
  packages: number
  missing: { pkg: string; files: string[] }[]     // don't exist on npm
  undeclared: { pkg: string; files: string[] }[]  // exist, but not in package.json
  risks: RiskEntry[]                              // supply-chain findings
  errors: { pkg: string; error: string; files: string[] }[]
  cacheHits: number
}

type RiskEntry =
  | { pkg: string; files: string[]; type: 'unregistered'; typosquatOf: string | null }
  | { pkg: string; files: string[]; type: 'suspicious'
      risk: 'medium' | 'high'; flags: string[]; installScripts: string[]
      typosquatOf: string | null; maintainers: number
      created: string; downloads: number | null; versions: number }
```

Types are shipped with the package: `ScanResult`, `ScanOptions`, `RiskEntry`, `PackageVerdict`, `VerdictStatus`, `PackageRiskResult`, `NpmCheckResult`, `Config`.

</details>

<details>
<summary>What gets scanned, and what raises a risk</summary>

**Detects:** `import`, `require()`, dynamic `import()`, `export … from`, scoped packages, subpath imports (`pkg/utils` → `pkg`), and `<script>` blocks in `.vue`, `.svelte` and `.astro` (markup is ignored, so a package name in template text is never flagged).

**Extensions:** `.js` `.jsx` `.ts` `.tsx` `.mjs` `.cjs` `.vue` `.svelte` `.astro`

**Ignores:** Node built-ins, relative imports, path aliases (`@/`, `~/`, `$lib/`, tsconfig `paths`), URL/protocol imports, virtual modules, workspace packages, and `node_modules/` `dist/` `build/` `.git/`.

**Risk signals:**

| Signal | Weight | Why |
|---|---|---|
| `postinstall` / `preinstall` / `install` script | critical | Runs arbitrary code on `npm install` |
| Name 1-2 chars from a popular package | critical | Classic typosquat |
| Created < 30 days ago | medium | No track record |
| < 50 weekly downloads | medium | Near-zero adoption |
| Single version published | medium | Abandoned or one-shot |
| Single maintainer | amplifier | Only counts alongside another signal |

`high` if any critical signal fires, or 2+ medium ones. Only `medium` and `high` are reported.

A name that doesn't exist on npm is *always* reported as squattable — that check costs no extra requests, so `--fast` doesn't disable it.

</details>

## Contributing

```bash
npm install
npm run dev      # run the CLI from source
npm test         # test suite (makes live registry calls)
npm run build    # type-check, emit .d.ts, bundle
```

| File | Purpose |
|---|---|
| `src/scan.ts` | Main `scan()` orchestrator |
| `src/verify.ts` | `verifyPackages()` — shared by the CLI, MCP server and hook |
| `src/npm.ts` | Registry checks, risk heuristics, typosquat detection |
| `src/imports.ts` · `src/sfc.ts` | Import extraction |
| `src/install.ts` | Parses install commands into package names |
| `src/mcp.ts` | MCP server (hand-rolled JSON-RPC — no SDK dependency) |
| `src/hook.ts` | Agent hook |
| `src/cli.ts` | CLI and subcommand dispatch |
| `src/files.ts` · `src/config.ts` · `src/cache.ts` | Walking, config, 24h registry cache |
| `docs/` | The landing page — one static `index.html`, no build step |

### The landing page

`docs/` is served at [fguerreir0.github.io/ghostimport](https://fguerreir0.github.io/ghostimport/)
via **Settings → Pages → main / docs**. Open `docs/index.html` in a browser to preview it —
there is nothing to install or compile.

It lives in this repo on purpose. **The page quotes real CLI output, the hook config, the MCP
command and the risk-signals table** — so a change to any of those is a change to the page.
Keeping both in one commit is the only thing that stops it going quietly stale.

Two conventions worth keeping:

- **Dashed border = a package name nobody owns. Solid border = a real published package.**
  The attack timeline turns on that switch at step 3; it is the page's whole explanation.
- **Every number on the page is verified against the live registry.** The `axois` figures
  (published 2019-08-29, one version, ~1,245 weekly installs) were checked with
  `checkPackageRisk`. Don't add a statistic you haven't run.

Design tokens — colours, type stack, page width — sit at the top of the `<style>` block.

## License

MIT
