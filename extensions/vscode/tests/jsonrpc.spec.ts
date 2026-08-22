import { describe, expect, it, vi } from 'vitest'
import {
  JsonRpcLinePeer,
  JsonRpcResponseError,
  RuntimeUnavailableError,
  type HarnessNotification,
} from '../src/jsonrpc.ts'

function peerWith(): {
  peer: JsonRpcLinePeer
  lines: string[]
  notifications: HarnessNotification[]
} {
  const lines: string[] = []
  const notifications: HarnessNotification[] = []
  const peer = new JsonRpcLinePeer({
    write: line => { lines.push(line) },
    onNotification: notification => { notifications.push(notification) },
  })
  return { peer, lines, notifications }
}

function frameOf(line: string): { id: number; method: string; params: unknown } {
  return JSON.parse(line) as { id: number; method: string; params: unknown }
}

describe('JsonRpcLinePeer', () => {
  it('writes one newline-terminated frame per request and resolves its response', async () => {
    const { peer, lines } = peerWith()
    const pending = peer.request('initialize', { cwd: '/work' })
    expect(lines).toHaveLength(1)
    expect(lines[0]?.endsWith('\n')).toBe(true)
    const frame = frameOf(lines[0] ?? '')
    expect(frame.method).toBe('initialize')
    expect(frame.params).toEqual({ cwd: '/work' })

    peer.receive(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { ok: true } })}\n`)
    await expect(pending).resolves.toEqual({ ok: true })
  })

  it('correlates concurrent requests by id regardless of answer order', async () => {
    const { peer, lines } = peerWith()
    const first = peer.request('session/prompt', { sessionId: 'a' })
    const second = peer.request('session/cancel', { sessionId: 'a' })
    const firstId = frameOf(lines[0] ?? '').id
    const secondId = frameOf(lines[1] ?? '').id

    peer.receive(`${JSON.stringify({ id: secondId, result: { cancelled: true } })}\n`)
    peer.receive(`${JSON.stringify({ id: firstId, result: { messageId: 'm1' } })}\n`)
    await expect(second).resolves.toEqual({ cancelled: true })
    await expect(first).resolves.toEqual({ messageId: 'm1' })
  })

  it('reassembles frames split across chunks and ignores non-frame stdout lines', () => {
    const { peer, notifications } = peerWith()
    peer.receive('not json at all\n')
    peer.receive('{"method":"session.status","params":{"sessionId":"a",')
    peer.receive('"status":"running"}}\n')
    expect(notifications).toEqual([
      { method: 'session.status', params: { sessionId: 'a', status: 'running' } },
    ])
  })

  it('delivers a notification without params as an empty params object', () => {
    const { peer, notifications } = peerWith()
    peer.receive('{"method":"session.status"}\n')
    expect(notifications).toEqual([{ method: 'session.status', params: {} }])
  })

  it('rejects with the wire code and message on an error response', async () => {
    const { peer, lines } = peerWith()
    const pending = peer.request('session/prompt', {})
    const id = frameOf(lines[0] ?? '').id
    peer.receive(`${JSON.stringify({ id, error: { code: 7, message: 'no adapter' } })}\n`)
    const error = await pending.then(() => { throw new Error('unexpected resolve') }, (reason: unknown) => reason)
    expect(error).toBeInstanceOf(JsonRpcResponseError)
    expect((error as JsonRpcResponseError).code).toBe(7)
    expect((error as Error).message).toBe('no adapter')
  })

  it('times out a request the runtime never answers', async () => {
    vi.useFakeTimers()
    try {
      const { peer } = peerWith()
      const pending = peer.request('initialize', {}, 50)
      const settled = pending.then(() => 'resolved', (error: unknown) => error)
      await vi.advanceTimersByTimeAsync(60)
      const error = await settled
      expect(error).toBeInstanceOf(RuntimeUnavailableError)
      expect((error as Error).message).toContain('initialize timed out after 50ms')
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails pending and later requests once the peer closes', async () => {
    const { peer } = peerWith()
    const pending = peer.request('session/prompt', {})
    peer.close(new RuntimeUnavailableError('runtime exited (code 9)'))
    await expect(pending).rejects.toThrow('runtime exited (code 9)')
    // The first failure wins, so a later close cannot mask the original cause.
    peer.close(new RuntimeUnavailableError('stopped'))
    await expect(peer.request('initialize', {})).rejects.toThrow('runtime exited (code 9)')
  })

  it('drops a response for an unknown id instead of throwing', () => {
    const { peer } = peerWith()
    expect(() => peer.receive('{"id":404,"result":{}}\n')).not.toThrow()
  })
})
