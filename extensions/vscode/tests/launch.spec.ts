import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  coerceArgList,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  expandWorkspaceFolder,
  formatCommandLine,
  mergeExtraEnv,
  MIN_HANDSHAKE_TIMEOUT_MS,
  resolveHandshakeTimeoutMs,
  resolveSpawnCommand,
  runtimeSpawnOptions,
  sanitizeSpawnEnv,
} from '../src/launch.ts'

const DEFAULT_ARGS = ['--profile', 'editor']

describe('coerceArgList', () => {
  it('trims and drops empty array entries', () => {
    expect(coerceArgList(['', ' --import ', 'tsx/esm', '--profile', 'editor', ' '], DEFAULT_ARGS))
      .toEqual(['--import', 'tsx/esm', '--profile', 'editor'])
  })

  it('splits a pasted command-line string instead of spreading characters', () => {
    expect(coerceArgList('--import tsx/esm apps/cli/src/bin.ts --profile editor', DEFAULT_ARGS))
      .toEqual(['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'editor'])
  })

  it('splits a pasted flag fragment in one array slot, including a quoted value', () => {
    expect(coerceArgList(['--import tsx/esm apps/cli/src/bin.ts --profile "editor"'], DEFAULT_ARGS))
      .toEqual(['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'editor'])
  })

  it('splits --import from its specifier when they share one slot', () => {
    expect(coerceArgList(['--import tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'editor'], DEFAULT_ARGS))
      .toEqual(['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'editor'])
  })

  it('leaves a path that contains spaces as one token', () => {
    expect(coerceArgList(['C:\\Program Files\\app\\bin.js', '--profile', 'editor'], DEFAULT_ARGS))
      .toEqual(['C:\\Program Files\\app\\bin.js', '--profile', 'editor'])
  })

  it('uses the fallback for a missing or wrong JSON type', () => {
    expect(coerceArgList(undefined, DEFAULT_ARGS)).toEqual(DEFAULT_ARGS)
    expect(coerceArgList({ profile: 'editor' }, DEFAULT_ARGS)).toEqual(DEFAULT_ARGS)
  })
})

describe('formatCommandLine', () => {
  it('quotes the executable and any token that contains whitespace', () => {
    expect(formatCommandLine('C:\\Program Files\\nodejs\\node.EXE', [
      '--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'editor',
    ])).toBe('"C:\\Program Files\\nodejs\\node.EXE" --import tsx/esm apps/cli/src/bin.ts --profile editor')
  })

  it('quotes a mashed token so a bad setting is visible as one slot', () => {
    expect(formatCommandLine('node', ['--import tsx/esm apps/cli/src/bin.ts --profile editor']))
      .toBe('node "--import tsx/esm apps/cli/src/bin.ts --profile editor"')
  })
})

describe('expandWorkspaceFolder', () => {
  it('replaces the token when a workspace folder is known', () => {
    expect(expandWorkspaceFolder('${workspaceFolder}/apps/cli/src/bin.ts', 'C:\\repo'))
      .toBe('C:\\repo/apps/cli/src/bin.ts')
  })

  it('leaves the token when no workspace folder is open', () => {
    expect(expandWorkspaceFolder('${workspaceFolder}/apps/cli', undefined))
      .toBe('${workspaceFolder}/apps/cli')
  })
})

describe('resolveHandshakeTimeoutMs', () => {
  it('keeps a finite timeout at or above the minimum', () => {
    expect(resolveHandshakeTimeoutMs(5_000)).toBe(5_000)
    expect(resolveHandshakeTimeoutMs(MIN_HANDSHAKE_TIMEOUT_MS)).toBe(MIN_HANDSHAKE_TIMEOUT_MS)
  })

  it('falls back when the setting is missing, non-finite, or too small', () => {
    expect(resolveHandshakeTimeoutMs(undefined)).toBe(DEFAULT_HANDSHAKE_TIMEOUT_MS)
    expect(resolveHandshakeTimeoutMs(Number.NaN)).toBe(DEFAULT_HANDSHAKE_TIMEOUT_MS)
    expect(resolveHandshakeTimeoutMs(500)).toBe(DEFAULT_HANDSHAKE_TIMEOUT_MS)
  })
})

describe('mergeExtraEnv', () => {
  it('stringifies scalar values and ignores nested objects', () => {
    expect(mergeExtraEnv({ A: 'x', B: 1, C: true, D: { no: true }, E: null })).toEqual({
      A: 'x',
      B: '1',
      C: 'true',
    })
  })

  it('returns an empty map for a non-object setting', () => {
    expect(mergeExtraEnv(undefined)).toEqual({})
    expect(mergeExtraEnv(['x'])).toEqual({})
  })
})

describe('sanitizeSpawnEnv', () => {
  it('drops Electron/VS Code debugger and IPC inheritance', () => {
    const env = sanitizeSpawnEnv({
      PATH: '/bin',
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ASAR: '1',
      VSCODE_INSPECTOR_OPTIONS: 'inspect',
      NODE_CHANNEL_FD: '3',
      NODE_UNIQUE_ID: '9',
      KEEP: 'yes',
    })
    expect(env.PATH).toBe('/bin')
    expect(env.KEEP).toBe('yes')
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(env.NODE_CHANNEL_FD).toBeUndefined()
    expect(env.VSCODE_INSPECTOR_OPTIONS).toBeUndefined()
  })

  it('strips inspect flags from NODE_OPTIONS', () => {
    const env = sanitizeSpawnEnv({
      NODE_OPTIONS: '--enable-source-maps --inspect=9229 --require /tmp/vscode-loader.js',
    })
    expect(env.NODE_OPTIONS).toBe('--enable-source-maps')
  })

  it('applies extra env after sanitizing the base', () => {
    const env = sanitizeSpawnEnv(
      { KEEP: 'base', ELECTRON_RUN_AS_NODE: '1' },
      { KEEP: 'extra' },
    )
    expect(env.KEEP).toBe('extra')
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  it('deletes NODE_OPTIONS when only inspector flags remain', () => {
    const env = sanitizeSpawnEnv({ NODE_OPTIONS: '--inspect-brk=9229' })
    expect(env.NODE_OPTIONS).toBeUndefined()
  })
})

describe('resolveSpawnCommand', () => {
  it('leaves a POSIX PATH name to spawn', () => {
    expect(resolveSpawnCommand('node', { platform: 'linux', env: {}, exists: () => false }))
      .toEqual({ file: 'node', shell: false })
  })

  it('prefers node.exe over node.cmd in the same Windows directory', () => {
    expect(resolveSpawnCommand('node', {
      platform: 'win32',
      env: { PATH: '/nvm', PATHEXT: '.EXE;.CMD' },
      exists: path => path === join('/nvm', 'node.EXE') || path === join('/nvm', 'node.CMD'),
    })).toEqual({ file: join('/nvm', 'node.EXE'), shell: false })
  })

  it('uses shell for a Windows .cmd shim when no .exe is in that directory', () => {
    expect(resolveSpawnCommand('dsh', {
      platform: 'win32',
      env: { PATH: '/npm', PATHEXT: '.EXE;.CMD' },
      exists: path => path === join('/npm', 'dsh.CMD'),
    })).toEqual({ file: join('/npm', 'dsh.CMD'), shell: true })
  })

  it('keeps an absolute Windows path and flags .cmd as a shim', () => {
    expect(resolveSpawnCommand('C:\\tools\\dsh.cmd', {
      platform: 'win32',
      env: {},
      exists: () => false,
    })).toEqual({ file: 'C:\\tools\\dsh.cmd', shell: true })
  })
})

describe('runtimeSpawnOptions', () => {
  it('pipes every stream, because stdin carries the protocol', () => {
    expect(runtimeSpawnOptions('/work', { PATH: '/bin' }, false)).toEqual({
      cwd: '/work',
      env: { PATH: '/bin' },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  })
})
