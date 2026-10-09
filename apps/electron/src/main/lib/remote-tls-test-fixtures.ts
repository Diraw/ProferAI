import { generate } from 'selfsigned'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spkiPin } from './remote-tls-identity'
import { X509Certificate } from 'node:crypto'
const dir = process.argv[2]!
mkdirSync(dir, { recursive: true, mode: 0o700 })
for (const name of ['correct', 'replaced', 'expired', 'wrong-san', 'wrong-usage']) {
  const now = Date.now()
  const pem = await generate([{ name: 'commonName', value: 'Test Only Profer' }], {
    keyType: 'ec', curve: 'P-256', algorithm: 'sha256', notBeforeDate: new Date(now - 86400_000), notAfterDate: new Date(now + (name === 'expired' ? -3600_000 : 86400_000)),
    extensions: [{ name: 'basicConstraints', cA: false, critical: true }, { name: 'keyUsage', digitalSignature: true, critical: true }, { name: 'extKeyUsage', serverAuth: name !== 'wrong-usage', clientAuth: name === 'wrong-usage' }, { name: 'subjectAltName', altNames: [{ type: 7, ip: name === 'wrong-san' ? '192.0.2.1' : '127.0.0.1' }] }],
  })
  writeFileSync(join(dir, `${name}.crt`), pem.cert, { mode: 0o600 }); writeFileSync(join(dir, `${name}.key`), pem.private, { mode: 0o600 }); writeFileSync(join(dir, `${name}.pin`), spkiPin(new X509Certificate(pem.cert)).value, { mode: 0o600 })
}
