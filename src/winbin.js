// npm installs a command on Windows as a .cmd shim. Node refuses to run one without a shell (spawn EINVAL), and by name it
// only looks for an .exe (ENOENT). A shell would let cmd parse the arguments, so the shim's script is run with node itself.
import { existsSync, readFileSync } from 'node:fs'
import { win32 } from 'node:path'

/** An npm or pnpm .cmd shim's script (absolute path); null for any other file, or a script outside its node_modules. */
export function shimEntry(shim, text) {
  const hit = /"%(?:~dp0|dp0%)\\?([^"%\r\n]*node_modules\\[^"%\r\n]+\.(?:c|m)?js)"\s+%\*/i.exec(String(text))
  if (!hit) return null
  const dir = win32.dirname(shim)
  const entry = win32.resolve(dir, hit[1])
  const inside = (root) => entry.toLowerCase().startsWith(`${root.toLowerCase().replace(/\\$/, '')}\\`)
  // npm: node_modules beside the shim; pnpm: global\5\node_modules under its directory; a local install: ..\node_modules
  return (inside(dir) && /\\node_modules\\/i.test(entry.slice(dir.length))) || inside(win32.resolve(dir, '..', 'node_modules')) ? entry : null
}

/**
 * [file, args] to execute for a command name. Elsewhere than Windows: the name as is. On Windows: the first PATH directory
 * (absolute ones only) with <name>.exe, or with an npm shim whose script exists. None: the name, which fails with ENOENT.
 */
export function commandFor(name, args, { platform = process.platform, env = process.env, node = process.execPath, exists = existsSync, read = (p) => readFileSync(p, 'utf8') } = {}) {
  if (platform !== 'win32') return [name, [...args]]
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
  const dirs = String(env[key] ?? '').split(';').map((d) => d.trim().replace(/^"|"$/g, '')).filter((d) => win32.isAbsolute(d))
  for (const d of dirs) {
    const exe = win32.join(d, `${name}.exe`)
    if (exists(exe)) return [exe, [...args]]
    const shim = win32.join(d, `${name}.cmd`)
    if (!exists(shim)) continue
    let entry = null
    try { entry = shimEntry(shim, read(shim)) } catch { /* unreadable: keep looking */ }
    if (entry && exists(entry)) return [node, [entry, ...args]]
  }
  return [name, [...args]]
}
