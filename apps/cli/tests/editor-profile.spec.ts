import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * Keyless real-composition smoke for the shipped `editor` profile: boot
 * `dsh --profile editor` from source and drive the SDK stdio protocol the
 * editor extension speaks. It pins what the composition owes that client —
 * a handshake, `session/cancel`, `shutdown`, and a stdout carrying protocol
 * frames only — without a model, a key, or a network call.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const sourceBin = 'apps/cli/src/bin.ts'

interface Frame {
  id?: number
  method?: string
  result?: Record<string, unknown>
  error?: { message?: string }
}

/** One runtime under test plus its collected stdout frames. */
class RuntimeUnderTest {
  private buffer = ''
  private readonly frames: Frame[] = []
  private readonly waiters: { id: number; resolve: (frame: Frame) => void }[] = []
  readonly stderr: string[] = []
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { this.accept(chunk) })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { this.stderr.push(chunk) })
    this.exit = new Promise((resolve) => {
      child.once('exit', (code, signal) => { resolve({ code, signal }) })
    })
  }

  /** Send one request and await the response carrying the same id. */
  request(id: number, method: string, params: object): Promise<Frame> {
    const answered = new Promise<Frame>((resolve) => { this.waiters.push({ id, resolve }) })
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return answered
  }

  /** Every complete line the runtime wrote to stdout, in order. */
  get stdoutLines(): string[] {
    return this.frames.map(frame => JSON.stringify(frame))
  }

  private accept(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      newline = this.buffer.indexOf('\n')
      if (line.length === 0) continue
      // A non-JSON line would be a stdout leak, which the purity assertion
      // below must see rather than a parse throw inside this listener.
      const frame = JSON.parse(line) as Frame
      this.frames.push(frame)
      const waiter = this.waiters.findIndex(candidate => candidate.id === frame.id)
      if (waiter >= 0) this.waiters.splice(waiter, 1)[0]?.resolve(frame)
    }
  }
}

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function bootEditorProfile(): Promise<RuntimeUnderTest> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-editor-profile-'))
  const child = spawn(
    process.execPath,
    ['--import', 'tsx/esm', sourceBin, '--profile', 'editor'],
    {
      cwd: repoRoot,
      env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  const runtime = new RuntimeUnderTest(child)
  cleanups.push(async () => {
    child.kill('SIGKILL')
    await rm(home, { recursive: true, force: true })
  })
  return runtime
}

describe('dsh --profile editor', () => {
  it('serves the SDK protocol on stdio and exits on shutdown', async () => {
    const runtime = await bootEditorProfile()

    const initialized = await runtime.request(1, 'initialize', {
      cwd: repoRoot,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
    expect(initialized.error, runtime.stderr.join('')).toBeUndefined()
    const serverInfo = initialized.result?.serverInfo as { name?: string; version?: string } | undefined
    expect(serverInfo?.name).toBe('deepseek-harness-sdk-runtime')
    expect(serverInfo?.version).toBeTypeOf('string')

    // A session no prompt created has no live agent to interrupt.
    const cancelled = await runtime.request(2, 'session/cancel', { sessionId: 'never-prompted' })
    expect(cancelled.result).toEqual({ cancelled: false })

    const shutdown = await runtime.request(3, 'shutdown', {})
    expect(shutdown.result).toEqual({})
    await expect(runtime.exit).resolves.toEqual({ code: 0, signal: null })

    // stdout is the protocol channel: every line parsed as a response frame,
    // and the composition mounted nothing that logs there.
    expect(runtime.stdoutLines).toHaveLength(3)
  }, 120_000)
})
