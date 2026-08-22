import { describe, expect, it } from 'vitest'
import { defaultSessionId, SessionTracker } from '../src/sessions.ts'

describe('SessionTracker', () => {
  it('mints one session per chat and reuses it for later turns', () => {
    let serial = 0
    const tracker = new SessionTracker(() => `s${String(++serial)}`)
    expect(tracker.resolve(0)).toBe('s1')
    expect(tracker.resolve(1)).toBe('s1')
    expect(tracker.resolve(2)).toBe('s1')
    // A cleared chat has no history again, which is a new conversation.
    expect(tracker.resolve(0)).toBe('s2')
  })

  it('mints on the first request even when history is not empty', () => {
    const tracker = new SessionTracker(() => 'fresh')
    expect(tracker.currentId).toBeUndefined()
    expect(tracker.resolve(4)).toBe('fresh')
  })

  it('starts a new session after reset', () => {
    let serial = 0
    const tracker = new SessionTracker(() => `s${String(++serial)}`)
    tracker.resolve(0)
    tracker.reset()
    expect(tracker.currentId).toBeUndefined()
    expect(tracker.resolve(3)).toBe('s2')
  })
})

describe('defaultSessionId', () => {
  it('mints distinct prefixed ids', () => {
    const first = defaultSessionId()
    expect(first.startsWith('editor-')).toBe(true)
    expect(first).not.toBe(defaultSessionId())
  })
})
