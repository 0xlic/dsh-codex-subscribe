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
  const subscriptions = new Subscriptions({
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
  const login = new Login({ createModels, providerFactory: openaiCodexProvider, accounts, changed: () => subscriptions.sync() })
  ctx.effect(() => () => { login.dispose(); subscriptions.dispose() })
  await subscriptions.sync()
  const imageSettings = imageSettingsOperations(ctx, settings, accounts)
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
      case 'list': {
        await subscriptions.sync()
        return { ...await subscriptions.manage(input), ...(login.session ? { login: login.read(login.session.view.id) } : {}) }
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
