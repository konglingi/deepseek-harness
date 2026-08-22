import { describe, expect, it } from 'vitest'
import { buildPromptBlocks, buildPromptText, renderAttachment } from '../src/prompt.ts'

describe('buildPromptText', () => {
  it('sends the request unchanged when there is no editor context', () => {
    expect(buildPromptText({ text: '  explain this repo  ', attachments: [] }))
      .toBe('explain this repo')
  })

  it('names attachments and the active file as paths, never as inlined content', () => {
    const text = buildPromptText({
      text: 'fix the failing test',
      attachments: [
        { path: 'src/app.ts' },
        { path: 'tests/app.spec.ts', range: { start: 10, end: 24 } },
      ],
      activeFile: { path: 'src/other.ts', range: { start: 5, end: 5 } },
    })
    expect(text).toBe([
      'fix the failing test',
      '',
      'Editor context:',
      '- attached: src/app.ts',
      '- attached: tests/app.spec.ts:10-24',
      '- open in the editor: src/other.ts:5',
    ].join('\n'))
  })

  it('does not repeat the active file when it is already attached', () => {
    const text = buildPromptText({
      text: 'review',
      attachments: [{ path: 'src/app.ts' }],
      activeFile: { path: 'src/app.ts' },
    })
    expect(text).toBe('review\n\nEditor context:\n- attached: src/app.ts')
  })

  it('drops a duplicate attachment', () => {
    const text = buildPromptText({
      text: 'review',
      attachments: [{ path: 'src/app.ts' }, { path: 'src/app.ts' }],
    })
    expect(text).toBe('review\n\nEditor context:\n- attached: src/app.ts')
  })

  it('keeps the context list when the user typed nothing but attached a file', () => {
    expect(buildPromptText({ text: '', attachments: [{ path: 'src/app.ts' }] }))
      .toBe('Editor context:\n- attached: src/app.ts')
  })
})

describe('buildPromptBlocks', () => {
  it('wraps the prompt text in one text content block', () => {
    expect(buildPromptBlocks({ text: 'hi', attachments: [] }))
      .toEqual([{ type: 'text', text: 'hi' }])
  })
})

describe('renderAttachment', () => {
  it('renders a whole file, a single line, and a range', () => {
    expect(renderAttachment({ path: 'a.ts' })).toBe('a.ts')
    expect(renderAttachment({ path: 'a.ts', range: { start: 3, end: 3 } })).toBe('a.ts:3')
    expect(renderAttachment({ path: 'a.ts', range: { start: 3, end: 9 } })).toBe('a.ts:3-9')
  })
})
