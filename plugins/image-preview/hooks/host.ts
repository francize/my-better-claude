// The session's machine: its OS, where Claude Code stores pasted images, the image converter that
// works there, and its image viewer. Each fact is asked once and remembered.
import type { EngineInterface } from 'claude-code'

import { WINDOWS_CONVERT, powershellArgv } from './os-scripts'

type Engine = EngineInterface

export type Platform = 'macos' | 'linux' | 'windows' | 'other'
export type Command = { argv: string[]; env?: Record<string, string> }
type Converter = 'sips' | 'magick' | 'convert' | 'powershell'

/** How the terminal draws a picture itself: it reads the file, it is sent the bytes, or it cannot. */
export type TerminalImages = 'file' | 'bytes' | 'none'

/** A longest side in pixels; `onlyShrink` leaves a smaller picture as it is. */
export type Resize = { side: number; onlyShrink: boolean }

// The converters tried on each OS, in order. On Windows `convert` is the disk tool, never ImageMagick's.
const CONVERTERS: Record<Platform, Converter[]> = {
  macos: ['sips', 'magick', 'convert'],
  linux: ['magick', 'convert'],
  windows: ['magick', 'powershell'],
  other: ['magick', 'convert']
}
// Paths among the converter's variables, which WSL must translate for Windows.
const PATH_VARIABLES = /^IMAGE_PREVIEW_(FILE|OUT)$/

let platform: Promise<Platform> | undefined
let wsl: Promise<boolean> | undefined
let tempRoot: string | undefined
let sessionDir: string | undefined
let converter: Converter | undefined

export function platformOf ($: Engine) {
  platform ??= (async (): Promise<Platform> => {
    if ((await $.env.get('OS')) === 'Windows_NT') return 'windows'
    const name = (await $.process.run(['uname', '-s']).catch(() => undefined))?.stdout.trim()
    return name === 'Darwin' ? 'macos' : name === 'Linux' ? 'linux' : 'other'
  })()
  return platform
}

/** Under WSL the session is Linux, but the desktop, the pointer and the viewer are Windows'. */
export function isWsl ($: Engine) {
  wsl ??= (async () => (await platformOf($)) === 'linux' && (await $.env.get('WSL_DISTRO_NAME')) !== undefined)()
  return wsl
}

/**
 * A PowerShell command as this host runs it. Under WSL that is `powershell.exe`, with its variables
 * passed over through WSLENV and the paths among them (`/p`) turned into their Windows form.
 */
export async function forHost ($: Engine, command: Command): Promise<Command> {
  if (command.argv[0] !== 'powershell' || !(await isWsl($))) return command
  const names = Object.keys(command.env ?? {}).map(name => (PATH_VARIABLES.test(name) ? `${name}/p` : name))
  const inherited = await $.env.get('WSLENV')
  return { argv: ['powershell.exe', ...command.argv.slice(1)], env: { ...command.env, WSLENV: [inherited, ...names].filter(Boolean).join(':') } }
}

