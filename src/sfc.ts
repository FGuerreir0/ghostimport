// Single-file components keep their imports inside <script> blocks (and, for
// Astro, the --- frontmatter fence). Only that code is scanned — markup is
// dropped so template text mentioning packages can't produce false positives.

export const SFC_EXTS = new Set(['.vue', '.svelte', '.astro'])

const SCRIPT_BLOCK = /<script\b[^>]*>([\s\S]*?)<\/script>/gi
const ASTRO_FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/

export function extractSfcScripts(code: string, ext: string): string {
  const parts: string[] = []

  if (ext === '.astro') {
    const frontmatter = code.match(ASTRO_FRONTMATTER)
    if (frontmatter) parts.push(frontmatter[1])
  }

  SCRIPT_BLOCK.lastIndex = 0
  let match
  while ((match = SCRIPT_BLOCK.exec(code)) !== null) {
    parts.push(match[1])
  }

  return parts.join('\n')
}
