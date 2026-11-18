import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const { z } = createRequire(import.meta.resolve('@deepseek-ai/dsh-llm'))('zod')
const MAX_RAW_BYTES = 4 * 1024 * 1024
const MAX_ACCOUNTS = 64
const KEY = /^[a-f0-9]{64}$/

// Do not silently JSON-coerce Dates, undefined, NaN, accessors or cyclic data.
// A depth bound also makes malformed cache/input validation stack-safe.
function isJson(value, ancestors = new Set(), depth = 0) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || depth > 100 || ancestors.has(value)) return false
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false
  if (Object.getOwnPropertySymbols(value).length) return false
  ancestors.add(value)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Object.keys(descriptors).filter(key => !(Array.isArray(value) && key === 'length'))
  const valid = (!Array.isArray(value) || (keys.length === value.length && keys.every((key, index) => key === String(index)))) && keys.every(key => {
    const descriptor = descriptors[key]
    return descriptor.enumerable && 'value' in descriptor && isJson(descriptor.value, ancestors, depth + 1)
  })
  ancestors.delete(value)
  return valid
}

const rawSchema = z.custom(value => value !== null && typeof value === 'object' && !Array.isArray(value) && isJson(value)
  && Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_RAW_BYTES, 'Expected a JSON object of at most 4 MiB')
const entrySchema = z.object({
  savedAt: z.number().finite().nonnegative(),
  etag: z.string().max(8192).optional(),
  rawCatalog: rawSchema,
}).strict()

export const MODEL_CATALOG_DOMAIN = {
  name: 'codex_subscribe_model_catalog', version: 1, tables: {},
  global: {
    schema: z.object({ entries: z.record(z.string().regex(KEY), entrySchema).refine(entries => Object.keys(entries).length <= MAX_ACCOUNTS, 'Too many model catalogs') }).strict(),
    initial: { entries: {} },
  },
}

function accountKey(accountId) {
  if (typeof accountId !== 'string' || !accountId.trim()) throw new TypeError('A current OAuth account ID is required')
  return createHash('sha256').update(accountId, 'utf8').digest('hex')
}

// Real DSH rejects an invalid global at open. Also defend against malformed
// values from alternative domain implementations without trusting them as auth.
function cleanEntries(value) {
  const entries = Object.create(null)
  if (!value || typeof value !== 'object' || !value.entries || typeof value.entries !== 'object') return entries
  for (const [key, entry] of Object.entries(value.entries)) {
    if (!KEY.test(key)) continue
    const parsed = entrySchema.safeParse(entry)
    if (parsed.success) entries[key] = structuredClone(parsed.data)
  }
  return entries
}

function capEntries(entries) {
  const keys = Object.keys(entries).sort((a, b) => entries[b].savedAt - entries[a].savedAt || a.localeCompare(b))
  for (const key of keys.slice(MAX_ACCOUNTS)) delete entries[key]
}

/**
 * Profile-owned cache only: no credentials, TTL, catalog semantics or auth checks.
 * One owner per DSH domain; read is synchronous and does not wait for pending writes.
 * Invalid persisted globals may make DSH open reject. Unknown-state storage failures
 * remain quarantined by DSH, rather than being treated as a successful cache write.
 */
export async function openModelCatalogStore(storageDomain) {
  const domain = await storageDomain.open(MODEL_CATALOG_DOMAIN)
  let tail = Promise.resolve(), closed = false, closing
  function assertOpen() {
    if (closed) throw new Error('Model catalog store is closed')
  }
  function enqueue(change) {
    if (closed) return Promise.reject(new Error('Model catalog store is closed'))
    const next = tail.then(async () => {
      const entries = cleanEntries(domain.global.get())
      change(entries)
      capEntries(entries)
      await domain.global.set({ entries })
    })
    tail = next.catch(() => {})
    return next
  }
  return {
    read(accountId) {
      assertOpen()
      const key = accountKey(accountId)
      const value = domain.global.get()?.entries?.[key]
      const parsed = entrySchema.safeParse(value)
      return parsed.success ? structuredClone(parsed.data) : undefined
    },
    async write(accountId, entry) {
      assertOpen()
      const key = accountKey(accountId)
      // Clone before enqueue: callers cannot mutate a queued write's payload.
      const snapshot = structuredClone(entrySchema.parse(entry))
      return enqueue(entries => { entries[key] = snapshot })
    },
    async remove(accountId) {
      assertOpen()
      const key = accountKey(accountId)
      return enqueue(entries => { delete entries[key] })
    },
    async retain(accountIds) {
      assertOpen()
      if (!Array.isArray(accountIds)) throw new TypeError('Expected an array of OAuth account IDs')
      // Validate the entire input before scheduling any destructive update.
      const keep = new Set(accountIds.map(accountKey))
      return enqueue(entries => {
        for (const key of Object.keys(entries)) if (!keep.has(key)) delete entries[key]
      })
    },
    close() {
      if (!closing) {
        closed = true
        closing = tail.then(() => domain.close())
      }
      return closing
    },
  }
}
