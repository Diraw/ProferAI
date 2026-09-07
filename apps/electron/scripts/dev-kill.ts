/**
 * 跨平台清理残留的 electronmon / Electron 开发进程
 * 替代 pkill（Windows 不支持）。
 *
 * Windows 上 electronmon 实际由 node.exe 承载；稳定开发模式下 Electron 由 bunx 直接启动。
 * 清理时必须先结束当前仓库的 supervisor / Electron 进程树，且不能按所有 node.exe / Profer.exe 做宽泛匹配。
 *
 * 传入 --vite 时，额外清理占用 Vite 端口（5174）的残留进程。
 * 该清理仅应在 concurrently 拉起 dev:vite 之前跑一次（顶层 dev 脚本），
 * 不要在与 dev:vite 并发的 dev:electron 内部跑，否则会误杀本次刚启动的 vite。
 */
import { execFileSync, execSync } from 'child_process'
import { resolve } from 'path'

const isWin = process.platform === 'win32'
const killVite = process.argv.includes('--vite')
/** 与 vite.config.ts 的 server.port 保持一致 */
const VITE_PORT = 5174

function kill(pattern: string): void {
  try {
    if (isWin) {
      // Windows: taskkill 按进程名
      execSync(`taskkill /F /IM ${pattern} 2>nul`, { stdio: 'ignore' })
    } else {
      // Unix: pkill 按模式匹配
      execSync(`pkill -f '${pattern}' 2>/dev/null`, { stdio: 'ignore' })
    }
  } catch {
    // 没有匹配进程，忽略
  }
}

/**
 * electronmon 在 Windows 中是 node.exe，而不是 electronmon.exe。
 * 仅匹配当前 apps/electron 目录下的 electronmon CLI，再以 /T 终止其受监督子树。
 * 这避免旧 electronmon 在 electron.exe 被杀后立刻重启，从而持续占住 Remote 服务端口。
 */
function killStaleElectronmon(): void {
  if (!isWin) return

  try {
    const workspace = process.cwd().replace(/'/g, "''")
    const command = [
      `$workspace = '${workspace}'`,
      'Get-CimInstance Win32_Process |',
      "  Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.Contains($workspace) -and $_.CommandLine -match '[\\\\/]electronmon[\\\\/]bin[\\\\/]cli\\.js' } |",
      '  Select-Object -ExpandProperty ProcessId',
    ].join(' ')
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const pids = new Set(output.split(/\s+/).filter((value) => /^\d+$/.test(value)))
    for (const pid of pids) {
      try {
        execSync(`taskkill /F /T /PID ${pid} 2>nul`, { stdio: 'ignore' })
      } catch {
        // 已自行退出或权限不足，继续清理其他残留。
      }
    }
  } catch {
    // PowerShell/CIM 不可用时降级为原有 electron.exe 清理。
  }
}

/**
 * 清理占用 Vite 端口的残留进程。
 * vite.config.ts 设了 strictPort，端口被占就会直接报错退出，
 * 残留的孤儿 vite（如已注销 worktree 留下的）会反复阻塞 dev。
 * 仅当监听进程是 vite/node 时才杀，避免误伤占用同端口的其他服务。
 */
function killStaleVite(port: number): void {
  try {
    if (isWin) {
      const out = execSync(`netstat -ano -p tcp | findstr LISTENING | findstr :${port}`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const pids = new Set<string>()
      for (const line of out.split('\n')) {
        const m = line.trim().match(/(\d+)\s*$/)
        if (m) pids.add(m[1]!)
      }
      for (const pid of pids) {
        try { execSync(`taskkill /F /PID ${pid} 2>nul`, { stdio: 'ignore' }) } catch { /* 已退出 */ }
      }
    } else {
      const out = execSync(`lsof -ti:${port} 2>/dev/null`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      for (const pid of out.split('\n').map((s) => s.trim()).filter(Boolean)) {
        try {
          const cmd = execSync(`ps -p ${pid} -o command=`, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          })
          // 仅杀命令行包含 vite 的进程（dev server 由 node 运行 vite，命令行必含 vite 脚本路径），
          // 不匹配裸 node，避免误伤偶然占用该端口的其他 node 服务
          if (/vite/.test(cmd)) {
            execSync(`kill ${pid} 2>/dev/null`, { stdio: 'ignore' })
          }
        } catch {
          // 进程已退出或无权限，忽略
        }
      }
    }
  } catch {
    // 端口未被占用或命令不可用，忽略
  }
}

/**
 * 清理稳定开发模式直接启动的 Electron。
 * macOS/Linux 的 Electron 命令行包含仓库内的 Electron.app 路径；Windows 由 electron.exe 承载，
 * 但必须限定在当前仓库的命令行范围内，避免杀掉正式版 Profer。
 */
function killStaleElectron(): void {
  if (isWin) {
    try {
      const workspace = resolve(process.cwd(), '../..').replace(/'/g, "''")
      const command = [
        `$workspace = '${workspace}'`,
        'Get-CimInstance Win32_Process |',
        "  Where-Object { $_.Name -eq 'electron.exe' -and $_.CommandLine -and $_.CommandLine.Contains($workspace) } |",
        '  Select-Object -ExpandProperty ProcessId',
      ].join(' ')
      const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      for (const pid of new Set(output.split(/\s+/).filter((value) => /^\d+$/.test(value)))) {
        try { execSync(`taskkill /F /T /PID ${pid} 2>nul`, { stdio: 'ignore' }) } catch { /* 已退出 */ }
      }
    } catch {
      // PowerShell/CIM 不可用时由 supervisor 清理兜底。
    }
    return
  }

  try {
    const output = execSync('ps -axo pid=,command=', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const workspace = resolve(process.cwd(), '../..')
    for (const line of output.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/)
      if (!match) continue
      const [, pid, command] = match
      if (command.includes(workspace) && /\/Electron\.app\/Contents\/MacOS\/Electron(?:\s|$)/.test(command)) {
        try { execSync(`kill ${pid} 2>/dev/null`, { stdio: 'ignore' }) } catch { /* 已退出 */ }
      }
    }
  } catch {
    // ps/kill 不可用或没有残留进程，忽略。
  }
}

// 先杀 supervisor，再杀 Electron，避免旧 supervisor 重新拉起窗口。
killStaleElectronmon()
kill(isWin ? 'electronmon.exe' : 'electronmon \\.')
killStaleElectron()
if (killVite) killStaleVite(VITE_PORT)
