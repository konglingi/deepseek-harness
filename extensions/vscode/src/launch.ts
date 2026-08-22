/**
 * VS Code-free helpers for launching the harness runtime from the editor
 * extension: argv construction, Electron/inspector env scrubbing, Windows
 * executable resolution, and process-tree termination.
 */

import { spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join } from 'node:path'

/** Default `dsh.runtime.handshakeTimeoutMs` when the setting is missing or invalid. */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 120_000

/** Minimum accepted `dsh.runtime.handshakeTimeoutMs`. */
export const MIN_HANDSHAKE_TIMEOUT_MS = 1_000

/** Environment keys that make a child Node wait on a debugger or the parent IPC channel. */
const DROP_ENV_KEYS = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ASAR',
  'VSCODE_INSPECTOR_OPTIONS',
  'NODE_CHANNEL_FD',
  'NODE_UNIQUE_ID',
] as const

/** Injectable filesystem/platform for {@link resolveSpawnCommand} tests. */
export interface CommandResolveInternals {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  exists: (path: string) => boolean
}

/** Result of resolving a user-configured executable for `spawn`. */
export interface ResolvedCommand {
  /** Path or PATH name to pass as `spawn`'s file argument. */
  file: string
  /** Whether `spawn` must use `shell: true` (Windows `.cmd` / `.bat` shims). */
  shell: boolean
}

/**
 * Coerce a VS Code setting that should be an argv array. A string is split
 * with quote-aware tokenization so a pasted command line does not become one
 * character per entry. An array slot that starts with `-` and contains
 * whitespace is treated the same way (`--import tsx/esm file.ts --profile
 * editor`); a path slot that contains spaces is left intact.
 *
 * @param value - raw `dsh.runtime.args` value.
 * @param fallback - used when `value` is missing or the wrong JSON type.
 * @returns trimmed non-empty argv tokens.
 */
export function coerceArgList(value: unknown, fallback: readonly string[]): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const text = String(item).trim()
      if (text.length === 0) return []
      if (text.startsWith('-') && /\s/u.test(text)) return tokenizeArgvFragment(text)
      return [stripWrappingQuotes(text)]
    })
  }
  if (typeof value === 'string') return tokenizeArgvFragment(value)
  return [...fallback]
}

/**
 * Format `file` plus argv for the OutputChannel. Tokens with whitespace or
 * quotes are double-quoted so a mashed setting is visible as one slot.
 *
 * @param file - resolved executable.
 * @param args - argv passed to `spawn`.
 * @returns a single log line.
 */
export function formatCommandLine(file: string, args: readonly string[]): string {
  return [file, ...args].map(quoteArgvToken).join(' ')
}

/**
 * Substitute `${workspaceFolder}` in a setting. VS Code does not expand that
 * token in `workspace.getConfiguration().get()` results.
 *
 * @param value - configured string, possibly containing the token.
 * @param workspaceFolder - first workspace folder fsPath, if any.
 * @returns `value` with every `${workspaceFolder}` replaced when a folder exists.
 */
export function expandWorkspaceFolder(value: string, workspaceFolder: string | undefined): string {
  if (workspaceFolder === undefined) return value
  return value.replaceAll('${workspaceFolder}', workspaceFolder)
}

/**
 * Accept a finite timeout of at least {@link MIN_HANDSHAKE_TIMEOUT_MS}.
 *
 * @param value - raw `dsh.runtime.handshakeTimeoutMs` setting.
 * @returns the setting, or {@link DEFAULT_HANDSHAKE_TIMEOUT_MS}.
 */
export function resolveHandshakeTimeoutMs(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_HANDSHAKE_TIMEOUT_MS
    ? value
    : DEFAULT_HANDSHAKE_TIMEOUT_MS
}

/**
 * Copy string-like keys out of a VS Code object setting.
 *
 * @param extra - raw `dsh.runtime.env` value.
 * @returns a flat string map safe to merge into `process.env`.
 */
export function mergeExtraEnv(extra: unknown): Record<string, string> {
  if (extra === null || extra === undefined || typeof extra !== 'object' || Array.isArray(extra)) {
    return {}
  }
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(extra as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      result[key] = String(value)
    }
  }
  return result
}

/**
 * Build a child environment that can actually run Node: drop Electron/VS Code
 * debugger and IPC inheritance, strip inspect flags from `NODE_OPTIONS`.
 *
 * @param base - typically the extension-host `process.env`.
 * @param extra - user `dsh.runtime.env` values, applied last.
 * @returns a new env object for `spawn`.
 */
export function sanitizeSpawnEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const key of DROP_ENV_KEYS) delete env[key]
  if (typeof env.NODE_OPTIONS === 'string') {
    const stripped = stripInspectorOptions(env.NODE_OPTIONS)
    if (stripped.length > 0) env.NODE_OPTIONS = stripped
    else delete env.NODE_OPTIONS
  }
  return { ...env, ...extra }
}

