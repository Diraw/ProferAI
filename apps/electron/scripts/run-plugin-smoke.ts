/** 在独立 Electron 进程验证插件桥接，不启动或重启用户的 Profer。 */
import { build } from 'esbuild'
import { resolve } from 'node:path'
const root = resolve(import.meta.dir, '..')
const output = resolve(root, 'dist/plugin-smoke')
await build({
  entryPoints: [resolve(root, 'scripts/plugin-smoke.ts')], outfile: resolve(output, 'main.cjs'), bundle: true,
  platform: 'node', format: 'cjs',
  external: ['electron', '@anthropic-ai/claude-agent-sdk', '@earendil-works/pi-coding-agent', '@earendil-works/pi-agent-core', '@earendil-works/pi-ai'],
  define: { __PROFER_BUILD_TARGET__: '"oss"' },
})
await build({ entryPoints: [resolve(root, 'src/plugin-preload/index.ts')], outfile: resolve(output, 'plugin-preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
const executable: unknown = require('electron')
if (typeof executable !== 'string') throw new Error('未找到 Electron 可执行文件')
const child = Bun.spawn([executable, resolve(output, 'main.cjs')], { cwd: root, stdout: 'inherit', stderr: 'inherit' })
const deadline = setTimeout(() => child.kill('SIGKILL'), 60_000)
try { process.exitCode = await child.exited } finally { clearTimeout(deadline) }
