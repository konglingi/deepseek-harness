/**
 * The bundle's substance is its patch file: the `dsh.bundle.patch` manifest
 * field must name a real, parseable patch list that serves the SDK protocol
 * without any row that writes to the stdout the protocol owns.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

const root = fileURLToPath(new URL('..', import.meta.url))

interface PatchRow {
  id?: string
  name?: string
  disabled?: unknown
  config?: Record<string, unknown>
  insert?: PatchRow[]
}

function patchRows(): PatchRow[] {
  const parsed = yaml.load(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new TypeError('editor patch must parse to a patch list')
  const patches = parsed as PatchRow[]
  return [...patches, ...patches.flatMap(patch => patch.insert ?? [])]
}

describe('dsh-editor-app bundle', () => {
  it('serves the SDK protocol from a patch declared through the dsh.bundle.patch manifest field', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-sdk-jsonrpc-server')

    const rows = patchRows()
    expect(rows.find(row => row.id === 'sdk-jsonrpc-server')?.name).toBe('@deepseek-ai/dsh-sdk-jsonrpc-server')
    expect(rows.find(row => row.id === 'system-prompt')?.config?.['persona']).toContain('editor')
    expect(rows.find(row => row.id === 'hmr')?.disabled).toBe(true)
  })

  it('mounts no browser, HTTP, or terminal row that would write to the protocol stdout', () => {
    const mounted = patchRows().filter(row => typeof row.name === 'string' && row.disabled !== true)
    expect(mounted.map(row => row.name)).toEqual(['@deepseek-ai/dsh-sdk-jsonrpc-server'])
  })

  it('keeps the base agent-plane rows the SDK server reads from the global layer', () => {
    // Unlike the Web layer, this bundle mounts no agent presets, so a row it
    // disabled here would leave SDK-created agents without that capability.
    const disabled = patchRows().filter(row => row.disabled === true).map(row => row.id)
    expect(disabled).toEqual(['hmr'])
  })
})
