// Copies the version in package.json into the manifests that must match it:
// the Claude Code plugin manifest and the MCP Registry's server.json.
//
// Runs as npm's `version` lifecycle script, so every `npm version` — including the
// patch bump in .githooks/pre-commit — keeps them in step. Run it by hand with
// `node scripts/sync-version.mjs`.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

function update(file, apply) {
  const full = path.join(root, file)
  const text = fs.readFileSync(full, 'utf8')
  const json = JSON.parse(text)
  apply(json)
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const out = JSON.stringify(json, null, 2).replace(/\n/g, eol) + eol
  if (out !== text) {
    fs.writeFileSync(full, out)
    console.log(`${file} → ${version}`)
  }
}

update('.claude-plugin/plugin.json', (j) => { j.version = version })
update('server.json', (j) => {
  j.version = version
  for (const p of j.packages ?? []) if (p.identifier === 'ghostimport') p.version = version
})
