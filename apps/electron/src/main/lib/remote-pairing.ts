import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { PAIRING_TTL_MS, type PairingQr, type RemoteProfile } from '@profer/shared'

export function secretHash(secret: string): string { return createHash('sha256').update(secret).digest('hex') }
export function equalSecret(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(secretHash(a)), Buffer.from(secretHash(b)))
}
export interface RemoteBinding { id: string; name: string; tokenHash: string; createdAt: number }
export type PairingAuditKind = 'pairing_consumed' | 'pairing_rejected' | 'rate_limited' | 'authentication_rejected' | 'identity_rejected'
export interface PairingAudit { at: number; kind: PairingAuditKind; peerId: string }
export class PairingManager {
  private active: { codeHash: string; expiresAt: number } | null = null
  private attempts = new Map<string, { count: number; until: number }>()
  private audit: PairingAudit[] = []
  private readonly auditSalt = randomBytes(32)
  record(kind: PairingAuditKind, peer: string): void {
    const peerId = createHash('sha256').update(this.auditSalt).update(peer).digest('hex').slice(0, 16)
    this.audit.push({ at: this.now(), kind, peerId }); this.audit = this.audit.slice(-200)
  }
  getAudit(): PairingAudit[] { return this.audit.map((event) => ({ ...event })) }
  constructor(private now: () => number = Date.now) {}
  refresh(profile: RemoteProfile): PairingQr {
    const pairingCode = randomBytes(32).toString('hex')
    const issuedAt = this.now()
    this.active = { codeHash: secretHash(pairingCode), expiresAt: issuedAt + PAIRING_TTL_MS }
    return { ...profile, kind: 'profer-pairing', pairingCode, issuedAt, expiresAt: issuedAt + PAIRING_TTL_MS }
  }
  revoke(): void { this.active = null }
  consume(code: string, peer: string): void {
    const now = this.now()
    for (const [key, value] of this.attempts) if (value.until <= now) this.attempts.delete(key)
    const attempt = this.attempts.get(peer) ?? { count: 0, until: now + 60_000 }
    if (attempt.count >= 5) { this.record('rate_limited', peer); throw new Error('配对尝试过多，请稍后重试') }
    attempt.count++
    if (this.attempts.size >= 1024 && !this.attempts.has(peer)) this.attempts.delete(this.attempts.keys().next().value!)
    this.attempts.set(peer, attempt)
    if (!this.active || this.active.expiresAt <= now || !equalSecret(secretHash(code), this.active.codeHash)) { this.record('pairing_rejected', peer); throw new Error('配对码无效或已过期') }
    this.active = null
    this.record('pairing_consumed', peer)
  }
}
export function createBinding(name: string): { binding: RemoteBinding; credential: string } {
  const credential = randomBytes(32).toString('hex')
  return { credential, binding: { id: randomUUID(), name: name.slice(0, 120) || 'Pocket', tokenHash: secretHash(credential), createdAt: Date.now() } }
}
