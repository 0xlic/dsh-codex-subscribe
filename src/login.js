import { randomUUID } from 'node:crypto'
import { UserError, NATIVE_PROVIDER, validateId, validateLabel } from './accounts.js'

export function authUrl(value) {
  let url
  try { url = new URL(value) } catch { throw new UserError('Unsupported sign-in URL') }
  if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname) || url.username || url.password || url.port) throw new UserError('Unsupported sign-in URL')
  return url.href
}
const terminal = phase => ['authenticated', 'failed', 'cancelled'].includes(phase)
export class Login {
  constructor({ createModels, providerFactory, accounts, changed }) {
    Object.assign(this, { createModels, providerFactory, accounts, changed })
  }
  start(input) {
    if (!['browser', 'device_code'].includes(input.method)) throw new UserError('Unsupported sign-in method')
    const label = input.renewId || input.label === undefined ? undefined : validateLabel(input.label)
    const renewId = input.renewId ? validateId(input.renewId) : undefined
    if (this.session && !terminal(this.session.view.phase)) throw new UserError('A sign-in is already running; cancel it first')
    const controller = new AbortController()
    const session = { controller, view: { id: randomUUID(), phase: 'starting' } }
    this.session = session
    let credential
    const pending = {
      read: async () => credential,
      list: async () => credential ? [{ providerId: NATIVE_PROVIDER, type: 'oauth' }] : [],
      modify: async (_provider, fn) => { credential = await fn(credential) ?? credential; return credential },
      delete: async () => { credential = undefined },
    }
    const publish = patch => {
      if (!controller.signal.aborted) session.view = { ...session.view, ...patch }
    }
    const interaction = {
      signal: controller.signal,
      notify: event => {
        if (controller.signal.aborted) return
        if (event.type === 'auth_url') publish({ phase: 'waiting_browser', authUrl: authUrl(event.url) })
        if (event.type === 'device_code') publish({ phase: 'waiting_device', authUrl: authUrl(event.verificationUri), userCode: String(event.userCode) })
      },
      prompt: async prompt => {
        controller.signal.throwIfAborted()
        if (prompt.type === 'select') return input.method
        if (!['manual_code', 'text', 'secret'].includes(prompt.type)) throw new UserError('Unsupported sign-in prompt')
        publish({ phase: 'waiting_input', prompt: { type: prompt.type, message: prompt.message } })
        return new Promise((resolve, reject) => {
          const cleanup = () => {
            controller.signal.removeEventListener('abort', abort)
            prompt.signal?.removeEventListener('abort', abort)
            if (session.answer === answer) session.answer = undefined
          }
          const abort = () => { cleanup(); reject(new Error('Sign-in cancelled')) }
          const answer = value => { cleanup(); resolve(value) }
          session.answer = answer
          controller.signal.addEventListener('abort', abort, { once: true })
          prompt.signal?.addEventListener('abort', abort, { once: true })
          if (prompt.signal?.aborted || controller.signal.aborted) abort()
        })
      },
    }
    // Credential data never enters a view, error response, log, tool, or Config.
    session.run = Promise.resolve().then(async () => {
      controller.signal.throwIfAborted()
      const models = this.createModels({ credentials: pending, authContext: { env: async () => undefined, fileExists: async () => false } })
      models.setProvider(this.providerFactory())
      if (renewId) await this.accounts.read(renewId)
      controller.signal.throwIfAborted()
      await models.login(NATIVE_PROVIDER, 'oauth', interaction)
      controller.signal.throwIfAborted()
      // Cancellation is accepted until commit begins. Afterwards report the
      // durable result instead of displaying "cancelled" for a saved account.
      session.committing = true
      publish({ phase: 'finalizing', prompt: undefined, authUrl: undefined, userCode: undefined })
      const id = renewId ?? await this.accounts.add(label, credential, controller.signal)
      if (renewId) await this.accounts.renew(id, credential, controller.signal)
      await this.changed({ id, renewed: !!renewId })
      publish({ phase: 'authenticated', providerId: id, prompt: undefined, authUrl: undefined, userCode: undefined })
    }).catch(error => {
      if (controller.signal.aborted) return
      publish({ phase: 'failed', prompt: undefined, authUrl: undefined, userCode: undefined,
        error: error instanceof UserError ? error.message : 'Sign-in failed. Check network access and try again.' })
    }).finally(() => { credential = undefined })
    return this.read(session.view.id)
  }
  read(id) {
    if (!this.session || this.session.view.id !== id) throw new UserError('Sign-in attempt no longer exists')
    return structuredClone(this.session.view)
  }
  submit(id, value) {
    this.read(id)
    if (!this.session.answer || typeof value !== 'string' || !value.trim() || value.length > 8192) throw new UserError('Sign-in is not waiting for valid input')
    const answer = this.session.answer
    this.session.view = { ...this.session.view, phase: 'starting', prompt: undefined }
    answer(value.trim())
    return this.read(id)
  }
  cancel(id) {
    this.read(id)
    if (!this.session.committing && !terminal(this.session.view.phase)) {
      this.session.view = { id, phase: 'cancelled' }
      this.session.controller.abort()
    }
    return this.read(id)
  }
  dispose() {
    if (this.session) this.cancel(this.session.view.id)
  }
}
