# Contributing

Thanks for looking. `ghostimport` has **no runtime dependencies** and that is a deliberate constraint — it is the tool's own credibility argument. Keep new dependencies in `devDependencies`.

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

## The website

`docs/` is served at [fguerreir0.github.io/ghostimport](https://fguerreir0.github.io/ghostimport/)
via **Settings → Pages → main / docs**. Static files, no build step — open `docs/index.html`
in a browser to preview.

```
docs/index.html        landing page          /ghostimport/
docs/docs/index.html   documentation         /ghostimport/docs/
docs/assets/site.css   shared design system  (tokens, type, buttons, terminal, tables)
docs/assets/logo.*     favicon and og:image
docs/.nojekyll         stop Pages running Jekyll over it
```

The nesting looks odd but the URLs are right: Pages treats `docs/` as the site root, so
`docs/docs/` lands at `/ghostimport/docs/`.

The site lives in this repo on purpose. **Both pages quote real CLI output, flags, the hook
config, the MCP command, the config file, the API surface and the risk-signals table** — so a
change to any of those is a change to the site. Keeping them in one commit is the only thing
that stops the docs going quietly stale.

Three conventions worth keeping:

- **Shared styles go in `assets/site.css`; page-specific layout stays inline.** Anything that
  defines the identity belongs in the shared sheet, or the two pages drift apart.
- **Dashed border = a package name nobody owns. Solid border = a real published package.**
  The attack timeline turns on that switch at step 3; it is the page's whole explanation.
- **Every number on the site is verified against the live registry.** The `axois` figures
  (published 2019-08-29, one version, ~1,245 weekly installs) were checked with
  `checkPackageRisk`. Don't add a statistic you haven't run.
