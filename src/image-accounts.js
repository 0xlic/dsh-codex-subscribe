import { createRequire } from 'node:module'
import { validateId } from './accounts.js'

const { z } = createRequire(import.meta.resolve('@deepseek-ai/dsh-llm'))('zod')
export const IMAGE_ACCOUNT_DOMAIN = {
  // DSH storage unit names permit lowercase letters, digits and underscores only.
  name: 'codex_subscribe_image_accounts', version: 1, tables: {},
  global: {
    schema: z.object({ lastSuccessfulAccountId: z.string().regex(/^(?:account-[a-f0-9]{32})?$/) }),
    initial: { lastSuccessfulAccountId: '' },
  },
}

/** Profile-owned routing memory, separate from user Config and OAuth records. */
export async function openImageAccountMemory(storageDomain) {
  const domain = await storageDomain.open(IMAGE_ACCOUNT_DOMAIN)
  let preferred = domain.global.get().lastSuccessfulAccountId
  let tail = Promise.resolve(), closed = false
  return {
    preferred: () => preferred,
    remember(id) {
      validateId(id)
      if (closed) return Promise.reject(new Error('Image account memory is closed'))
      // Retain a working process-local preference even if persistence fails.
      preferred = id
      const next = tail.catch(() => {}).then(() => domain.global.set({ lastSuccessfulAccountId: id }))
      tail = next
      return next
    },
    async close() {
      if (closed) return
      closed = true
      await tail.catch(() => {})
      await domain.close()
    },
  }
}
