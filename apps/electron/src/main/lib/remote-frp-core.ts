import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { stringify } from 'smol-toml'
import { validateEndpoint } from '@profer/shared'
export interface FrpConfig {
  serverAddr: string; serverPort: number; remotePort: number; authToken: string
  publicUrl: string; startOnLaunch: boolean; serverVersion: string; trustedCaFile: string
  publicMode?: 'pinned' | 'system'
}
export interface FrpRelease { tag_name: string; draft: boolean; prerelease: boolean; assets: Array<{ name: string; browser_download_url: string; digest?: string; size: number }> }
/** 官方 Release 中可校验的 linux frps 归档；服务端一条命令自举所需的最小信息。 */
export interface FrpServerAsset { arch: 'amd64' | 'arm64' | 'arm'; name: string; url: string; sha256: string }
/** Profer 本地生成并托管的 FRP 控制链路材料（CA + frps server 证书）。 */
export interface FrpDeploymentMaterial { caCert: string; caKey: string; serverCert: string; serverKey: string }
export function port(value: number): number {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error('端口必须为 1024-65535 的整数')
  return value
}
export function publicMode(c: FrpConfig): 'pinned' | 'system' { return c.publicMode ?? (c.publicUrl ? 'system' : 'pinned') }
export function validateFrpDraft(c: FrpConfig): FrpConfig {
  const serverAddr = c.serverAddr.trim()
  if (serverAddr && (serverAddr.length > 253 || (!isIP(serverAddr) && !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(serverAddr)))) throw new Error('FRP 服务器地址格式无效')
  try { port(c.serverPort) } catch { throw new Error('FRP 控制端口必须为 1024-65535 的整数') }
  try { port(c.remotePort) } catch { throw new Error('TCP 映射端口必须为 1024-65535 的整数') }
  if (c.serverPort === c.remotePort) throw new Error('控制端口和映射端口不能相同')
  if (typeof c.authToken !== 'string' || c.authToken.length > 1024 || /[\0\r\n]/.test(c.authToken)) throw new Error('FRP Token 格式无效')
  if (!/^0\.\d+\.\d+$/.test(c.serverVersion)) throw new Error('frps 固定版本格式无效，例如 0.71.0')
  if (typeof c.startOnLaunch !== 'boolean' || typeof c.trustedCaFile !== 'string' || /[\0\r\n]/.test(c.trustedCaFile)) throw new Error('控制链路 CA 文件路径无效')
  if (c.publicMode !== undefined && c.publicMode !== 'pinned' && c.publicMode !== 'system') throw new Error('公网模式无效')
  const mode = publicMode(c)
  if (mode === 'pinned' && serverAddr && !isIP(serverAddr)) throw new Error('无域名模式的服务器地址必须是 IPv4 或 IPv6')
  const publicUrl = c.publicUrl.trim() ? validateEndpoint({ url: c.publicUrl.trim(), scope: 'public' }).url : ''
  return { ...c, serverAddr, publicUrl, publicMode: mode }
}
/**
 * 用户仍需亲自填写的输入。FRP Token、控制 CA 与 server 证书由 Profer 本地生成托管，
 * 不再作为“用户未填写”的缺项；它们的存在性由 `frpRuntimeMissing` 在启动/导出前检查。
 */
