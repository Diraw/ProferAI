# 自建 FRP 服务器（Android 扫码远控）

> 面向没有域名、想用自己的云主机做中转的用户。一台有公网 IP 的 Linux 云主机 + 一条部署指令即可完成。

## 一、前提

- 一台**有公网 IP 的 Linux 云主机**（amd64 / arm64 / armv7 都可以，Debian、Ubuntu、CentOS、Rocky、Alma、Alpine 等常见发行版均可）。
- 服务器能访问 `github.com`：部署脚本要从官方 Release 下载 frps 并校验官方 SHA256 摘要。
- 需要放行两个端口：
  - **FRP 控制端口**：桌面 frpc 连到 frps，建议只对你桌面的出口 IP 放行。
  - **TCP 映射端口**：手机扫码后要访问的端口，需要对外可达。
- 云厂商的**安全组**不会自动放行，必须到云控制台手动加规则（脚本无法代你修改）。

## 二、一条命令完成部署

1. 打开桌面 **设置 → 连接 → 远程连接 → 移动模式 → 自建 FRP**。
2. 只填三件事：**frps 公网 IP / 域名**、**FRP 控制端口**、**TCP 映射端口**。FRP Token、控制 CA 和 server 证书由 Profer 本地生成并托管，不用你准备。
3. 点「点击显示部署指令」，复制展开的整段指令；或点「导出部署 zip」，把 `deploy.sh` 上传到服务器。
4. 在服务器上以 root 执行：保存为文件后运行 `bash deploy.sh`；也可以把整段指令直接粘贴进 SSH 会话执行（失败只会结束脚本自己，不会关掉你的终端）。

部署指令会自动完成这些事，不需要你预先安装 frps：

- 判定 CPU 架构（`x86_64` → amd64、`aarch64/arm64` → arm64、`armv7l` → arm）；
- 从官方 GitHub Release 下载 `frp_<版本>_linux_<架构>.tar.gz`，用官方 Release 的 sha256 摘要校验；**摘要取不到或校验不通过就直接拒绝安装**，不会跳过校验；
- 安装到 `/opt/frp/frps` 并确保 `frp` 用户可执行；
- 写入 `/etc/frp/{frps.toml,server.crt,server.key,ca.crt}` 与 `frps.service`，然后启动 systemd 服务；
- 尝试用 `ufw` / `firewalld` 放行端口；检测不到防火墙时，会直接打印你需要手动放行的端口。

重复执行是幂等的：已安装同版本不会重复下载，已有的 `frp` 用户、目录和服务不会报错。

## 三、验证

在服务器上检查服务：

```bash
systemctl status frps
journalctl -u frps -n 50 --no-pager
```

然后回到桌面：**自建 FRP → 启动**；再打开二维码，用 Android 原生 Pocket 扫码。

注意：frpc 登录成功、端口能连通，都不代表应用链路可用，必须完成 TLS、hello/deviceId、鉴权与消息往返。

控制链路的 CA（保护 frpc → frps）与扫码时的 SPKI pin（保护 Android → 桌面 WSS）是两条独立的信任链，互不替代。

## 四、排错

- **架构不符**：脚本按 `uname -m` 选择归档。报「安装后的 frps 版本校验失败」通常是归档与 CPU 不匹配。
- **摘要不匹配**：脚本已中止安装（不会做无校验安装）。常见原因是下载被代理改写或网络被劫持，换网络后重试。
- **缺少工具**：提示缺 `curl`/`wget`、`tar` 或 `sha256sum` 时，按提示安装对应软件包后重跑。
- **frp 用户不可执行**：确认 `/opt/frp` 与 `frps` 的权限为 `root:frp 750` 或 `755`。
- **端口未放行**：脚本结尾会打印需要放行的具体端口；同时到**云安全组**放行映射端口。
- **服务反复重启**：`journalctl -u frps -n 50 --no-pager` 查看证书路径、端口占用和安全模块拦截。

## 五、安全边界

- 部署指令里含**真实 FRP Token、CA 私钥和 server 私钥**：只粘贴到你自己的服务器，不要贴进对话、工单或任何公开渠道。
- 控制 CA 只用于 frpc → frps 这条控制链路，不是手机应用 WSS 的信任锚，不要导入手机或系统信任库。
- **不要在服务器上加 Nginx / Caddy 终止应用层 TLS**：frps 只做透明 TCP 转发，终止会打断端到端信任。
- 桌面公网 IP 变化会复用私钥并更新 SAN；显式「重新生成材料」会同时更换 Token 与证书，服务器必须重新部署并重新扫码。
