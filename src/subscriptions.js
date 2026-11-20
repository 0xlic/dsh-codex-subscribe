import { UserError, routeOf } from './accounts.js'

/** Shared application operations for UI RPC and the management tool. */
export class Subscriptions {
  constructor({ accounts, llm, adapterFactory, authFactory, catalogFactory, pruneCatalogCache, chatRouter, onRemoved }) {
    Object.assign(this, { accounts, llm, adapterFactory, authFactory, catalogFactory, pruneCatalogCache, chatRouter, onRemoved })
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
      let removed = false
      for (const [id, current] of this.routes) {
        if (!keep.has(id)) {
          current.catalog?.dispose(); current.dispose(); this.routes.delete(id)
          this.onRemoved?.(id)
          removed = true
        }
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
        const getCredential = async options => {
          const result = await auth.getAuth('openai-codex', options)
          const stored = await this.accounts.read(account.id)
          options?.signal?.throwIfAborted()
          if (!result?.auth?.apiKey) throw new UserError('Subscription is not signed in')
          return { type: 'oauth', access: result.auth.apiKey, accountId: stored.credential.accountId }
        }
        entry.catalog = this.catalogFactory?.({
          getCredential,
          readCredential: async () => (await this.accounts.read(account.id)).credential,
          onUpdated: () => {
            if (!this.disposed && this.routes.get(account.id) === entry) entry.dispose.replace([account.provider])
          },
        })
        const adapter = this.adapterFactory({
          route: routeOf(account.id),
          label: () => entry.label.replace(/^codex(?=-|$)/, 'Codex'),
          getCredential,
          catalog: entry.catalog,
          chatRouter: this.chatRouter,
        })
        Object.assign(entry, { id: account.id, provider: account.provider, adapter, getCredential })
        entry.dispose = this.llm.registerAdapter([account.provider], adapter)
        this.routes.set(account.id, entry)
      }
      if (removed) {
        try { await this.pruneCatalogCache?.(accounts) } catch { /* Cache cleanup cannot undo account removal. */ }
      }
    })
  }
  async usageCredential(id, signal) {
    const entry = this.routes.get(id)
    if (this.disposed || !entry) throw new UserError('Subscription no longer exists')
    const grant = await entry.getCredential({ signal })
    if (this.disposed || this.routes.get(id) !== entry || !grant.accountId) throw new UserError('Subscription no longer exists')
    return grant
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
  async list() {
    return { accounts: (await this.accounts.list()).map(account => {
      const catalog = this.routes.get(account.id)?.catalog
      return catalog ? { ...account, modelCatalog: catalog.status() } : account
    }) }
  }
  async manage(input) {
    if (!input || typeof input !== 'object') throw new UserError('Invalid operation')
    if (input.action === 'list') return this.list()
    if (input.action === 'refresh-models') {
      await this.sync()
      const entries = input.id === undefined ? [...this.routes.values()] : [this.routes.get(input.id)]
      if (!entries.length || entries.some(entry => !entry?.catalog)) throw new UserError('Subscription model catalog is unavailable')
      const results = await Promise.allSettled(entries.map(entry => entry.catalog.refresh()))
      if (results.some(result => result.status === 'rejected')) throw new UserError('Model catalog refresh failed; previous models were kept. Check the connection and subscription sign-in, then retry.')
      return this.list()
    }
    if (input.action === 'rename') await this.accounts.rename(input.id, input.label)
    else if (input.action === 'remove') await this.accounts.remove(input.id)
    else if (input.action === 'remove-all') {
      const snapshot = await this.accounts.list()
      for (const account of snapshot) await this.accounts.remove(account.id)
    }
    else throw new UserError('Unknown operation')
    await this.sync()
    return this.list()
  }
  dispose() {
    this.disposed = true
    for (const entry of this.routes.values()) { entry.catalog?.dispose(); entry.dispose() }
    this.routes.clear()
  }
}
