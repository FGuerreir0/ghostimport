// A small, quote-aware shell reader — enough to find the package-manager calls in a
// command an agent is about to run. It is not a shell: it never expands variables or
// globs, and anything it cannot follow it leaves alone (the caller then finds nothing,
// and the hook fails open).

const OPERATORS = ['&&', '||', ';', '|', '&', '\n']

/**
 * Split a command line into simple commands, each a list of tokens.
 *
 * Quotes keep their contents together (and operators inside them inert), so
 * `sh -c 'npm i a && npm i b'` is one command whose last token is the inner script.
 */
export function splitCommands(command: string): string[][] {
  const commands: string[][] = []
  let tokens: string[] = []
  let current = ''
  let inToken = false
  let i = 0

  const endToken = (): void => {
    if (inToken) tokens.push(current)
    current = ''
    inToken = false
  }
  const endCommand = (): void => {
    endToken()
    if (tokens.length > 0) commands.push(tokens)
    tokens = []
  }

  while (i < command.length) {
    const ch = command[i]

    if (ch === "'") {
      const close = command.indexOf("'", i + 1)
      const end = close === -1 ? command.length : close
      current += command.slice(i + 1, end)
      inToken = true
      i = end + 1
      continue
    }

    if (ch === '"') {
      i++
      while (i < command.length && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < command.length && '"\\$`'.includes(command[i + 1])) i++
        current += command[i]
        i++
      }
      inToken = true
      i++
      continue
    }

    if (ch === '\\' && i + 1 < command.length) {
      // A backslash-newline continues the line; any other escaped character is literal
      if (command[i + 1] !== '\n') current += command[i + 1]
      inToken = inToken || command[i + 1] !== '\n'
      i += 2
      continue
    }

    const op = OPERATORS.find(o => command.startsWith(o, i))
    if (op) {
      endCommand()
      i += op.length
      continue
    }

    if (ch === ' ' || ch === '\t' || ch === '\r') {
      endToken()
      i++
      continue
    }

    current += ch
    inToken = true
    i++
  }

  endCommand()
  return commands.map(dropRedirections).filter(c => c.length > 0)
}

const REDIRECT_ALONE = /^\d*(>>?|<)$/
const REDIRECT_ATTACHED = /^\d*(>>?|<)./

/** `npm i axios > log.txt 2>&1` → `npm i axios`. Otherwise `log.txt` reads as a package. */
function dropRedirections(tokens: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    if (REDIRECT_ALONE.test(tokens[i])) { i++; continue }
    if (REDIRECT_ATTACHED.test(tokens[i])) continue
    out.push(tokens[i])
  }
  return out
}

// Launchers that run the rest of the line as a command. Their own options are skipped.
const PREFIX_COMMANDS = new Set(['sudo', 'command', 'env', 'time', 'nohup', 'exec', 'doas', 'nice'])
// sudo/doas options that take a value
const PREFIX_VALUE_FLAGS = new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-T', '-U'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * Drop what runs *around* a command — `sudo -E`, `env FOO=1`, `VAR=x`, `time`,
 * PowerShell's `&` call operator — and return the command itself.
 */
export function stripPrefixes(tokens: string[]): string[] {
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]
    if (ASSIGNMENT.test(t) || t === '&') {
      i++
      continue
    }
    if (PREFIX_COMMANDS.has(t)) {
      i++
      while (i < tokens.length && tokens[i].startsWith('-')) {
        i += PREFIX_VALUE_FLAGS.has(tokens[i]) ? 2 : 1
      }
      continue
    }
    break
  }
  return tokens.slice(i)
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'cmd'])

/**
 * The script a shell is asked to run: `bash -c '…'`, `pwsh -Command '…'`, `cmd /c …`.
 * Returns null when the tokens are not a shell invocation with an inline script.
 */
export function inlineShellScript(tokens: string[]): string | null {
  const bin = binName(tokens[0] ?? '')
  if (!SHELLS.has(bin)) return null
  for (let i = 1; i < tokens.length; i++) {
    const flag = tokens[i].toLowerCase()
    if (flag === '-c' || flag === '-command' || flag === '/c' || flag === '/k' || flag === '-lc') {
      const rest = tokens.slice(i + 1)
      return rest.length > 0 ? rest.join(' ') : null
    }
  }
  return null
}

/** `C:\tools\npm.cmd` and `/usr/bin/npx` → `npm`, `npx`. */
export function binName(token: string): string {
  const base = token.split(/[\\/]/).pop() ?? token
  return base.replace(/\.(cmd|exe|ps1|bat)$/i, '').toLowerCase()
}
