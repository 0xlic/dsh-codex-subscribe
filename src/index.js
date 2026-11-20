import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection'
import { credentialKey, credentialKeyId, credentialKeyScope } from '@deepseek-ai/dsh-credentials'
import { createModels } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { Accounts, SCOPE, UserError } from './accounts.js'
import { createAccountAdapter } from './adapter.js'
import { Login } from './login.js'
import { Subscriptions } from './subscriptions.js'
import { Config, IMAGE_DEFAULTS, validateImageSettings, imageSettingsOperations } from './image-settings.js'
import { createImageTool } from './images.js'
import { prepareImageExport } from './image-export.js'
import { openImageAccountMemory } from './image-accounts.js'
import { createModelCatalog } from './model-catalog.js'
import { openModelCatalogStore } from './model-catalog-store.js'
import { createCodexUsage } from './codex-usage.js'
import { prepareChatAccount } from './chat-account.js'
import { createChatRouter } from './chat-failover.js'
export { Config }

export const name = 'codex-subscribe'
export const inject = ['llm', 'credentials', 'connection', 'tools', 'storageDomain']
const METHOD = 'codex-subscribe/manage'
export async function apply(ctx, config = {}) {
  const settings = validateImageSettings({ ...IMAGE_DEFAULTS, ...config.images })
  let stopped = false
  ctx.effect(() => () => { stopped = true })
  const accounts = new Accounts(ctx.credentials,
    id => credentialKey(SCOPE, id),
    key => credentialKeyScope(key) === SCOPE ? credentialKeyId(key) : undefined)
  let cacheStore
  const store = () => cacheStore ??= Promise.resolve().then(() => openModelCatalogStore(ctx.storageDomain)).catch(() => undefined)
  // Cache failures must not disable sign-in or a valid online directory.
  const cache = {
    read: async id => (await store())?.read(id),
    write: async (id, entry) => (await store())?.write(id, entry),
    remove: async id => (await store())?.remove(id),
  }
  ctx.effect(() => async () => { await (await cacheStore)?.close() })
  const usage = createCodexUsage({ accounts,
    getCredential: (id, signal) => subscriptions.usageCredential(id, signal),
    isEnabled: provider => [...subscriptions.routes.values()].some(entry => entry.provider === provider),
  })
  // Track explicit native selection events, not just equality of the current
  // choice: a user may switch away and back while a backup is streaming.
  const selectionRevisions = new WeakMap()
  if (config.chatFailover === true && typeof ctx.on === 'function') {
    ctx.on('session/event', (session, event) => {
      if (event.type === 'model/selection') selectionRevisions.set(session, event)
    })
  }
  const chatRouter = config.chatFailover === true ? createChatRouter({
    listAccounts: async () => stopped ? [] : [...subscriptions.routes.values()],
    prepare: async (entry, options, primary) => {
      const attempt = await prepareChatAccount(entry, options, primary)
      if (!attempt || stopped || subscriptions.routes.get(entry.id) !== entry) return undefined
      return signal => {
        if (stopped || subscriptions.routes.get(entry.id) !== entry) throw new UserError('Subscription no longer exists')
        return attempt(signal)
      }
    },
    getQuota: usage.getQuota.bind(usage),
    readQuota: usage.readQuota.bind(usage),
    beginSelectionSwitch(options) {
      const agents = ctx.get?.('agents')
      const agent = agents?.get(options.sessionId)
      const choice = agent?.model.current()
      if (!choice || typeof agent.model.select !== 'function') return undefined
      if (choice.provider !== options.provider || choice.model !== options.model) return () => false
      // DSH can materialize Auto after adapter preparation (e.g. a scoped
      // default). Use the recorded request to distinguish Auto from an
      // explicit effort, and keep the original choice when changing provider.
      const header = agent.session.requestHeader?.()
      const defaulted = header?.adapterDefaults?.reasoningEffort === true
        && header.config.provider === options.provider && header.config.model === options.model
        && header.config.reasoningEffort === options.reasoningEffort
      const requestedEffort = defaulted ? undefined : options.reasoningEffort
      if (choice.reasoningEffort !== requestedEffort) return () => false
      const revision = selectionRevisions.get(agent.session)
      return entry => {
        if (stopped || subscriptions.routes.get(entry.id) !== entry
          || selectionRevisions.get(agent.session) !== revision) return false
        const live = ctx.get?.('agents')?.get(options.sessionId)
        const current = live?.model.current()
        // select() appends synchronously; a manual choice wins if it changed
        // while the backup was streaming. Never write another session/default.
        if (live !== agent || !current || current.provider !== choice.provider || current.model !== choice.model
          || current.reasoningEffort !== choice.reasoningEffort) return false
        live.model.select({ ...choice, provider: entry.provider })
        return true
      }
    },
  }) : undefined
  ctx.effect(() => () => { chatRouter?.dispose(); usage.dispose() })
  const subscriptions = new Subscriptions({
    chatRouter,
    onRemoved: id => usage.invalidate(`codex-sub-${id.slice('account-'.length)}`),
    pruneCatalogCache: async remaining => {
      const ids = await Promise.all(remaining.map(async account => (await accounts.read(account.id)).credential.accountId))
      await (await store())?.retain(ids.filter(id => typeof id === 'string' && id))
    },
    catalogFactory: options => {
      const native = openaiCodexProvider()
      // The catalog endpoint gates models by client_version; never send the
      // plugin's own version, which would hide every newer model.
      return createModelCatalog({ ...options, baseModels: () => native.getModels(), cache })
    },
    accounts, llm: ctx.llm,
    adapterFactory: options => createAccountAdapter({ ...options, resolveAttachments: () => ctx.get('attachments') }),
    authFactory: credentials => {
      const models = createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } })
      models.setProvider(openaiCodexProvider())
      return models
    },
  })
  const login = new Login({ createModels, providerFactory: openaiCodexProvider, accounts, changed: ({ id, renewed }) => {
    if (renewed) usage.invalidate(`codex-sub-${id.slice('account-'.length)}`)
    return subscriptions.sync()
  } })
  ctx.effect(() => () => { login.dispose(); subscriptions.dispose() })
  await subscriptions.sync()
  // Expose only sanitized operations, not the owner object or its credential access.
  if (typeof ctx.provide === 'function') ctx.effect(() => ctx.provide('codexUsage', {
    version: 1,
    list: usage.list.bind(usage),
    read: usage.read.bind(usage),
    listResetCards: usage.listResetCards.bind(usage),
    useResetCard: usage.useResetCard.bind(usage),
    effectiveAccount({ sessionId, provider, model }) {
      const selection = ctx.get?.('agents')?.get(sessionId)?.model.current()
      if (!selection || selection.provider !== provider || selection.model !== model) return undefined
      const effective = chatRouter?.effectiveAccount({ sessionId, provider, model, reasoningEffort: selection.reasoningEffort })
      if (!effective || effective.provider === provider) return undefined
      const entry = subscriptions.routes.get(effective.id)
      if (!entry || entry.provider !== effective.provider) return undefined
      return { provider: entry.provider, label: entry.label }
    },
  }))
  const imageSettings = imageSettingsOperations(ctx, settings, accounts)
  async function saveChatFailover(enabled) {
    if (typeof enabled !== 'boolean') throw new UserError('Invalid account failover setting')
    if (login.session && !['authenticated', 'failed', 'cancelled'].includes(login.session.view.phase)) throw new UserError('Finish or cancel sign-in before saving settings')
    const editor = ctx.get?.('configEditor')
    const entry = ctx.fiber?.entry
    if (!editor || !entry) throw new UserError('Account failover settings cannot be saved in this profile')
    try { await editor.edit(entry, current => ({ ...current, chatFailover: enabled })) }
    catch { throw new UserError('Account failover settings could not be saved or applied') }
    return { chatFailover: enabled }
  }
  if (settings.enabled) {
    const accountMemory = await openImageAccountMemory(ctx.storageDomain)
    ctx.effect(() => () => accountMemory.close())
    // Global registration: available on DeepSeek and every other conversation model.
    ctx.effect(() => ctx.tools.register(createImageTool({
      getSettings: () => ({ ...settings, enabled: settings.enabled && !stopped }),
      accounts, accountMemory,
      getCredential: (id, signal) => subscriptions.imageCredential(id, signal),
      getSession: id => ctx.get('sessions')?.get(id),
      attachments: () => ctx.get('attachments'),
      prepareExport: (path, exec) => prepareImageExport(ctx, path, exec),
    })))
  }

  async function dispatch(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new UserError('Invalid operation')
    switch (input.action) {
      case 'images-settings': return imageSettings.get()
      case 'images-settings-save': {
        if (login.session && !['authenticated', 'failed', 'cancelled'].includes(login.session.view.phase)) throw new UserError('Finish or cancel sign-in before saving image settings')
        return imageSettings.save(input.settings)
      }
      case 'chat-failover-save': return saveChatFailover(input.enabled)
      case 'list': {
        await subscriptions.sync()
        return { ...await subscriptions.manage(input), chatFailover: config.chatFailover === true,
          ...(login.session ? { login: login.read(login.session.view.id) } : {}) }
      }
      case 'login': return login.start(input)
      case 'login-status': return login.read(input.id)
      case 'login-submit': return login.submit(input.id, input.value)
      case 'login-cancel': return login.cancel(input.id)
      default: return subscriptions.manage(input)
    }
  }
  // Exact routes compose with the core's sole /api RPC interceptor.
  // Connection admits owner-only authenticated requests before dispatch here.
  ctx.effect(() => ctx.connection.fetch.register({
    path: `/api/${METHOD}`, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return new Response('Expected JSON', { status: 415 })
      let body
      try { body = await request.json() } catch { return new Response('Invalid JSON', { status: 400 }) }
      const parsed = clientRequestSchema.safeParse(body)
      if (!parsed.success || parsed.data.method !== METHOD) return new Response('Invalid RPC envelope', { status: 400 })
      let result
      try {
        request.signal.throwIfAborted()
        result = { ok: true, value: await dispatch(parsed.data.payload) }
      } catch (error) {
        result = { ok: false, error: { code: 'codex-subscribe', message: error instanceof UserError ? error.message : 'Subscription operation failed', details: {} } }
      }
      return Response.json({ type: 'server-response', rpcId: parsed.data.rpcId, result }, { headers: { 'Cache-Control': 'no-store' } })
    },
  }))
  ctx.effect(() => ctx.tools.register({
    name: 'codex_subscriptions',
    description: 'Manage independent Codex subscriptions: list accounts and catalog status, refresh models from the account catalog, rename a suffix, remove one, or sign out all accounts. Refresh optionally targets one account by id; otherwise all. Removal deletes saved credentials and providers, not already-dispatched requests. Sign-in is user-only in Settings → Codex subscriptions.',
    parameters: {
      type: 'object', properties: {
        action: { type: 'string', enum: ['list', 'refresh-models', 'rename', 'remove', 'remove-all'] },
        id: { type: 'string', description: 'Subscription ID returned by list; required for rename/remove, optional for refresh-models.' },
        label: { type: 'string', description: 'Suffix only, without the fixed codex- prefix (1–32 letters, digits, _ or -; starts with a letter/digit). Required for rename; unique, case-insensitive.' },
      }, required: ['action'], additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { accounts: { type: 'array', items: { type: 'object', properties: {
        id: { type: 'string' }, provider: { type: 'string' }, label: { type: 'string' }, suffix: { type: 'string' }, email: { type: 'string' },
        authStatus: { type: 'string', enum: ['valid', 'refresh-needed'] }, expiresAt: { type: 'number' },
        modelCatalog: { type: 'object', properties: {
          source: { type: 'string', enum: ['builtin', 'cached', 'online'] },
          refresh: { type: 'string', enum: ['idle', 'refreshing', 'ok', 'failed'] }, count: { type: 'integer' },
        }, required: ['source', 'refresh', 'count'], additionalProperties: false },
      }, required: ['id', 'provider', 'label', 'suffix', 'email', 'authStatus', 'expiresAt'], additionalProperties: false } } }, required: ['accounts'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(input) { return subscriptions.manage(input) },
  }))
}
