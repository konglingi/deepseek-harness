import { describe, expect, it } from 'vitest'
import type { HarnessNotification } from '../src/jsonrpc.ts'
import {
  isInboxReceipt,
  isSessionIdle,
  parseArguments,
  referencedPaths,
  toolCallLabel,
  TurnRenderer,
  type ChatSink,
} from '../src/render.ts'

interface Recorded {
  sink: ChatSink
  markdown: string[]
  progress: string[]
  references: string[]
}

function recorder(): Recorded {
  const markdown: string[] = []
  const progress: string[] = []
  const references: string[] = []
  return {
    markdown,
    progress,
    references,
    sink: {
      markdown: value => { markdown.push(value) },
      progress: value => { progress.push(value) },
      reference: path => { references.push(path) },
    },
  }
}

function event(type: string, data: unknown, sessionId = 's1'): HarnessNotification {
  return { method: 'session.event', params: { sessionId, event: { type, data } } }
}

describe('TurnRenderer', () => {
  it('streams assistant text deltas and drops chunk kinds without a chat part', () => {
    const recorded = recorder()
    const renderer = new TurnRenderer(recorded.sink)
    renderer.handle(event('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'Hello' } }))
    renderer.handle(event('assistant/chunk', { chunk: { type: 'reasoning-delta', index: 0, text: 'hmm' } }))
    renderer.handle(event('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: ' world' } }))
    renderer.handle(event('step/start', { turn: 0, step: 0 }))
    expect(recorded.markdown).toEqual(['Hello', ' world'])
    expect(recorded.progress).toEqual([])
  })

  it('labels a tool call and attaches each distinct path once', () => {
    const recorded = recorder()
    const renderer = new TurnRenderer(recorded.sink)
    renderer.handle(event('tool/call', {
      callId: 'c1',
      name: 'read',
      arguments: JSON.stringify({ path: 'src/app.ts' }),
    }))
    renderer.handle(event('tool/call', {
      callId: 'c2',
      name: 'read',
      arguments: JSON.stringify({ path: 'src/app.ts' }),
    }))
    expect(recorded.progress).toEqual(['read: src/app.ts', 'read: src/app.ts'])
    expect(recorded.references).toEqual(['src/app.ts'])
  })

  it('names the failing tool from the call it answers', () => {
    const recorded = recorder()
    const renderer = new TurnRenderer(recorded.sink)
    renderer.handle(event('tool/call', { callId: 'c1', name: 'bash', arguments: '{"command":"exit 1"}' }))
    renderer.handle(event('tool/result', {
      message: { callId: 'c1' },
      error: { name: 'ShellError', code: 'EXIT_1' },
    }))
    expect(recorded.markdown.join('')).toContain('`bash` failed: EXIT_1')
  })

  it('renders a successful tool result as nothing', () => {
    const recorded = recorder()
    const renderer = new TurnRenderer(recorded.sink)
    renderer.handle(event('tool/result', { message: { callId: 'c1' } }))
    expect(recorded.markdown).toEqual([])
  })

  it('renders the todo list with the active item emphasized', () => {
    const recorded = recorder()
    const renderer = new TurnRenderer(recorded.sink)
    renderer.handle(event('todo/write', {
      todos: [
        { content: 'read the code', status: 'completed' },
        { content: 'write the fix', status: 'in_progress' },
        { content: 'run the tests', status: 'pending' },
      ],
    }))
    expect(recorded.markdown.join('')).toBe(
      '\n\n- [x] read the code\n- [ ] **write the fix**\n- [ ] run the tests\n\n',
    )
  })

  it('reports a cancelled, capped, or failed turn ending', () => {
    const cancelled = recorder()
    new TurnRenderer(cancelled.sink).handle(event('turn/end', { reason: { kind: 'aborted' } }))
    expect(cancelled.markdown.join('')).toContain('Canceled')

    const capped = recorder()
    new TurnRenderer(capped.sink).handle(event('turn/end', { reason: { kind: 'max-tokens' } }))
    expect(capped.markdown.join('')).toContain('output-token limit')

    const failed = recorder()
    new TurnRenderer(failed.sink).handle(event('turn/end', {
      reason: { kind: 'error', error: { message: 'upstream 503', code: 'PROVIDER' } },
    }))
    expect(failed.markdown.join('')).toContain('upstream 503')

    const completed = recorder()
    new TurnRenderer(completed.sink).handle(event('turn/end', { reason: { kind: 'completed' } }))
    expect(completed.markdown).toEqual([])
  })

  it('reports subagent delegation as progress', () => {
    const recorded = recorder()
    new TurnRenderer(recorded.sink).handle({
      method: 'subagent.started',
      params: { parentSessionId: 's1', childSessionId: 's1-child' },
    })
    expect(recorded.progress).toEqual(['Delegating to a subagent'])
  })
})

describe('toolCallLabel', () => {
  it('prefers a description, then a command, then a path argument', () => {
    expect(toolCallLabel('bash', { description: 'Run the tests', command: 'pnpm test' }))
      .toBe('bash: Run the tests')
    expect(toolCallLabel('bash', { command: 'pnpm test\n--watch' })).toBe('bash: pnpm test')
    expect(toolCallLabel('edit', { file_path: 'src/app.ts' })).toBe('edit: src/app.ts')
    expect(toolCallLabel('grep', { pattern: 'TODO' })).toBe('grep: TODO')
  })

  it('falls back to the bare tool name without usable arguments', () => {
    expect(toolCallLabel('todo_write', undefined)).toBe('todo_write')
    expect(toolCallLabel('todo_write', {})).toBe('todo_write')
  })

  it('truncates a long label', () => {
    const label = toolCallLabel('bash', { command: 'x'.repeat(400) })
    expect(label.length).toBeLessThan(140)
    expect(label.endsWith('…')).toBe(true)
  })
})

describe('referencedPaths', () => {
  it('collects distinct path arguments in argument order', () => {
    expect(referencedPaths({ path: 'a.ts', file_path: 'b.ts', paths: ['b.ts', 'c.ts', ''] }))
      .toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  it('returns nothing without arguments', () => {
    expect(referencedPaths(undefined)).toEqual([])
    expect(referencedPaths({ command: 'ls' })).toEqual([])
  })
})

describe('parseArguments', () => {
  it('parses a JSON object and rejects everything else', () => {
    expect(parseArguments('{"path":"a.ts"}')).toEqual({ path: 'a.ts' })
    expect(parseArguments('{"path":')).toBeUndefined()
    expect(parseArguments('[1,2]')).toBeUndefined()
    expect(parseArguments('   ')).toBeUndefined()
    expect(parseArguments(undefined)).toBeUndefined()
  })
})

describe('turn boundaries', () => {
  const receipt: HarnessNotification = {
    method: 'session.event',
    params: {
      sessionId: 's1',
      event: { type: 'agent/inbox/spliced', data: { inserted: [{ id: 'm1' }] } },
    },
  }

  it('recognizes the receipt for the submitted message only', () => {
    expect(isInboxReceipt(receipt, 's1', 'm1')).toBe(true)
    expect(isInboxReceipt(receipt, 's1', 'm2')).toBe(false)
    expect(isInboxReceipt(receipt, 'other', 'm1')).toBe(false)
    expect(isInboxReceipt(event('turn/start', { turn: 0 }), 's1', 'm1')).toBe(false)
  })

  it('recognizes only this session going idle', () => {
    expect(isSessionIdle({ method: 'session.status', params: { sessionId: 's1', status: 'idle' } }, 's1')).toBe(true)
    expect(isSessionIdle({ method: 'session.status', params: { sessionId: 's1', status: 'running' } }, 's1')).toBe(false)
    expect(isSessionIdle({ method: 'session.status', params: { sessionId: 's2', status: 'idle' } }, 's1')).toBe(false)
  })
})
