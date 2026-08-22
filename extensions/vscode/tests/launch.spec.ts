import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  backendSpawnOptions,
  buildBackendArgs,
  coerceArgList,
  DEFAULT_READY_TIMEOUT_MS,
  expandWorkspaceFolder,
  extractReadyUrl,
  mergeExtraEnv,
  MIN_READY_TIMEOUT_MS,
  resolveReadyTimeoutMs,
  resolveSpawnCommand,
  sanitizeSpawnEnv,
  waitForBackendReady,
} from '../src/launch.ts'

function fakeChild(): {
  child: EventEmitter & { stdout: PassThrough; stderr: PassThrough }
  stdout: PassThrough
  stderr: PassThrough
} {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child = Object.assign(new EventEmitter(), { stdout, stderr })
  return { child, stdout, stderr }
}

const failingFetch: typeof fetch = async () => {
  throw new Error('backend not listening')
}

describe('coerceArgList', () => {
  it('trims and drops empty array entries', () => {
    expect(coerceArgList(['', ' --import ', 'tsx/esm', 'web', ' '], ['web']))
      .toEqual(['--import', 'tsx/esm', 'web'])
  })

  it('splits a pasted command-line string instead of spreading characters', () => {
    expect(coerceArgList('--import tsx/esm apps/cli/src/bin.ts web', ['web']))
      .toEqual(['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web'])
  })

  it('uses the fallback for a missing or wrong JSON type', () => {
    expect(coerceArgList(undefined, ['web'])).toEqual(['web'])
    expect(coerceArgList({ web: true }, ['web'])).toEqual(['web'])
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

describe('buildBackendArgs', () => {
  it('appends --no-open, --port, and --host when the user argv omits them', () => {
    expect(buildBackendArgs(['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web'], 64195))
      .toEqual([
        '--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web',
        '--no-open', '--port', '64195', '--host', '127.0.0.1',
      ])
  })

  it('does not duplicate flags the user already supplied', () => {
    expect(buildBackendArgs(['web', '--no-open', '--port', '3080', '--host', '127.0.0.1'], 9))
      .toEqual(['web', '--no-open', '--port', '3080', '--host', '127.0.0.1'])
  })
})

describe('resolveReadyTimeoutMs', () => {
  it('keeps a finite timeout at or above the minimum', () => {
    expect(resolveReadyTimeoutMs(5_000)).toBe(5_000)
    expect(resolveReadyTimeoutMs(MIN_READY_TIMEOUT_MS)).toBe(MIN_READY_TIMEOUT_MS)
  })

  it('falls back when the setting is missing, non-finite, or too small', () => {
    expect(resolveReadyTimeoutMs(undefined)).toBe(DEFAULT_READY_TIMEOUT_MS)
    expect(resolveReadyTimeoutMs(Number.NaN)).toBe(DEFAULT_READY_TIMEOUT_MS)
    expect(resolveReadyTimeoutMs(500)).toBe(DEFAULT_READY_TIMEOUT_MS)
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

describe('backendSpawnOptions', () => {
  it('ignores stdin, pipes stdio, and hides the Windows console', () => {
    expect(backendSpawnOptions('/work', { PATH: '/bin' }, false)).toEqual({
      cwd: '/work',
      env: { PATH: '/bin' },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  })
})

describe('extractReadyUrl', () => {
  it('captures the loopback URL and stops before a LAN suffix', () => {
    expect(extractReadyUrl('dsh web: http://127.0.0.1:4567 (LAN: http://192.168.1.5:4567)'))
      .toBe('http://127.0.0.1:4567')
  })

  it('returns undefined when the ready line is absent', () => {
    expect(extractReadyUrl('dsh web: opening the default browser; pass --no-open to disable'))
      .toBeUndefined()
  })
})

describe('waitForBackendReady', () => {
  const servers: Array<ReturnType<typeof createServer>> = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
      server.close(error => error === undefined ? resolve() : reject(error))
    })))
  })

  it('resolves from a ready line split across stdout chunks', async () => {
    const { child, stdout } = fakeChild()
    const pending = waitForBackendReady({
      child,
      url: 'http://127.0.0.1:9',
      timeoutMs: 2_000,
      fetchImpl: failingFetch,
    })
    stdout.write('dsh web: ')
    stdout.write('http://127.0.0.1:64195\n')
    await expect(pending).resolves.toBe('http://127.0.0.1:64195')
  })

  it('resolves from loopback HTTP when stdout never prints the ready line', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200)
      response.end('ok')
    })
    servers.push(server)
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
        resolve(address.port)
      })
    })
    const { child } = fakeChild()
    await expect(waitForBackendReady({
      child,
      url: `http://127.0.0.1:${String(port)}`,
      timeoutMs: 3_000,
      pollIntervalMs: 50,
    })).resolves.toBe(`http://127.0.0.1:${String(port)}`)
  })

  it('rejects with a no-output timeout when neither stdout nor HTTP reports ready', async () => {
    const { child } = fakeChild()
    const error = await waitForBackendReady({
      child,
      url: 'http://127.0.0.1:1',
      timeoutMs: 200,
      pollIntervalMs: 40,
      fetchImpl: failingFetch,
    }).then(() => { throw new Error('unexpected resolve') }, (reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('no process output')
  })

  it('rejects when the process exits before readiness', async () => {
    const { child } = fakeChild()
    const pending = waitForBackendReady({
      child,
      url: 'http://127.0.0.1:1',
      timeoutMs: 2_000,
      fetchImpl: failingFetch,
    })
    child.emit('exit', 1, null)
    await expect(pending).rejects.toThrow('backend exited before reporting readiness (code 1 signal null)')
  })

  it('rejects as cancelled when the caller aborts', async () => {
    const { child } = fakeChild()
    const abort = new AbortController()
    const pending = waitForBackendReady({
      child,
      url: 'http://127.0.0.1:1',
      timeoutMs: 5_000,
      signal: abort.signal,
      fetchImpl: failingFetch,
    })
    abort.abort()
    await expect(pending).rejects.toThrow('backend start cancelled')
  })
})
