#!/usr/bin/env node
/**
 * orrith bin entrypoint.
 * Spawns the TS server with Node 22+'s --experimental-strip-types flag.
 *
 * Why this indirection:
 *   shebang lines can't include node flags, so we spawn a child node process
 *   with the right flags from a plain JS launcher.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const serverPath = path.join(__dirname, '..', 'src', 'server.ts')

const args = [
  '--experimental-strip-types',
  '--env-file-if-exists=.env',
  serverPath,
]

const child = spawn(process.execPath, args, { stdio: 'inherit' })

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})

// forward common signals
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig))
}
