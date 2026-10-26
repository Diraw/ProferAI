import { describe, expect, test } from 'bun:test'
import { connect, type AddressInfo, type Server, type Socket } from 'node:net'
import { createProtocolSniffer, isTlsHandshake, type ConnectionSink } from './remote-protocol-sniffer'

/** 记录收到连接的 sink；数据按流收集，首个字节必须原样保留（嗅探后要 unshift 回去）。 */
function sink(label: string, seen: string[], payloads: string[]): ConnectionSink {
  return (socket: Socket) => {
    seen.push(label)
    payloads.push('')
    const index = payloads.length - 1
    socket.on('data', (chunk) => { payloads[index] += chunk.toString('latin1') })
    socket.on('end', () => socket.destroy())
    socket.on('error', () => socket.destroy())
  }
}

function port(server: Server): number { return (server.address() as AddressInfo).port }

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
}

function send(target: number, payload: Buffer): Promise<void> {
  return new Promise((resolve) => {
    const socket = connect(target, '127.0.0.1', () => socket.end(payload))
    socket.on('close', () => resolve())
    socket.on('error', () => resolve())
    setTimeout(() => { socket.destroy(); resolve() }, 1_000)
  })
}

const wait = (ms = 50): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('remote protocol sniffer', () => {
  test('routes TLS handshake to wss sink and plaintext to ws sink, keeping first byte', async () => {
    const seen: string[] = []
    const payloads: string[] = []
    const front = createProtocolSniffer((tls) => sink(tls ? 'tls' : 'plain', seen, payloads))
    await listen(front)
    try {
      const hello = Buffer.from([0x16, 0x03, 0x01, 0x00, 0x2a])
      const plain = Buffer.from('GET /health HTTP/1.1\r\n\r\n', 'latin1')
      await send(port(front), hello)
      await send(port(front), plain)
      await wait()
      expect(seen).toEqual(['tls', 'plain'])
      expect(payloads).toEqual([hello.toString('latin1'), plain.toString('latin1')])
    } finally {
      front.close()
    }
  })

  test('fails closed when the target is unavailable', async () => {
    const seen: string[] = []
    const front = createProtocolSniffer(() => null)
    await listen(front)
    try {
      await send(port(front), Buffer.from([0x16, 0x03, 0x01]))
      expect(seen).toEqual([])
    } finally {
      front.close()
    }
    expect(isTlsHandshake(Buffer.from([0x16]))).toBe(true)
    expect(isTlsHandshake(Buffer.from([0x47]))).toBe(false)
    expect(isTlsHandshake(Buffer.alloc(0))).toBe(false)
  })
})
