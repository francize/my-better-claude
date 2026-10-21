// The popup: a window of its own by the pointer, outside the terminal, showing one image at full
// quality. One is open at a time.
import type { EngineInterface } from 'claude-code'

import { LINUX_POPUP, MACOS_POPUP, WINDOWS_POPUP, powershellArgv } from './os-scripts'
import { convertImage, forHost, makeDir, sessionDirOf } from './host'
import type { Command, Platform } from './host'
import { imageFileOf } from './image-cache'

type Engine = EngineInterface

// The longest side of the picture, in points, and the most seconds the popup stays.
const POPUP_SIDE = 800
const POPUP_LIFE = 120

let current: { imageId: number; isOpen: boolean } | undefined

/** The program that shows image `id` in a popup on `platform`, and what it is told. */
async function popupCommand ($: Engine, platform: Platform, id: number): Promise<Command | undefined> {
  const file = await imageFileOf($, id)
  if (!file) return undefined
  const env = { IMAGE_PREVIEW_FILE: file, IMAGE_PREVIEW_SIZE: String(POPUP_SIDE), IMAGE_PREVIEW_LIFE: String(POPUP_LIFE) }
  if (platform === 'macos') return { argv: ['osascript', '-l', 'JavaScript', '-e', MACOS_POPUP], env }
  if (platform === 'windows') return forHost($, { argv: powershellArgv(WINDOWS_POPUP), env })
  // Tk reads a PNG: the picture shrunk to one, once.
  const cache = `${await sessionDirOf($)}/image-preview`
  const out = `${cache}/${id}.window.png`
  if (!(await $.fs.exists(out))) {
    await makeDir($, cache)
    if (!(await convertImage($, file, out, 'png', { side: POPUP_SIDE, onlyShrink: true }))) return undefined
  }
  return { argv: ['python3', '-c', LINUX_POPUP], env: { ...env, IMAGE_PREVIEW_FILE: out } }
}

/**
 * Shows image `id` in a popup till `closePopup`, resolving once it is gone. The program prints `.`
 * ten times a second, so the loop wakes to see it was closed, and leaving the loop ends the program.
 * Resolves `failed` when the program ended without showing a window: this system shows none.
 */
export async function showPopup ($: Engine, platform: Platform, id: number): Promise<'closed' | 'failed'> {
  if (current?.imageId === id && current.isOpen) return 'closed'
  closePopup()
  const opening = { imageId: id, isOpen: true }
  current = opening
  const command = await popupCommand($, platform, id)
  let isShown = false
  let output = ''
  if (command && opening.isOpen) {
    try {
      for await (const { text } of $.process.spawn(command)) {
        if (output.length < 2000) output += text
        if (/^shown$/m.test(text)) isShown = true
        if (!opening.isOpen) break
      }
    } catch (error) {
      output += error instanceof Error ? error.message : String(error)
    }
  }
  if (current === opening) current = undefined
  if (isShown || !opening.isOpen) return 'closed'
  $.ui.log(`image-preview: no window (${output.replace(/\.\n/g, '').trim().slice(0, 300) || 'the program could not start'}); the terminal draws the cards`, { to: 'debug' })
  return 'failed'
}

export function closePopup () {
  if (current) current.isOpen = false
  current = undefined
}
