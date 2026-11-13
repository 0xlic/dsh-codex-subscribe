import { UserError, routeOf } from './accounts.js'

/** Shared application operations for UI RPC and the management tool. */
export class Subscriptions {
  constructor({ accounts, llm, adapterFactory, authFactory }) {
    Object.assign(this, { accounts, llm, adapterFactory, authFactory })
    this.routes = new Map()
    this.tail = Promise.resolve()
    this.disposed = false
  }
  enqueue(operation) {
    const next = this.tail.catch(() => {}).then(() => {
      if (this.disposed) throw new UserError('Plugin is stopped')
      return operation()
    })
    this.tail = next.catch(() => {})
    return next
  }
  async sync() {
    return this.enqueue(async () => {
      const accounts = await this.accounts.list()
      if (this.disposed) return
      const keep = new Set(accounts.map(a => a.id))
      for (const [id, current] of this.routes) {
        if (!keep.has(id)) { current.dispose(); this.routes.delete(id) }
      }
      for (const account of accounts) {
        const current = this.routes.get(account.id)
        if (current) {
          if (current.label !== account.label) {
            current.label = account.label
            current.dispose.replace([account.provider])
          }
          continue
        }
        const entry = { label: account.label }
        const auth = this.authFactory(this.accounts.store(account.id))
        const adapter = this.adapterFactory({
          route: routeOf(account.id),
          label: () => entry.label.replace(/^codex(?=-|$)/, 'Codex'),
          getCredential: async options => {
            const result = await auth.getAuth('openai-codex', options)
            if (!result?.auth?.apiKey) throw new UserError('Subscription is not signed in')
            return { type: 'oauth', access: result.auth.apiKey }
          },
        })
        entry.dispose = this.llm.registerAdapter([account.provider], adapter)
        this.routes.set(account.id, entry)
      }
    })
  }
  async imageCredential(id, signal) {
    if (this.disposed) throw new UserError('Plugin is stopped')
    const auth = this.authFactory(this.accounts.store(id))
    const result = await auth.getAuth('openai-codex', { signal })
    // getAuth refreshes under the same account-scoped credential lock used by chat.
    const stored = await this.accounts.read(id)
    signal?.throwIfAborted()
    if (!result?.auth?.apiKey || !stored.credential.accountId) throw new UserError('Subscription is not signed in')
    return { access: result.auth.apiKey, accountId: stored.credential.accountId }
  }
  async manage(input) {
    if (!input || typeof input !== 'object') throw new UserError('Invalid operation')
    if (input.action === 'list') return { accounts: await this.accounts.list() }
    if (input.action === 'rename') await this.accounts.rename(input.id, input.label)
    else if (input.action === 'remove') await this.accounts.remove(input.id)
    else if (input.action === 'remove-all') {
      const snapshot = await this.accounts.list()
      for (const account of snapshot) await this.accounts.remove(account.id)
    }
    else throw new UserError('Unknown operation')
    await this.sync()
    return { accounts: await this.accounts.list() }
  }
  dispose() {
    this.disposed = true
    for (const entry of this.routes.values()) entry.dispose()
    this.routes.clear()
  }
}