export function frpMissing(c: FrpConfig): string[] {
  return [...(!c.serverAddr ? ['服务器公网 IP/地址'] : []), ...(publicMode(c) === 'system' && !c.publicUrl ? ['系统可信 WSS 地址'] : [])]
}
/** Profer 应已生成托管的材料缺项。 */
export function frpMaterialMissing(c: FrpConfig): string[] {
  return [...(!c.authToken ? ['独立 FRP Token（由 Profer 生成）'] : []), ...(!c.trustedCaFile.trim() ? ['FRP 控制链路 CA（由 Profer 生成）'] : [])]
}
/** 启动 / 应用协议测试 / 导出前的完整就绪门禁。 */
export function validateFrpConfig(c: FrpConfig): FrpConfig {
  const value = validateFrpDraft(c); const missing = [...frpMissing(value), ...frpMaterialMissing(value)]
  if (missing.length) throw new Error(`配置尚未就绪，缺少：${missing.join('、')}`)
  return value
}
export function pinnedPublicUrl(c: FrpConfig): string {
  if (!isIP(c.serverAddr)) throw new Error('公网 IP 无效')
  return `wss://${isIP(c.serverAddr) === 6 ? `[${c.serverAddr}]` : c.serverAddr}:${port(c.remotePort)}/ws`
}
export function renderFrpcToml(input: FrpConfig, localPort: number): string {
  const c = validateFrpConfig(input); port(localPort)
  return stringify({
    serverAddr: c.serverAddr, serverPort: c.serverPort, auth: { method: 'token', token: c.authToken },
    transport: { tls: { enable: true, ...(c.trustedCaFile ? { trustedCaFile: c.trustedCaFile, serverName: c.serverAddr } : {}) } },
    log: { to: 'console', level: 'warn', disablePrintColor: true }, loginFailExit: true,
    proxies: [{ name: 'profer-remote', type: 'tcp', localIP: '127.0.0.1', localPort, remotePort: c.remotePort }],
  })
}
export function selectFrpAsset(release: FrpRelease, platform = process.platform, arch = process.arch) {
  if (release.draft || release.prerelease || !/^v0\.\d+\.\d+$/.test(release.tag_name)) throw new Error('只允许官方稳定版本')
  const os = ({ win32: 'windows', darwin: 'darwin', linux: 'linux' } as Record<string, string>)[platform]
  const cpu = ({ x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm' } as Record<string, string>)[arch]
  if (!os || !cpu) throw new Error('当前平台/CPU 没有受支持的官方资产')
  const version = release.tag_name.slice(1)
  const root = `frp_${version}_${os}_${cpu}`
  const name = `${root}.${os === 'windows' ? 'zip' : 'tar.gz'}`
  const asset = release.assets.find((a) => a.name === name)
  if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '') || asset.size > 64 * 1024 * 1024 || asset.browser_download_url !== `https://github.com/fatedier/frp/releases/download/v${version}/${name}`) throw new Error('官方资产缺少可信 SHA256 或与平台不匹配')
  return { version, root, name, url: asset.browser_download_url, sha256: asset.digest!.slice(7), size: asset.size, binary: os === 'windows' ? 'frpc.exe' : 'frpc' }
}
export function verifySha256(data: Uint8Array, expected: string): void {
  if (!/^[a-f0-9]{64}$/i.test(expected) || createHash('sha256').update(data).digest('hex') !== expected.toLowerCase()) throw new Error('下载 SHA256 不匹配')
}
export function validateArchiveEntry(name: string, type: string, size: number): void {
  if (name.startsWith('/') || name.includes('\\') || /^[a-z]:/i.test(name) || name.split('/').some((p) => p === '..' || p === '.') || !['File', 'Directory', '0', '5'].includes(type) || !Number.isSafeInteger(size) || size < 0 || size > 64 * 1024 * 1024) throw new Error('归档包含不安全路径、链接或超大文件')
}
const FRP_RELEASE_DOWNLOAD = 'https://github.com/fatedier/frp/releases/download/'
const FRP_SERVER_ARCHES = ['amd64', 'arm64', 'arm'] as const
/**
 * 从官方 Release 元数据挑出 linux 服务端归档（frps）。
 * 只接受 digest 为 sha256 且下载地址严格等于官方发布的资产；某个架构缺失或格式不符就不返回该架构，
 * 由部署脚本在目标机上按实测架构 fail closed —— 绝不放行“无摘要安装”，也不伪造签名校验。
 */
