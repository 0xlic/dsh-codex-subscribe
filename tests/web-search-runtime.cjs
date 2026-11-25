'use strict'

// Use the installed Desktop runtime (no profile loads or network requests):
// ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" tests/web-search-runtime.cjs
// Optional: DSH_WEB_TEST_PACKAGE_ROOT points to an isolated npm install of
// @deepseek-ai/dsh-web@0.2.2-rc.1 to verify the legacy fail-closed path.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')

const ENV = 'DSH_WEB_SEARCH_PROVIDER'
const CODEX = `codex-sub-${'a'.repeat(32)}`
const OFFICIAL = 'deepseek-official'
const SEARCH_API = 'deepseek-search-api'
const OTHER = 'another-provider'
const SELECTOR = 'selectSearchProvider'

function setEnv(value) {
  if (value === undefined) delete process.env[ENV]
  else process.env[ENV] = value
}

function source(label) {
  return { url: `https://result.invalid/${label}`, title: label }
}

function synthetic(id, { ready = true, available = true } = {}) {
  return {
    id,
    available: () => available,
    async ready() { return ready },
    async search() { return { sources: [source(id)], truncated: false } },
  }
}

async function main() {
  const alternateRoot = process.env.DSH_WEB_TEST_PACKAGE_ROOT
  const anchor = alternateRoot ?? process.env.DSH_INSTALL_DIR
  assert.ok(anchor && path.isAbsolute(anchor), 'Provide an absolute Desktop install anchor or an isolated npm package root')
  if (!alternateRoot) {
    assert.ok(process.versions.electron, 'Use ELECTRON_RUN_AS_NODE=1 with the ASAR-aware Electron')
    const manifest = JSON.parse(fs.readFileSync(path.join(anchor, 'package.json'), 'utf8'))
    assert.equal(manifest.name, '@deepseek-ai/dsh')
  }
  const runtimeRequire = createRequire(path.join(anchor, 'package.json'))
  const installed = name => import(pathToFileURL(runtimeRequire.resolve(name)))
  const nativeFetch = globalThis.fetch
  const originalEnv = process.env[ENV]
  // Default to denying all fetches. The one HTTP fixture below replaces this
  // with a response-producing stub which never calls the real fetch.
  globalThis.fetch = async () => assert.fail('Unexpected HTTP request in Web runtime test')
  try {
    const { version } = runtimeRequire('@deepseek-ai/dsh-web/package.json')
    const webRequire = createRequire(runtimeRequire.resolve('@deepseek-ai/dsh-web'))
    const { Context } = await import(pathToFileURL(webRequire.resolve('@deepseek-ai/cordis')))
    const { WebRuntime, WebError } = await installed('@deepseek-ai/dsh-web')
    const { installCodexSearchPreference } = await import('../src/web-search-routing.js')
    const originalSelector = Object.getOwnPropertyDescriptor(WebRuntime.prototype, SELECTOR)
    const liveFibers = []
    async function mount({ env, pin, fetchPin } = {}) {
      setEnv(env)
      const ctx = new Context()
      const fiber = await ctx.plugin(WebRuntime, {
        ...(pin === undefined ? {} : { searchProvider: pin }),
        ...(fetchPin === undefined ? {} : { fetchProvider: fetchPin }),
      })
      liveFibers.push(fiber)
      return ctx
    }
    const request = route => ({ query: 'synthetic runtime test', ...(route === undefined ? {} : { llmProvider: route }) })
    const label = async (ctx, route) => (await ctx.web.search(request(route))).sources[0]?.title
    const expectError = (ctx, route, code) => assert.rejects(ctx.web.search(request(route)), error => {
      assert.ok(error instanceof WebError)
      assert.equal(error.code, code)
      return true
    })
    const codexCalls = []
    const codex = {
      id: 'unregistered-codex-live',
      available: () => true,
      async ready(route) { codexCalls.push(['ready', route]); return false },
      async search(input, signal) {
        codexCalls.push(['search', input, signal])
        return { sources: [source('codex'), source('second')], truncated: false }
      },
    }

    try {
      if (version === '0.2.2-rc.1') {
        const ctx = await mount()
        ctx.web.registerSearchProvider(synthetic(OFFICIAL))
        assert.equal(originalSelector.value.length, 0)
        assert.equal(installCodexSearchPreference(ctx.web, codex), undefined)
        assert.equal(Object.hasOwn(ctx.web, SELECTOR), false)
        assert.equal(await label(ctx, CODEX), OFFICIAL)
        assert.equal(await ctx.web.searchReady(CODEX), true)
        ctx.web.registerSearchProvider(synthetic(SEARCH_API))
        await expectError(ctx, CODEX, 'WEB_PROVIDER_AMBIGUOUS')
        assert.deepEqual(codexCalls, [])
        console.log(`dsh-web ${version}: legacy selector safely unchanged (sole + ambiguous preserved)`)
        return
      }

      const { createVolatile, updateVolatile } = await installed('@deepseek-ai/cosmokit')
      const ctx = await mount()
      ctx.web.registerSearchProvider(synthetic(OFFICIAL, { ready: false }))
      ctx.web.registerSearchProvider(synthetic(SEARCH_API))
      const baseline = ctx.web.listProviders()
      const livePreference = createVolatile(true)
      const dispose = installCodexSearchPreference(ctx.web, codex, () => livePreference.get())
      assert.equal(typeof dispose, 'function')
      assert.deepEqual(ctx.web.listProviders(), baseline, 'no change to native provider picker')
      assert.deepEqual(Object.getOwnPropertyDescriptor(WebRuntime.prototype, SELECTOR), originalSelector,
        'wrap just the mounted instance, never the shared prototype')

      for (const route of ['deepseek-account', OFFICIAL]) {
        assert.equal(await label(ctx, route), OFFICIAL)
        assert.equal(await ctx.web.searchReady(route), false)
      }
      for (const route of [OTHER, undefined, 'codex-sub-imposter']) {
        assert.equal(await label(ctx, route), SEARCH_API)
        assert.equal(await ctx.web.searchReady(route), true)
      }
      assert.deepEqual(codexCalls, [], 'no native route reached the Codex adapter')
      assert.equal(await ctx.web.searchReady(CODEX), false)
      const signal = new AbortController().signal
      const input = { ...request(CODEX), maxResults: 1 }
      assert.deepEqual(await ctx.web.search(input, signal), { sources: [source('codex')], truncated: true })
      assert.deepEqual(codexCalls, [['ready', CODEX], ['search', input, signal]], 'native readiness, dispatch, result cap and cancellation seam')

      // Turn the preference off and on in the same mounted instance.
      updateVolatile(livePreference, createVolatile(false))
      assert.equal(await label(ctx, CODEX), SEARCH_API)
      assert.equal(await ctx.web.searchReady(CODEX), true)
      assert.equal(await label(ctx, 'deepseek-account'), OFFICIAL)
      updateVolatile(livePreference, createVolatile(true))
      assert.equal(await label(ctx, CODEX), 'codex')

      // Write only the in-memory Volatile to keep precisely the same Web
      // service and interposition installed while exercising pin transitions.
      const setPin = value => updateVolatile(ctx.web.config.searchProvider, createVolatile(value))
      setPin(OFFICIAL)
      assert.equal(await label(ctx, CODEX), OFFICIAL)
      assert.equal(await ctx.web.searchReady(CODEX), false)
      setPin(SEARCH_API)
      assert.equal(await label(ctx, 'deepseek-account'), SEARCH_API)
      assert.equal(await label(ctx, CODEX), SEARCH_API)
      assert.equal(await ctx.web.searchReady(CODEX), true)
      setPin('missing')
      await expectError(ctx, CODEX, 'WEB_PROVIDER_CONFIGURED_MISSING')
      assert.equal(await ctx.web.searchReady(CODEX), true, 'native readiness surfaces selector errors via search')
      setPin('')
      await expectError(ctx, CODEX, 'WEB_PROVIDER_CONFIGURED_MISSING')
      ctx.web.registerSearchProvider(synthetic('unavailable', { available: false }))
      setPin('unavailable')
      await expectError(ctx, CODEX, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
      setPin(undefined)
      assert.equal(await label(ctx, CODEX), 'codex')
      // A live env change must not behave as a pin on a preexisting instance.
      setEnv(OFFICIAL)
      assert.equal(await label(ctx, CODEX), 'codex')
      dispose()
      dispose()
      assert.equal(Object.hasOwn(ctx.web, SELECTOR), false, 'cleanup exposes the inherited selector again')
      assert.equal(await label(ctx, CODEX), SEARCH_API)

      // Config outranks the env captured by that WebRuntime constructor.
      const pinned = await mount({ env: OFFICIAL })
      pinned.web.registerSearchProvider(synthetic(OFFICIAL))
      pinned.web.registerSearchProvider(synthetic(SEARCH_API))
      const disposePinned = installCodexSearchPreference(pinned.web, codex)
      assert.equal(typeof disposePinned, 'function')
      setEnv(undefined)
      assert.equal(await label(pinned, CODEX), OFFICIAL)
      updateVolatile(pinned.web.config.searchProvider, createVolatile(SEARCH_API))
      assert.equal(await label(pinned, CODEX), SEARCH_API)
      disposePinned()

      const emptyEnv = await mount({ env: '' })
      const disposeEmpty = installCodexSearchPreference(emptyEnv.web, codex)
      assert.equal(typeof disposeEmpty, 'function')
      setEnv(undefined)
      await expectError(emptyEnv, CODEX, 'WEB_PROVIDER_CONFIGURED_MISSING')
      disposeEmpty()

      const sole = await mount()
      const disposeSole = installCodexSearchPreference(sole.web, codex)
      assert.equal(typeof disposeSole, 'function')
      await expectError(sole, OTHER, 'WEB_PROVIDER_UNAVAILABLE')
      sole.web.registerSearchProvider(synthetic('custom'))
      assert.equal(await label(sole, OTHER), 'custom')
      assert.equal(await label(sole, 'deepseek-account'), 'custom')
      sole.web.registerSearchProvider(synthetic('second-custom'))
      await expectError(sole, OTHER, 'WEB_PROVIDER_AMBIGUOUS')
      disposeSole()

      // Mount the shipped direct Search API backend into the real registry.
      // Install a literal synthetic key; don't resolve loader or profile data.
      const { DeepSeekSearchApiProvider } = await installed('@deepseek-ai/dsh-web-deepseek-api')
      const httpCtx = await mount()
      const endpoint = 'https://search-fixture.invalid/v1/tools/search'
      const http = new DeepSeekSearchApiProvider(() => ({
        auth: { sources: [{ kind: 'api-key', baseURL: 'https://search-fixture.invalid/v1/tools', key: 'synthetic-key' }] },
        guidance: { subject: 'Search', plugin: 'web-deepseek-api', custom: true, baseURLField: 'searchBaseURL', apiKeyEnvField: 'searchApiKeyEnv' },
        count: 10,
        requestsPerSecond: 20,
      }))
      httpCtx.web.registerSearchProvider(http)
      const disposeHttp = installCodexSearchPreference(httpCtx.web, codex)
      assert.equal(typeof disposeHttp, 'function')
      let httpCalls = 0
      globalThis.fetch = async (url, options) => {
        assert.equal(url, endpoint)
        assert.equal(options.method, 'POST')
        assert.equal(new Headers(options.headers).get('authorization'), 'Bearer synthetic-key')
        assert.deepEqual(JSON.parse(options.body), { query: 'synthetic runtime test', count: 10, need_content: false })
        httpCalls++
        return Response.json({ results: [{ ...source('native-http'), snippet: '', date: null }] })
      }
      assert.equal(await label(httpCtx, OTHER), 'native-http')
      assert.equal(await label(httpCtx, CODEX), 'codex')
      assert.equal(httpCalls, 1, 'only the native route reached the stubbed HTTP backend')
      disposeHttp()
      globalThis.fetch = async () => assert.fail('Anonymous page fetch must use the shipped HTTP provider')

      const pageCtx = await mount({ fetchPin: 'http' })
      const fetchHttpPlugin = await installed('@deepseek-ai/dsh-web-fetch-http')
      liveFibers.push(await pageCtx.plugin(fetchHttpPlugin, {}))
      let paidFetches = 0
      pageCtx.web.registerFetchProvider({
        id: 'deepseek-fetch-api',
        available: () => true,
        async fetch() { paidFetches++; assert.fail('The pinned HTTP route must not use DeepSeek Fetch API') },
      })
      const disposePage = installCodexSearchPreference(pageCtx.web, codex)
      assert.equal(typeof disposePage, 'function')
      const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = runtimeRequire('undici')
      const previousDispatcher = getGlobalDispatcher()
      const dispatcher = new MockAgent()
      dispatcher.disableNetConnect()
      const pageOrigin = 'https://page-fixture.invalid'
      const pageURL = `${pageOrigin}/article`
      dispatcher.get(pageOrigin).intercept({ path: '/article', method: 'GET' })
        .reply(200, 'anonymous page fixture', { headers: { 'content-type': 'text/plain; charset=utf-8' } })
      setGlobalDispatcher(dispatcher)
      try {
        assert.equal(await label(pageCtx, CODEX), 'codex')
        assert.equal(await pageCtx.web.fetchReady(CODEX), true)
        assert.deepEqual(await pageCtx.web.fetch({ url: pageURL }), {
          url: pageURL, statusCode: 200, body: { kind: 'text', content: 'anonymous page fixture' }, truncated: false,
        })
        dispatcher.assertNoPendingInterceptors()
        assert.equal(paidFetches, 0)
      } finally {
        setGlobalDispatcher(previousDispatcher)
        await dispatcher.close()
        disposePage()
      }

      // The real Cordis service dependency owns the patch: mount late,
      // remove and re-mount the service, then unload the extension first.
      const lifecycleCtx = new Context()
      const effects = []
      const extension = await lifecycleCtx.plugin({
        apply(owner) {
          owner.inject(['web'], scoped => scoped.effect(() => {
            const disposeScoped = installCodexSearchPreference(scoped.web, codex)
            assert.equal(typeof disposeScoped, 'function')
            effects.push('mount')
            return () => { disposeScoped(); effects.push('dispose') }
          }))
        },
      })
      liveFibers.push(extension)
      assert.deepEqual(effects, [])
      const firstWeb = await lifecycleCtx.plugin(WebRuntime, {})
      liveFibers.push(firstWeb)
      assert.deepEqual(effects, ['mount'])
      assert.equal(await label(lifecycleCtx, CODEX), 'codex')
      await firstWeb.dispose()
      assert.deepEqual(effects, ['mount', 'dispose'])
      liveFibers.push(await lifecycleCtx.plugin(WebRuntime, {}))
      assert.deepEqual(effects, ['mount', 'dispose', 'mount'])
      assert.equal(await label(lifecycleCtx, CODEX), 'codex')
      await extension.dispose()
      assert.deepEqual(effects, ['mount', 'dispose', 'mount', 'dispose'])
      assert.equal(Object.hasOwn(lifecycleCtx.web, SELECTOR), false)
      await expectError(lifecycleCtx, CODEX, 'WEB_PROVIDER_UNAVAILABLE')

      console.log(`dsh-web ${version}: native selection/pins/errors, Codex-only Automatic, Cordis lifecycle, and stubbed Search API + anonymous HTTP fetch passed`)
    } finally {
      for (const fiber of liveFibers.reverse()) await fiber.dispose()
    }
  } finally {
    globalThis.fetch = nativeFetch
    setEnv(originalEnv)
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