/** How the terminal draws pictures: Ghostty and kitty read files; CLAUDE_CODE_FORCE_TERMINAL_IMAGES takes bytes. */
export async function detectTerminalImages ($: Engine): Promise<TerminalImages> {
  const program = await $.env.get('TERM_PROGRAM')
  const term = await $.env.get('TERM')
  const readsFiles = program === 'ghostty' || term === 'xterm-ghostty' || term === 'xterm-kitty' || (await $.env.get('KITTY_WINDOW_ID')) !== undefined
  if (readsFiles) return 'file'
  return /^(1|true|yes|on)$/i.test((await $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES')) ?? '') ? 'bytes' : 'none'
}

/**
 * The OS whose popup program can show a picture by the pointer on this desktop, if any. Never over
 * SSH, where the desktop is another machine's. Under WSL the popup is Windows': WSLg cannot tell
 * where the pointer is.
 */
export async function detectPopupPlatform ($: Engine): Promise<Platform | undefined> {
  const isRemote = (await $.env.get('SSH_CONNECTION')) !== undefined || (await $.env.get('SSH_TTY')) !== undefined
  if (isRemote) return undefined
  const system = await platformOf($)
  if (system === 'macos' || system === 'windows') return system
  if (await isWsl($)) return 'windows'
  if (system !== 'linux' || !(await $.env.get('DISPLAY'))) return undefined
  const tk = await $.process.run(['python3', '-c', 'import tkinter']).catch(() => undefined)
  return tk?.exitCode === 0 ? 'linux' : undefined
}

/**
 * Claude Code's temp folder: `<CLAUDE_CODE_TMPDIR or /tmp>/claude-<uid>`. Windows has no uid: there
 * it is `<CLAUDE_CODE_TMPDIR or the system's temp folder>\claude`.
 */
async function claudeTempDir ($: Engine) {
  if ((await platformOf($)) !== 'windows') {
    const base = ((await $.env.get('CLAUDE_CODE_TMPDIR')) || '/tmp').replace(/\/+$/, '')
    return `${base}/claude-${(await $.process.run(['id', '-u'])).stdout.trim()}`
  }
  // The system's temp folder as Node finds it: %TEMP%, %TMP%, or the one in Windows' own folder.
  const system = (await $.env.get('TEMP')) || (await $.env.get('TMP')) || `${(await $.env.get('SystemRoot')) || 'C:\\Windows'}\\temp`
  const base = ((await $.env.get('CLAUDE_CODE_TMPDIR')) || system).replace(/[\\/]+$/, '')
  return `${base}/claude`
}

/**
 * This session's temp folder, where a pasted image is stored as `images/<N>.<ext>`:
 * `<temp folder>/<project path, dashed>/<session id>`. Undefined until the session stores an image.
 */
export async function sessionDirOf ($: Engine) {
  if (sessionDir) return sessionDir
  const id = await $.session.id()
  const root = (tempRoot ??= await claudeTempDir($))
  const names = new Set([await $.session.root(), await $.session.cwd()].map(path => path.replace(/[^a-zA-Z0-9]/g, '-')))
  for (const name of names) {
    if (await $.fs.exists(`${root}/${name}/${id}/images`)) return (sessionDir = `${root}/${name}/${id}`)
  }
  // A project path too long for a folder name gets a hash after it: look for the session instead.
  for (const entry of await $.fs.list(root).catch(() => [])) {
    if (entry.kind === 'dir' && (await $.fs.exists(`${root}/${entry.name}/${id}/images`))) {
      return (sessionDir = `${root}/${entry.name}/${id}`)
    }
  }
  return undefined
}

/** After /clear the session id, and so its folder, changes. */
export function forgetSessionDir () {
  sessionDir = undefined
}

/** The stored file of image `id`, if the session stored it. */
export async function findImageFile ($: Engine, id: number) {
  const dir = await sessionDirOf($)
  if (!dir) return undefined
  const name = (await $.fs.list(`${dir}/images`).catch(() => [])).find(entry => entry.name.startsWith(`${id}.`))?.name
  return name && /^\d+\.[a-z]+$/.test(name) ? `${dir}/images/${name}` : undefined
}

/** How `tool` writes `file` as `format` to `out`, resized as `resize` says or kept as it is. */
function convertCommand (tool: Converter, file: string, out: string, format: 'bmp' | 'png', resize?: Resize): Command {
  if (tool === 'sips') return { argv: ['sips', '-s', 'format', format, ...(resize ? ['-Z', String(resize.side)] : []), file, '--out', out] }
  if (tool === 'powershell') {
    const env = { IMAGE_PREVIEW_FILE: file, IMAGE_PREVIEW_OUT: out, IMAGE_PREVIEW_FORMAT: format, ...(resize && { IMAGE_PREVIEW_SIZE: String(resize.side) }) }
    return { argv: powershellArgv(WINDOWS_CONVERT), env }
  }
  const geometry = resize && `${resize.side}x${resize.side}${resize.onlyShrink ? '>' : ''}`
  return { argv: [tool, file, ...(geometry ? ['-resize', geometry] : []), `${format === 'bmp' ? 'BMP3' : 'PNG'}:${out}`] }
}

/** Converts `file` to `out` with the first converter that works here, remembered for next time. */
export async function convertImage ($: Engine, file: string, out: string, format: 'bmp' | 'png', resize?: Resize) {
  // Under WSL, Windows' PowerShell converts where ImageMagick is not installed.
  const tools = (await isWsl($)) ? [...CONVERTERS.linux, 'powershell' as const] : CONVERTERS[await platformOf($)]
  for (const tool of converter ? [converter] : tools) {
    const { argv, env } = await forHost($, convertCommand(tool, file, out, format, resize))
    const result = await $.process.run(argv, env && { env }).catch(() => undefined)
    if (result?.exitCode === 0) {
      converter = tool
      return true
    }
  }
  return false
}

export async function makeDir ($: Engine, path: string) {
  if ((await platformOf($)) !== 'windows') return void (await $.process.run(['mkdir', '-p', path]))
  await $.process.run(powershellArgv('New-Item -ItemType Directory -Force -Path $env:IMAGE_PREVIEW_OUT | Out-Null'), { env: { IMAGE_PREVIEW_OUT: path } })
}

/** Opens `file` in the system's viewer: Preview on macOS, the desktop's own elsewhere. */
export async function openInViewer ($: Engine, file: string) {
  if (await isWsl($)) {
    const path = (await $.process.run(['wslpath', '-w', file]).catch(() => undefined))?.stdout.trim()
    if (path) await $.process.run(['explorer.exe', path]).catch(() => undefined)
    return
  }
  const system = await platformOf($)
  const argv = system === 'macos' ? ['open', '-a', 'Preview', file] : system === 'windows' ? ['explorer', file.replaceAll('/', '\\')] : ['xdg-open', file]
  await $.process.run(argv).catch(() => undefined)
}