export function selectFrpServerAssets(release: FrpRelease): FrpServerAsset[] {
  if (release.draft || release.prerelease || !/^v0\.\d+\.\d+$/.test(release.tag_name)) throw new Error('只允许官方稳定版本')
  const version = release.tag_name.slice(1)
  const assets: FrpServerAsset[] = []
  for (const arch of FRP_SERVER_ARCHES) {
    const name = `frp_${version}_linux_${arch}.tar.gz`
    const asset = release.assets.find((a) => a.name === name)
    if (!asset) continue
    if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '')) continue
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 64 * 1024 * 1024) continue
    if (asset.browser_download_url !== `${FRP_RELEASE_DOWNLOAD}v${version}/${name}`) continue
    assets.push({ arch, name, url: asset.browser_download_url, sha256: asset.digest!.slice(7) })
  }
  if (!assets.length) throw new Error('官方 Release 未提供可校验的 linux frps 归档摘要，已拒绝生成部署指令')
  return assets
}
export const FRPS_SERVICE = '[Unit]\nDescription=Profer self-hosted FRP\nAfter=network-online.target\nWants=network-online.target\n[Service]\nUser=frp\nGroup=frp\nExecStart=/opt/frp/frps -c /etc/frp/frps.toml\nRestart=on-failure\nRestartSec=5\nNoNewPrivileges=true\nProtectSystem=strict\nProtectHome=true\nPrivateTmp=true\n[Install]\nWantedBy=multi-user.target\n'
export function renderFrpsToml(input: FrpConfig): string {
  const c = validateFrpConfig(input)
  return stringify({ bindPort: c.serverPort, proxyBindAddr: publicMode(c) === 'pinned' ? '0.0.0.0' : '127.0.0.1', auth: { method: 'token', token: c.authToken }, transport: { tls: { force: true, certFile: '/etc/frp/server.crt', keyFile: '/etc/frp/server.key' } }, allowPorts: [{ start: c.remotePort, end: c.remotePort }] })
}
function firewallHint(c: FrpConfig): string {
  return publicMode(c) === 'pinned'
    ? `仅需开放控制端口 ${c.serverPort}/TCP（限桌面可信来源）与 TCP 映射端口 ${c.remotePort}/TCP；不要在服务器终止 WSS，frps 只做透明 TCP 转发。`
    : `控制端口 ${c.serverPort}/TCP 只向可信桌面来源开放；映射端口 ${c.remotePort} 仅回环绑定，不对公网开放；对外只需 443/TCP（Caddy 终止 TLS）。`
}
/** frps 归档摘要表：每个可用架构一行 case 分支，目标机按实测架构取用，取不到就 fail closed。 */
function serverDigestCases(assets: FrpServerAsset[]): string {
  return assets.map((a) => `    ${a.arch}) archive_name='${a.name}'; archive_url='${a.url}'; expected='${a.sha256}' ;;`).join('\n')
}
/**
 * 唯一的部署指令渲染入口。zip 内 deploy.sh 与“复制部署指令”输出字节一致。
 * 内容含 Profer 生成的真实 FRP Token、CA 私钥与 server 私钥，由用户在自己服务器执行。
 * 脚本自带 CPU 架构判定与官方 SHA256 摘要校验（fail closed），不再要求用户预先准备 frps 二进制；
 * 整体包在一个子 shell 里，任何失败只结束脚本自身，不会关掉用户的登录会话。
 */
