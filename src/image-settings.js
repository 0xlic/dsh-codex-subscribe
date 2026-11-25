import { createRequire } from 'node:module'
import { UserError, validateId } from './accounts.js'

// Resolve the schema library from the runtime peer, not a second bundled copy.
const z = createRequire(import.meta.resolve('@deepseek-ai/dsh-llm'))('@deepseek-ai/schemastery')
export const IMAGE_MODELS = Object.freeze({
  'gpt-image-2': Object.freeze(['auto', 'low', 'medium', 'high']),
  'gpt-image-2.5-flare': Object.freeze(['auto', 'low', 'medium', 'high', 'xhigh', 'max']),
  'gpt-image-2.5-sunburst': Object.freeze(['auto', 'low', 'medium', 'high', 'xhigh', 'max']),
})
export const IMAGE_DEFAULTS = Object.freeze({ enabled: false, model: 'gpt-image-2', quality: 'auto', accountId: '' })
export const Config = z.object({
  chatFailover: z.boolean().default(false),
  codexLiveSearch: z.boolean().default(true).volatile(),
  images: z.object({
    enabled: z.boolean().default(false),
    model: z.union(Object.keys(IMAGE_MODELS)).default(IMAGE_DEFAULTS.model),
    quality: z.union(['auto', 'low', 'medium', 'high', 'xhigh', 'max']).default('auto'),
    accountId: z.string().default(''),
  }).default(IMAGE_DEFAULTS),
})
export function validateImageSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !Object.hasOwn(IMAGE_DEFAULTS, key))
    || typeof value.enabled !== 'boolean' || !Object.hasOwn(IMAGE_MODELS, value.model)
    || !IMAGE_MODELS[value.model].includes(value.quality) || typeof value.accountId !== 'string') {
    throw new UserError('Invalid image settings or unsupported model/quality combination')
  }
  if (value.accountId) validateId(value.accountId)
  return { enabled: value.enabled, model: value.model, quality: value.quality, accountId: value.accountId }
}
export async function imageAccountCandidates(accounts, settings, preferredId) {
  const ids = [...new Set((await accounts.list()).map(account => account.id))]
  if (settings.accountId) {
    if (!ids.includes(settings.accountId)) throw new UserError('The configured image account was removed; select an account in Settings → Codex subscriptions')
    return [settings.accountId]
  }
  if (!ids.length) throw new UserError('Sign in in Settings → Codex subscriptions before generating images')
  // Account routing is deliberately independent of the conversation provider.
  return ids.includes(preferredId) ? [preferredId, ...ids.filter(id => id !== preferredId)] : ids
}
export function imageSettingsOperations(ctx, settings, accounts) {
  return {
    get: () => ({ ...settings }),
    async save(value) {
      const next = validateImageSettings(value)
      if (next.enabled && next.accountId && !(await accounts.list()).some(account => account.id === next.accountId)) throw new UserError('Subscription no longer exists')
      const editor = ctx.get?.('configEditor')
      const entry = ctx.fiber?.entry
      if (!editor || !entry) throw new UserError('Image settings cannot be saved in this profile')
      try { await editor.edit(entry, current => ({ ...current, images: next })) }
      catch (error) {
        // A config write also activates the plugin. Activation errors are not
        // evidence of a filesystem permission problem; retain the cause for diagnostics.
        ctx.logger?.warn('Image settings update failed', error)
        throw new UserError('Image settings could not be saved or applied; plugin activation or profile configuration failed', { cause: error })
      }
      // Ordinary Config changes are reconciled by Loader, which owns tool teardown/re-registration.
      return next
    },
  }
}