/**
 * Resolve a configured executable so Windows `node` / `dsh` shims spawn as
 * `node.exe` (no shell) or `.cmd` (shell required). POSIX leaves PATH lookup
 * to `spawn`.
 *
 * @param command - trimmed `dsh.runtime.command`.
 * @param internals - optional platform/PATH/`exists` overrides for tests.
 * @returns file path and whether `spawn` needs `shell: true`.
 */
export function resolveSpawnCommand(
  command: string,
  internals?: CommandResolveInternals,
): ResolvedCommand {
  const file = command.trim()
  const platform = internals?.platform ?? process.platform
  if (file.length === 0) return { file, shell: false }
  if (platform !== 'win32') return { file, shell: false }
  if (isAbsolute(file) || file.includes('/') || file.includes('\\')) {
    return { file, shell: isWindowsShim(file) }
  }
  const env = internals?.env ?? process.env
  const exists = internals?.exists ?? existsSync
  const resolved = resolveOnWindowsPath(file, env, exists)
  if (resolved === undefined) return { file, shell: false }
  return { file: resolved, shell: isWindowsShim(resolved) }
}

/**
 * `spawn` options for the managed runtime: piped stdio (stdin carries the
 * protocol), hidden Windows console, sanitized env.
 *
 * @param cwd - working directory, or `undefined` to inherit.
 * @param env - sanitized child environment.
 * @param shell - from {@link resolveSpawnCommand}.
 * @returns options to pass to `spawn`.
 */
export function runtimeSpawnOptions(
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
  shell: boolean,
): SpawnOptions {
  return {
    cwd,
    env,
    shell,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  }
}

/**
 * Terminate a runtime process tree. Windows uses `taskkill /T /F` so a
 * `cmd.exe` wrapper cannot leave `node` behind; POSIX sends SIGTERM then SIGKILL.
 *
 * @param child - the process `spawn` returned.
 * @param graceMs - POSIX SIGKILL delay while the process is still running.
 */
export function terminateChild(child: ChildProcess, graceMs: number): void {
  if (child.pid === undefined || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    return
  }
  child.kill('SIGTERM')
  const timer = setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGKILL')
  }, graceMs)
  timer.unref()
}

/**
 * Split a command-line fragment on whitespace, dropping wrapping quotes.
 *
 * @param value - one settings string or mashed array slot.
 * @returns argv tokens.
 */
function tokenizeArgvFragment(value: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  for (const ch of value) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/u.test(ch)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (current.length > 0) tokens.push(current)
  return tokens
}

function stripWrappingQuotes(text: string): string {
  if (text.length < 2) return text
  const start = text[0]
  const end = text[text.length - 1]
  if ((start === '"' && end === '"') || (start === "'" && end === "'")) {
    return text.slice(1, -1)
  }
  return text
}

function quoteArgvToken(token: string): string {
  if (token.length === 0) return '""'
  if (!/[\s"]/u.test(token)) return token
  return `"${token.replaceAll('"', '\\"')}"`
}

function stripInspectorOptions(value: string): string {
  return value
    .replace(/(?:^|\s)--inspect(?:-brk|-port)?(?:=\S*)?/g, '')
    .replace(/(?:^|\s)--debug(?:-brk|-port)?(?:=\S*)?/g, '')
    .replace(/(?:^|\s)--require\s+\S*vscode\S*/gi, '')
    .trim()
}

function isWindowsShim(file: string): boolean {
  const extension = extname(file).toLowerCase()
  return extension === '.cmd' || extension === '.bat'
}

function resolveOnWindowsPath(
  command: string,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
): string | undefined {
  const pathValue = environmentValue(env, 'PATH') ?? ''
  const pathext = environmentValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD'
  const extensions = extname(command) === ''
    ? preferExe(pathext.split(';').filter(item => item.length > 0))
    : ['']
  for (const directory of pathValue.split(delimiter)) {
    if (directory.length === 0) continue
    for (const extension of extensions) {
      const candidate = join(directory, command + extension)
      if (exists(candidate)) return candidate
    }
  }
  return undefined
}

function preferExe(extensions: string[]): string[] {
  const exe = extensions.filter(item => item.toLowerCase() === '.exe')
  const rest = extensions.filter(item => item.toLowerCase() !== '.exe')
  return [...exe, ...rest]
}

function environmentValue(env: NodeJS.ProcessEnv, name: 'PATH' | 'PATHEXT'): string | undefined {
  const exact = env[name]
  if (exact !== undefined) return exact
  const normalized = name.toUpperCase()
  return Object.entries(env).find(([key]) => key.toUpperCase() === normalized)?.[1]
}