export function renderDeploymentScript(input: FrpConfig, material: FrpDeploymentMaterial, assets: FrpServerAsset[]): string {
  const c = validateFrpConfig(input)
  if (!assets.length) throw new Error('缺少官方 frps 归档摘要，已拒绝生成部署指令')
  for (const asset of assets) {
    if (!/^(amd64|arm64|arm)$/.test(asset.arch) || !/^[a-f0-9]{64}$/.test(asset.sha256) || asset.url !== `${FRP_RELEASE_DOWNLOAD}v${c.serverVersion}/${asset.name}` || !/^frp_0\.\d+\.\d+_linux_(amd64|arm64|arm)\.tar\.gz$/.test(asset.name)) throw new Error('官方 frps 归档摘要信息无效')
  }
  const firewall = firewallHint(c)
  // 只放行确实需要对外暴露的端口：system 模式下映射端口只回环绑定，不对公网开放。
  const pinned = publicMode(c) === 'pinned'
  const firewallPorts = pinned ? `${c.serverPort} ${c.remotePort}` : `${c.serverPort} 443`
  const firewallPortsText = pinned ? `控制端口 ${c.serverPort}/TCP 与映射端口 ${c.remotePort}/TCP` : `控制端口 ${c.serverPort}/TCP 与 443/TCP（Caddy 终止 TLS）`
  const cloudNote = pinned ? '云厂商安全组不会自动放行：请在云控制台的安全组里放行上述端口（尤其是映射端口）。' : '云厂商安全组不会自动放行：请在云控制台的安全组里放行上述端口（控制端口与 443/TCP）。'
  return `#!/bin/sh
# Profer 生成的 frps 部署指令（含真实 FRP Token 与控制链路证书私钥）。
# 只在你自己的 frps 服务器上以 root 执行；经可信渠道传输，不要贴进对话、工单或公开渠道。
# 推荐用法：保存为 deploy.sh 后执行 bash deploy.sh；也可以整段复制粘贴到服务器执行。
# 即使中途失败也只结束脚本自身，不会关闭你的登录会话。
# 目标服务器地址：${c.serverAddr}；控制端口 ${c.serverPort}/TCP；映射端口 ${c.remotePort}/TCP；frps 版本 ${c.serverVersion}。
# 本指令自动判定 CPU 架构，从官方 GitHub Release 下载 frps，用官方 SHA256 摘要校验后安装到 /opt/frp/frps，
# 写入 /etc/frp 配置与证书、安装 systemd 服务并尝试放行防火墙；不需要你预先准备 frps 二进制。
(
profer_deploy_frps() (
  set -eu
  umask 077
  version='${c.serverVersion}'
  server_port='${c.serverPort}'
  remote_port='${c.remotePort}'
  install_dir='/opt/frp'
  cert_dir='/root/profer-frp'
  work_dir=''
  profer_cleanup() {
    if [ -n "$work_dir" ] && [ -d "$work_dir" ]; then rm -rf "$work_dir" 2>/dev/null || true; fi
  }
  trap profer_cleanup 0
  trap 'exit 130' INT
  trap 'exit 143' TERM
  fail() {
    profer_cleanup
    echo "部署失败：$1" >&2
    shift || true
    for hint in "$@"; do echo "  - $hint" >&2; done
    exit 1
  }
  sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then set -- $(sha256sum "$1")
    else set -- $(shasum -a 256 "$1")
    fi
    printf '%s' "$1"
  }
  [ "$(id -u 2>/dev/null)" = '0' ] || fail '需要 root 权限' '请以 root 登录后执行，或使用：sudo bash deploy.sh'
  command -v systemctl >/dev/null 2>&1 || fail '未检测到 systemd' '本指令用 systemd 托管 frps；其它 init 系统请按 frps.toml 手动托管'
  if command -v curl >/dev/null 2>&1; then downloader='curl'
  elif command -v wget >/dev/null 2>&1; then downloader='wget'
  else fail '缺少下载工具 curl 或 wget' 'Debian/Ubuntu：apt-get update && apt-get install -y curl' 'RHEL 系：dnf install -y curl' 'Alpine：apk add curl'
  fi
  command -v tar >/dev/null 2>&1 || fail '缺少 tar 解压工具' 'Debian/Ubuntu：apt-get install -y tar' 'Alpine：apk add tar'
  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    fail '缺少 SHA256 校验工具（sha256sum 或 shasum）' 'Debian/Ubuntu：apt-get install -y coreutils'
  fi
  machine=$(uname -m)
  case "$machine" in
    x86_64|amd64) arch='amd64' ;;
    aarch64|arm64) arch='arm64' ;;
    armv7l|armv7|armhf) arch='arm' ;;
    *) fail "不支持的 CPU 架构：$machine" '本指令只提供官方 linux amd64/arm64/arm 归档，其它架构请自行部署 frps' ;;
  esac
  archive_name=''
  archive_url=''
  expected=''
  case "$arch" in
${serverDigestCases(assets)}
  esac
  if [ -z "$expected" ]; then
    fail "官方 Release 未提供 linux/$arch 的 SHA256 摘要，已拒绝安装（不做无校验安装）" '请在桌面 Profer → 设置 → 连接 → 远程连接 → 自建 FRP 重新导出部署指令'
  fi
  echo "检测到 linux/$arch（$machine），目标 frps 版本 $version。"
  if [ -e "$install_dir" ] && [ ! -d "$install_dir" ]; then fail "$install_dir 已存在且不是目录" '请先移走该文件后重新执行本指令'; fi
  mkdir -p "$install_dir" || fail "无法创建 $install_dir" '请检查磁盘空间与权限'
  nologin='/bin/false'
  if [ -x /usr/sbin/nologin ]; then nologin='/usr/sbin/nologin'
  elif [ -x /sbin/nologin ]; then nologin='/sbin/nologin'
  fi
  if ! id frp >/dev/null 2>&1; then
    if command -v useradd >/dev/null 2>&1; then
      useradd --system --user-group --no-create-home --shell "$nologin" frp >/dev/null 2>&1 || fail '创建 frp 系统用户失败' '请手动执行：useradd --system --user-group --no-create-home frp'
    elif command -v adduser >/dev/null 2>&1; then
      adduser -S -D -H -s "$nologin" frp >/dev/null 2>&1 || fail '创建 frp 系统用户失败' '请手动创建无登录 frp 用户后重试'
    else
      fail '系统没有 useradd/adduser，无法创建 frp 用户' '请手动创建 frp 用户后重新执行本指令'
    fi
  fi
  chown root:frp "$install_dir" 2>/dev/null || true
  chmod 755 "$install_dir"
  installed_version=''
  if [ -x "$install_dir/frps" ]; then installed_version=$("$install_dir/frps" --version 2>/dev/null || true); fi
  if [ "$installed_version" = "$version" ]; then
    echo "已安装 frps $version，跳过下载与校验（重复执行结果一致）。"
  else
    work_dir="$install_dir/.download-$$"
    rm -rf "$work_dir"
    mkdir -p "$work_dir" || fail "无法创建临时目录 $work_dir" '请检查磁盘空间与权限'
    archive="$work_dir/$archive_name"
    echo "下载官方归档：$archive_url"
    if [ "$downloader" = 'curl' ]; then
      curl -fL --retry 3 --connect-timeout 20 -o "$archive" "$archive_url" || fail '下载官方 frps 归档失败' '请确认服务器能访问 github.com（DNS/代理/出口网络）后重试' "也可手动下载该归档并放到 $archive 后重试"
    else
      wget -O "$archive" "$archive_url" || fail '下载官方 frps 归档失败' '请确认服务器能访问 github.com（DNS/代理/出口网络）后重试'
    fi
    actual=$(sha256_of "$archive")
    if [ "$actual" != "$expected" ]; then
      fail '官方 SHA256 摘要不匹配，已中止安装（不做无校验安装）' "官方摘要：$expected" "实际摘要：$actual" '常见原因是下载被代理改写或网络被劫持；请更换网络后重试'
    fi
    echo '官方 SHA256 校验通过。'
    archive_root=$(printf 'frp_%s_linux_%s' "$version" "$arch")
    tar -tzf "$archive" > "$work_dir/listing" 2>/dev/null || fail '官方归档无法解压（tar 读取失败）' '请检查磁盘空间后重试'
    while IFS= read -r entry; do
      case "$entry" in
        "$archive_root"/|"$archive_root"/*|./"$archive_root"/|./"$archive_root"/*) : ;;
        *) fail '官方归档结构异常，已中止安装' "归档内出现非预期路径：$entry" ;;
      esac
    done < "$work_dir/listing"
    tar -xzf "$archive" -C "$work_dir" || fail '官方归档解压失败' '请检查磁盘空间后重试'
    if [ ! -f "$work_dir/$archive_root/frps" ]; then
      fail '归档中缺少 frps 二进制' '官方归档布局可能已变更，请重新导出部署指令'
    fi
    chmod 755 "$work_dir/$archive_root/frps"
    mv -f "$work_dir/$archive_root/frps" "$install_dir/frps" || fail "无法写入 $install_dir/frps" '请检查磁盘空间与权限'
    installed_version=$("$install_dir/frps" --version 2>/dev/null || true)
    if [ "$installed_version" != "$version" ]; then
      fail '安装后的 frps 版本校验失败' "期望 $version，实际 $installed_version" '最常见原因是归档架构与服务器不符；请确认 uname -m 后重新导出部署指令'
    fi
    echo "已安装 frps $installed_version 到 $install_dir/frps。"
  fi
  chown root:frp "$install_dir/frps" 2>/dev/null || true
  chmod 755 "$install_dir/frps"
  if command -v su >/dev/null 2>&1; then
    su -s /bin/sh -c "test -x $install_dir/frps" frp >/dev/null 2>&1 || fail 'frp 用户无法执行 frps 二进制' '请检查 /opt/frp 与 frps 的权限（建议 755，或 root:frp 750）'
  fi
  mkdir -p "$cert_dir" || fail "无法创建 $cert_dir" '请检查磁盘空间与权限'
  chmod 700 "$cert_dir"
  cat > "$cert_dir/ca.crt" <<'PROFER_CA_CRT'
${material.caCert.trim()}
PROFER_CA_CRT
  cat > "$cert_dir/ca.key" <<'PROFER_CA_KEY'
${material.caKey.trim()}
PROFER_CA_KEY
  cat > "$cert_dir/server.crt" <<'PROFER_SERVER_CRT'
${material.serverCert.trim()}
PROFER_SERVER_CRT
  cat > "$cert_dir/server.key" <<'PROFER_SERVER_KEY'
${material.serverKey.trim()}
PROFER_SERVER_KEY
  cat > "$cert_dir/frps.toml" <<'PROFER_FRPS_TOML'
${renderFrpsToml(c).trim()}
PROFER_FRPS_TOML
  cat > "$cert_dir/frps.service" <<'PROFER_FRPS_SERVICE'
${FRPS_SERVICE.trim()}
PROFER_FRPS_SERVICE
  chmod 600 "$cert_dir/ca.key" "$cert_dir/server.key" "$cert_dir/frps.toml"
  chmod 644 "$cert_dir/ca.crt" "$cert_dir/server.crt" "$cert_dir/frps.service"
  mkdir -p /etc/frp || fail '无法创建 /etc/frp' '请检查权限'
  chown root:frp /etc/frp 2>/dev/null || true
  chmod 750 /etc/frp
  if ! cp -f "$cert_dir/frps.toml" /etc/frp/frps.toml || ! cp -f "$cert_dir/server.crt" /etc/frp/server.crt || ! cp -f "$cert_dir/server.key" /etc/frp/server.key || ! cp -f "$cert_dir/ca.crt" /etc/frp/ca.crt; then
    fail '写入 /etc/frp 配置与证书失败' '请检查磁盘空间与权限'
  fi
  chown frp:frp /etc/frp/frps.toml /etc/frp/server.crt /etc/frp/server.key 2>/dev/null || true
  chmod 600 /etc/frp/frps.toml /etc/frp/server.crt /etc/frp/server.key
  chown root:root /etc/frp/ca.crt 2>/dev/null || true
  chmod 644 /etc/frp/ca.crt
  mkdir -p /etc/systemd/system || fail '无法创建 /etc/systemd/system' '请检查权限'
  cp -f "$cert_dir/frps.service" /etc/systemd/system/frps.service || fail '写入 systemd 服务失败' '请检查磁盘空间与权限'
  chmod 644 /etc/systemd/system/frps.service
  if ! systemctl is-active --quiet frps; then
    port_used=''
    if command -v ss >/dev/null 2>&1; then port_used=$(ss -ltn 2>/dev/null | grep -c ":$server_port " || true)
    elif command -v netstat >/dev/null 2>&1; then port_used=$(netstat -ltn 2>/dev/null | grep -c ":$server_port " || true)
    fi
    if [ -n "$port_used" ] && [ "$port_used" != '0' ]; then
      echo "提示：控制端口 $server_port 已被其它进程监听，frps 可能因此启动失败。" >&2
      if command -v ss >/dev/null 2>&1; then ss -ltnp 2>/dev/null | grep ":$server_port " >&2 || true; fi
    fi
  fi
  systemctl daemon-reload || fail 'systemctl daemon-reload 失败' '请检查 systemd 是否正常'
  systemctl enable frps >/dev/null 2>&1 || fail 'systemctl enable frps 失败' '请手动执行 systemctl enable frps 查看原因'
  if ! systemctl restart frps; then
    echo '--- journalctl -u frps（最近 20 行）---' >&2
    if command -v journalctl >/dev/null 2>&1; then journalctl -u frps -n 20 --no-pager >&2 || true; fi
    fail 'frps 服务启动失败' '常见原因：控制端口被占用、证书或配置不可读、安全模块阻断' '排查：journalctl -u frps -n 50 --no-pager'
  fi
  sleep 1
  systemctl is-active --quiet frps || fail 'frps 未能保持运行' '排查：journalctl -u frps -n 50 --no-pager'
  firewall_ports='${firewallPorts}'
  firewall_opened=''
  if command -v ufw >/dev/null 2>&1; then
    if ufw status 2>/dev/null | grep -q 'Status: active'; then
      firewall_ok=1
      for port in $firewall_ports; do ufw allow "$port/tcp" >/dev/null 2>&1 || firewall_ok=''; done
      if [ "$firewall_ok" = '1' ]; then firewall_opened='ufw'; fi
    fi
  fi
  if [ -z "$firewall_opened" ] && command -v firewall-cmd >/dev/null 2>&1; then
    if firewall-cmd --state >/dev/null 2>&1; then
      firewall_ok=1
      for port in $firewall_ports; do firewall-cmd --permanent --add-port="$port/tcp" >/dev/null 2>&1 || firewall_ok=''; done
      if [ "$firewall_ok" = '1' ] && firewall-cmd --reload >/dev/null 2>&1; then firewall_opened='firewalld'; fi
    fi
  fi
  echo ''
  if [ -n "$firewall_opened" ]; then
    echo "已通过 $firewall_opened 放行端口：${firewallPortsText}。"
  else
    echo "未检测到可用的 ufw 或 firewalld；请手动放行端口：${firewallPortsText}。"
  fi
  echo '${firewall}'
  echo '${cloudNote}'
  ssh_source=''
  if [ -n "\${SSH_CLIENT:-}" ]; then set -- $SSH_CLIENT; ssh_source=$1; fi
  if [ -n "$ssh_source" ]; then
    echo "安全建议：控制端口 $server_port/TCP 尽量只允许你的桌面出口 IP。你当前的 SSH 来源是 $ssh_source；如桌面走同一出口，可执行：ufw delete allow $server_port/tcp && ufw allow from $ssh_source to any port $server_port proto tcp"
  else
    echo "安全建议：控制端口 $server_port/TCP 尽量只允许你的桌面出口 IP（ufw：ufw allow from <你的桌面出口 IP> to any port $server_port proto tcp）。"
  fi
  echo ''
  echo '--- systemctl status frps ---'
  systemctl --no-pager --full status frps || true
  if command -v journalctl >/dev/null 2>&1; then
    echo ''
    echo '--- journalctl -u frps（最近 10 行）---'
    journalctl -u frps -n 10 --no-pager || true
  fi
  echo ''
  echo "frps $version 已安装并启动；ca.key 与 server.key 只保留在本机 $cert_dir，不要外传。"
  )
deploy_status=0
profer_deploy_frps || deploy_status=$?
echo ''
if [ "$deploy_status" -eq 0 ]; then
  echo '=== Profer frps 部署完成 ==='
  echo '下一步：回到桌面 Profer 点击“启动”，再用 Android Pocket 扫描二维码。'
else
  echo "=== Profer frps 部署未完成（退出码 $deploy_status）==="
  echo '请按上面的提示处理后重新执行；本指令不会关闭你的终端会话。'
  echo '排查命令：systemctl status frps；journalctl -u frps -n 50 --no-pager'
fi
exit "$deploy_status"
)
`
}
/** “复制部署指令”与 zip 复用同一渲染函数，内容等价。 */
export function renderDeploymentInstructions(input: FrpConfig, material: FrpDeploymentMaterial, assets: FrpServerAsset[]): string { return renderDeploymentScript(input, material, assets) }
/** 次要可选：用户自行管理控制 CA 时使用；默认流程由 Profer 生成。 */
export function controlCaOverrideScript(serverAddr: string): string {
  return `#!/bin/sh
# 可选：自行签发 frps 控制证书（默认不需要，Profer 已生成并托管）。
set -eu
umask 077
[ "$(id -u)" = 0 ] || { echo '请以 root 在 frps 服务器执行' >&2; exit 1; }
command -v openssl >/dev/null
id frp >/dev/null 2>&1 || useradd --system --user-group --no-create-home --shell /usr/sbin/nologin frp
for file in ca.key ca.crt server.key server.crt /etc/frp/server.key /etc/frp/server.crt; do [ ! -e "$file" ] || { echo "拒绝覆盖已有 $file" >&2; exit 1; }; done
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -sha256 -nodes -keyout ca.key -out ca.crt -days 3650 -subj '/CN=Profer FRP Control CA' -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign'
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout server.key -out server.csr -subj '/CN=Profer FRP Control'
printf '%s\n' 'basicConstraints=critical,CA:FALSE' 'keyUsage=critical,digitalSignature' 'extendedKeyUsage=serverAuth' 'subjectAltName=${isIP(serverAddr) ? 'IP' : 'DNS'}:${serverAddr}' > server.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 365 -sha256 -extfile server.ext
openssl verify -CAfile ca.crt -purpose sslserver ${isIP(serverAddr) ? '-verify_ip' : '-verify_hostname'} '${serverAddr}' server.crt
chmod 600 ca.key server.key
install -d -o root -g frp -m 750 /etc/frp
install -o frp -g frp -m 600 server.crt /etc/frp/server.crt
install -o frp -g frp -m 600 server.key /etc/frp/server.key
echo '自行管理控制 CA 时，请把 ca.crt 内容替换进 Profer 托管 CA（或使用高级覆盖入口）。'
`
}
export function renderDeploymentReadme(input: FrpConfig): string {
  const c = validateFrpConfig(input)
  const pinned = publicMode(c) === 'pinned'
  const host = c.publicUrl ? new URL(c.publicUrl).hostname : c.serverAddr
  const endpoint = pinned ? `${pinnedPublicUrl(c)} 直接透传桌面 TLS，不在服务器终止 WSS。` : `客户端使用 ${c.publicUrl}，Caddy 在 ${host} 终止 TLS。`
  return `# Profer 自建 FRP（Linux frps）\n\n本材料由 Profer 生成，含真实 FRP Token 与控制链路证书私钥（ca.key/server.key），只部署到你自己的服务器，不要上传或贴进对话。\n\n两种等价交付方式：可直接复制粘贴执行的“部署指令”（即本目录 deploy.sh）和本 zip；二者内容一致。\n\n## 部署步骤\n\n1. 推荐用法：把 deploy.sh 上传到服务器后执行 bash deploy.sh；也可以整段复制粘贴到服务器执行。任何一步失败只会结束脚本自身，不会关闭你的登录会话。\n2. 以 root 执行 deploy.sh，它会自动完成：判定 CPU 架构（x86_64→amd64、aarch64/arm64→arm64、armv7l→arm）→ 从官方 GitHub Release 下载 frp_${c.serverVersion}_linux_<arch>.tar.gz → 用官方 Release 的 sha256 摘要校验（归档里没有该架构摘要或校验不通过时拒绝安装，不做无校验安装）→ 解压并安装 frps 到 /opt/frp/frps（root:frp、755，确保 frp 用户可执行）→ 写入 /etc/frp/{frps.toml,server.crt,server.key,ca.crt}（frps 读的三个文件 frp:frp 600）与 /etc/systemd/system/frps.service → systemctl daemon-reload/enable/restart → 尝试用 ufw 或 firewalld 放行端口。不需要你预先准备 frps 二进制。\n3. 重复执行是幂等的：已安装同版本不会重复下载，已有 frp 用户、目录与服务不会报错。\n4. 放行端口：${firewallHint(c)} 脚本放行不了云安全组，请在云控制台手动放行上述端口。\n5. 验证：systemctl status frps、journalctl -u frps，再在桌面点击“启动”并刷新二维码用 Android Pocket 扫码。frpc 登录、端口可达或 /health 200 都不能冒充应用链路可用，必须完成 TLS、hello/deviceId、鉴权与消息往返。\n\n## 排错\n\n- 安装后的 frps 版本校验失败：归档架构与服务器不符，用 uname -m 确认后重新导出部署指令。\n- 官方 SHA256 摘要不匹配：脚本 fail closed，不会做无校验安装；多由代理改写或网络被劫持导致。\n- 摘要或端口报错但不确定下一步：脚本结尾会打印 systemctl status frps 与 journalctl -u frps。\n- frp 用户不可执行：确认 /opt/frp 与 frps 为 root:frp 750 或 755。\n- 服务反复重启：journalctl -u frps -n 50 --no-pager 查看证书路径、端口占用与安全模块拦截。\n\n## 安全边界\n\n- frps 强制 TLS（transport.tls.force=true）并使用 server.crt/server.key；桌面 frpc 以 Profer 本地生成的 ca.crt 作为 trustedCaFile，严格校验 frps 的 CA 链、serverAuth 用途与匹配 ${c.serverAddr} 的 SAN，没有降级为“不验证”。\n- ca.crt 只用于 frpc → frps 控制链路，不是 Pocket 应用 WSS 的信任锚；不要导入手机或系统信任库。\n- 应用端到端 WSS 由桌面 TLS 身份终止，Pocket 依赖可信本机屏幕扫码得到的 SPKI pin。桌面公网 IP 变化会复用私钥并更新 SAN，显式轮换后必须重新扫码。\n- ${endpoint}\n- 不要在服务器上加 Nginx/Caddy 终止应用层 TLS：frps 只做透明 TCP 转发，终止会断开端到端信任。\n- ca.key 与 server.key 只保留在你的服务器；桌面 TLS 应用私钥从不导出。\n- 若你希望自行管理控制 CA，可改用次要可选脚本 control-ca.sh；默认流程不需要。\n\n独立 FRP Token 见 frps.toml 的 auth.token；它与 Profer 远控凭据、扫码 pairingCode、桌面 TLS 私钥相互独立。\n`
}
export function deploymentFiles(input: FrpConfig, material: FrpDeploymentMaterial, assets: FrpServerAsset[]): Record<string, string> {
  const c = validateFrpConfig(input)
  if (!c.serverAddr) throw new Error('导出部署材料需要服务器地址')
  const pinned = publicMode(c) === 'pinned'
  const host = c.publicUrl ? new URL(c.publicUrl).hostname : c.serverAddr
  return {
    'frps.toml': renderFrpsToml(c),
    'frps.service': FRPS_SERVICE,
    'ca.crt': material.caCert,
    'ca.key': material.caKey,
    'server.crt': material.serverCert,
    'server.key': material.serverKey,
    'deploy.sh': renderDeploymentScript(input, material, assets),
    'control-ca.sh': controlCaOverrideScript(c.serverAddr),
    ...(pinned ? {} : { 'Caddyfile': `${host} {\n  reverse_proxy 127.0.0.1:${c.remotePort}\n}\n` }),
    'README.md': renderDeploymentReadme(c),
  }
}
