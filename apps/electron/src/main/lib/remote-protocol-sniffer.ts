/**
 * 单端口双协议前置：同一个监听端口同时接受明文 HTTP/ws 与 TLS wss。
 *
 * 用户自建 FRP / 端口映射时，只需要把公网端口映射到本机这一个端口，
 * 不必为公网 TLS 额外开一个端口。
 *
 * 判定依据是连接上的第一个字节：`0x16` 是 TLS handshake 的 content type，
 * 其余一律按明文 HTTP 处理。只嗅探一个字节，随后原样 unshift 回去交给目标 sink。
 *
 * 投递方式刻意做成函数而不是直接 `server.emit('connection')`：
 * Bun 的 net/http 实现不注册 `connection` 事件监听，emit 会静默丢弃连接；
 * 由调用方决定怎么把 socket 交给真正的 server，嗅探逻辑本身保持可测。
 */
import { createServer, type Server, type Socket } from 'node:net'

/** TLS handshake 记录的第一个字节固定为 0x16。 */
export function isTlsHandshake(first: Buffer): boolean {
  return first.length > 0 && first[0] === 0x16
}

/** 把已连接的 socket 交给目标 server；resolve 返回 null 表示当前不可用，直接断开（fail closed）。 */
export type ConnectionSink = (socket: Socket) => void

/** 创建嗅探前端。`resolve` 按是否 TLS 返回投递函数。 */
export function createProtocolSniffer(resolve: (tls: boolean) => ConnectionSink | null): Server {
  return createServer((socket) => {
    socket.once('readable', () => {
      const first = socket.read(1) as Buffer | null
      if (!first) { socket.destroy(); return }
      socket.unshift(first)
      const sink = resolve(isTlsHandshake(first))
      if (!sink) { socket.destroy(); return }
      sink(socket)
    })
  })
}
