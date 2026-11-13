import { randomBytes, randomUUID } from 'node:crypto'

export const SCOPE = 'codex-subscribe'
export const NATIVE_PROVIDER = 'openai-codex'
const ID = /^account-[a-f0-9]{32}$/
const SUFFIX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/
export class UserError extends Error {}
export function validateId(id) {
  if (typeof id !== 'string' || !ID.test(id)) throw new UserError('Invalid subscription ID')
  return id
}
export function validateLabel(label) {
  if (typeof label !== 'string' || !SUFFIX.test(label) || /^codex(?:-|$)/i.test(label)) {
    throw new UserError('Suffix must contain 1–32 letters, numbers, underscores or hyphens, start with a letter or number, and omit the fixed codex prefix')
  }
  return label
}
export const routeOf = id => `codex-sub-${validateId(id).slice(8)}`
export function validateCredential(value) {
  if (!value || value.type !== 'oauth' || typeof value.access !== 'string' || !value.access
    || typeof value.refresh !== 'string' || !value.refresh || !Number.isFinite(value.expires)) {
    throw new UserError('Invalid OAuth credential')
  }
  return structuredClone(value)
}
function payload(record) {
  const p = record?.kind === 'grant' && record.payload
  if (!p || ![1, 2].includes(p.version) || typeof p.label !== 'string') throw new UserError('Subscription record is invalid')
  validateCredential(p.credential)
  return p
}
function randomSuffix() {
  // Rejection sampling avoids modulo bias while keeping generated names alphabetic.
  let suffix = ''
  while (suffix.length < 8) for (const byte of randomBytes(12)) {
    if (byte < 234) suffix += String.fromCharCode(97 + byte % 26)
    if (suffix.length === 8) break
  }
  return suffix
}
function normalizeEmail(value) {
  if (typeof value !== 'string') return ''
  const email = value.trim().toLowerCase()
  const [local, domain] = email.split('@')
  return email.length <= 254 && local?.length <= 64 && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..')
    && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,63}$/.test(email)
    && domain.split('.').every(part => part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part)) ? email : ''
}
function credentialEmail(credential) {
  // JWT payloads are unverified display hints only, never evidence of account identity.
  for (const token of [credential.access, credential.idToken, credential.id_token]) {
    if (typeof token !== 'string' || token.length > 65536) continue
    try {
      const parts = token.split('.')
      if (parts.length !== 3) continue
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
      for (const candidate of [claims?.['https://api.openai.com/profile']?.email, claims?.email]) {
        const email = normalizeEmail(candidate)
        if (email) return email
      }
    } catch { /* Malformed or opaque tokens have no display email. */ }
  }
  return normalizeEmail(credential.email)
}
function withCredential(p, credential) {
  const email = credentialEmail(credential) || normalizeEmail(p.email) || (p.credential ? credentialEmail(p.credential) : '')
  const { email: previousEmail, ...rest } = p
  return { ...rest, credential, ...(email ? { email } : {}) }
}
function upgrade(p, reserved = new Set()) {
  if (p.version === 2) return p
  let label = p.label
  if (/^codex-/i.test(label)) label = label.slice(6)
  try { validateLabel(label) } catch { label = undefined }
  if (label === undefined || reserved.has(label.toLowerCase())) {
    do { label = randomSuffix() } while (reserved.has(label.toLowerCase()))
  }
  return withCredential({ ...p, version: 2, label }, p.credential)
}
export class Accounts {
  constructor(credentials, keyOf, keyId) {
    this.credentials = credentials
    this.keyOf = keyOf
    this.keyId = keyId
    this.metadata = Promise.resolve()
  }
  serializeMetadata(operation) {
    const next = this.metadata.then(operation)
    this.metadata = next.catch(() => {})
    return next
  }
  async listCurrent() {
    const accounts = []
    const reserved = new Set()
    const entries = []
    // Reserve every persisted v2 suffix before assigning any legacy names, even
    // when that v2 record appears later in the credential service's enumeration.
    for (const entry of await this.credentials.listRecords()) {
      const id = this.keyId(entry.key)
      if (!id || !ID.test(id)) continue
      const record = await this.credentials.readRecord(entry.key)
      if (!record) continue
      const p = payload(record)
      if (p.version === 2) reserved.add(p.label.toLowerCase())
      entries.push({ key: entry.key, id, record })
    }
    for (const entry of entries) {
      const { id } = entry
      let { record } = entry
      if (payload(record).version === 1) {
        // Re-read under the credential lock: the earlier read may precede a refresh.
        record = await this.credentials.modifyRecord(entry.key, async current => {
          if (!current) return undefined
          const p = payload(current)
          return p.version === 1 ? { ...current, payload: upgrade(p, reserved) } : undefined
        })
        if (!record) continue
      }
      const p = payload(record)
      reserved.add(p.label.toLowerCase())
      accounts.push({ id, provider: routeOf(id), suffix: p.label, email: normalizeEmail(p.email) || credentialEmail(p.credential),
        authStatus: p.credential.expires > Date.now() ? 'valid' : 'refresh-needed', expiresAt: p.credential.expires })
    }
    for (const account of accounts) account.label = accounts.length === 1 ? 'Codex' : `Codex-${account.suffix}`
    return accounts.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
  }
  list() { return this.serializeMetadata(() => this.listCurrent()) }
  async read(id) {
    const record = await this.credentials.readRecord(this.keyOf(validateId(id)))
    if (!record) throw new UserError('Subscription no longer exists')
    return payload(record)
  }
  async add(label, credential, signal) {
    if (label !== undefined) validateLabel(label)
    credential = validateCredential(credential)
    return this.serializeMetadata(async () => {
      signal?.throwIfAborted()
      const accounts = await this.listCurrent()
      const used = new Set(accounts.map(account => account.suffix.toLowerCase()))
      if (label === undefined) do { label = randomSuffix() } while (used.has(label.toLowerCase()))
      if (used.has(label.toLowerCase())) throw new UserError('Suffix is already in use')
      const id = `account-${randomUUID().replaceAll('-', '')}`
      await this.credentials.modifyRecord(this.keyOf(id), async current => {
        signal?.throwIfAborted()
        if (current) throw new UserError('Subscription ID collision')
        return { kind: 'grant', payload: withCredential({ version: 2, label }, credential) }
      })
      return id
    })
  }
  async rename(id, label) {
    validateId(id); label = validateLabel(label)
    return this.serializeMetadata(async () => {
      if ((await this.listCurrent()).some(account => account.id !== id && account.suffix.toLowerCase() === label.toLowerCase())) {
        throw new UserError('Suffix is already in use')
      }
      await this.credentials.modifyRecord(this.keyOf(id), async current => {
        if (!current) throw new UserError('Subscription no longer exists')
        return { kind: 'grant', payload: { ...upgrade(payload(current)), label } }
      })
    })
  }
  async renew(id, credential, signal) {
    credential = validateCredential(credential)
    await this.credentials.modifyRecord(this.keyOf(validateId(id)), async current => {
      signal?.throwIfAborted()
      if (!current) throw new UserError('Subscription no longer exists')
      const p = payload(current)
      // A renewal must not silently replace the account behind a durable route.
      if (!p.credential.accountId || credential.accountId !== p.credential.accountId) throw new UserError('Sign in with the original subscription account')
      return { kind: 'grant', payload: withCredential(p, credential) }
    })
  }
  async remove(id) {
    await this.credentials.deleteRecord(this.keyOf(validateId(id)))
  }
  store(id) {
    const key = this.keyOf(validateId(id))
    const assertProvider = provider => { if (provider !== NATIVE_PROVIDER) throw new UserError('Unknown credential provider') }
    return {
      read: async (provider, options) => {
        assertProvider(provider); options?.signal?.throwIfAborted()
        const record = await this.credentials.readRecord(key)
        return record ? structuredClone(payload(record).credential) : undefined
      },
      modify: async (provider, update, options) => {
        assertProvider(provider)
        const record = await this.credentials.modifyRecord(key, async current => {
          options?.signal?.throwIfAborted()
          if (!current) throw new UserError('Subscription no longer exists')
          const p = payload(current)
          const next = await update(structuredClone(p.credential))
          return next === undefined ? undefined : { kind: 'grant', payload: withCredential(p, validateCredential(next)) }
        })
        return record ? structuredClone(payload(record).credential) : undefined
      },
      list: async () => (await this.credentials.readRecord(key)) ? [{ providerId: NATIVE_PROVIDER, type: 'oauth' }] : [],
      delete: async provider => { assertProvider(provider); throw new UserError('Use remove subscription instead') },
    }
  }
}
