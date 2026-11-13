import { UserError } from './accounts.js'
import { validateImageSettings, imageAccountCandidates } from './image-settings.js'

const markdownPath = path => path?.replace(/[%<>\r\n]/g, char => encodeURIComponent(char))
function deliveryOptions(args) {
  const delivery = args.delivery ?? (args.outputPath !== undefined ? 'file' : 'image')
  if (!['image', 'file'].includes(delivery)) throw new UserError('delivery must be image or file')
  if (args.outputPath !== undefined && (typeof args.outputPath !== 'string' || !args.outputPath.trim() || /[\x00-\x1f\x7f]/.test(args.outputPath) || !/\.png$/i.test(args.outputPath))) throw new UserError('outputPath must be a nonempty PNG filename without control characters; SVG/ICO require separate conversion')
  return { delivery, outputPath: args.outputPath }
}

class ImageAccountError extends UserError {}

const BASE = 'https://chatgpt.com/backend-api/codex/images'
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const ATTACHMENT_ID = /^sha256:[a-f0-9]{64}$/
const MAX_IMAGE_BYTES = 32 * 1024 * 1024

// Only session-owned image blocks are eligible; arbitrary content-addressed objects
// elsewhere in the profile cannot be retrieved by guessing their identifiers.
export function sessionImages(messages) {
  const images = new Map()
  const visit = blocks => {
    for (const block of blocks ?? []) {
      if (block.type === 'image' && ATTACHMENT_ID.test(block.attachment?.attachmentId)) images.set(block.attachment.attachmentId, block.attachment)
      else if (block.type === 'tool-result') visit(block.content)
    }
  }
  for (const message of messages) visit(message.content)
  return images
}
// Pair this tool's normalized previews with their verbatim PNG originals using
// logged call IDs, so editing a previous result never edits a resized preview.
export function sessionOriginals(messages) {
  const calls = new Set(), originals = new Map()
  for (const message of messages) {
    for (const block of message.content ?? []) if (block.type === 'tool-call' && block.name === 'codex_image_generate') calls.add(block.id)
    if (message.role !== 'tool' || !calls.has(message.source?.callId)) continue
    const image = message.content.find(block => block.type === 'image')?.attachment
    const file = message.content.find(block => block.type === 'file')?.attachment
    if (image && file) originals.set(image.attachmentId, file)
  }
  return originals
}
async function readOriginal(service, ref, limit, signal) {
  if (ref.bytes > limit) throw new UserError('Original image exceeds the message image size limit')
  const chunks = []
  let bytes = 0
  for await (const chunk of service.readFileStream(ref, signal)) {
    signal.throwIfAborted()
    bytes += chunk.byteLength
    if (bytes > limit) throw new UserError('Original image exceeds the message image size limit')
    chunks.push(Buffer.from(chunk))
  }
  const data = Buffer.concat(chunks, bytes)
  if (bytes !== ref.bytes || !data.subarray(0, 8).equals(PNG)) throw new UserError('Original PNG verification failed')
  return data
}
async function readResponse(response, limit) {
  if (!response.body) throw new UserError('Image service returned an empty response')
  const declared = Number(response.headers.get('content-length'))
  if (declared > limit) { await response.body.cancel(); throw new UserError('Image response exceeds the size limit') }
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) { await reader.cancel(); throw new UserError('Image response exceeds the size limit') }
      chunks.push(Buffer.from(value))
    }
    try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) }
    catch { throw new UserError('Image service returned invalid JSON') }
  } finally { reader.releaseLock() }
}
export function decodePng(value, limit) {
  if (typeof value !== 'string' || !value.length || value.length % 4 !== 0
    || value.length > Math.ceil(limit / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new UserError('Image service returned invalid or oversized PNG data')
  const data = Buffer.from(value, 'base64')
  if (data.length > limit || data.toString('base64') !== value || !data.subarray(0, 8).equals(PNG)) throw new UserError('Image service returned invalid or oversized PNG data')
  return data
}
const imageSchema = { type: 'object', properties: {
  attachmentId: { type: 'string' }, mediaType: { type: 'string' }, bytes: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' }, name: { type: 'string' },
  originalDimensions: { type: 'object', properties: { width: { type: 'integer' }, height: { type: 'integer' } }, required: ['width', 'height'], additionalProperties: false },
}, required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'], additionalProperties: false }

export function createImageTool({ getSettings, accounts, getCredential, getSession, attachments, fetchImage = fetch, accountMemory, prepareExport, attemptTimeoutMs = 5 * 60 * 1000 }) {
  let preferredAccount = accountMemory?.preferred() ?? ''
  return {
    name: 'codex_image_generate',
    description: 'Generate or edit images using a Codex subscription. For a directly requested picture, display the returned Markdown image in your final reply. For project assets/icons, use outputPath and delivery=file and provide the saved file link instead of a large image unless requested. Returns editing attachments and the original PNG in either mode. Existing output files are never overwritten. If saving fails, recover the attached original without regenerating. Uses Settings → Codex subscriptions for model, quality and account independently of the conversation model. Only use for requested image output; never replace an edit with text-only generation.',
    parameters: { type: 'object', properties: {
      prompt: { type: 'string', description: 'Complete description of the new image or the changes to make while preserving the source.' },
      delivery: { type: 'string', enum: ['image', 'file'], description: 'image: show the picture in the final reply; file: provide a file link, with no large image unless requested. Defaults to file when outputPath is set, otherwise image.' },
      outputPath: { type: 'string', description: 'Optional PNG destination in the session filesystem, relative to the current session working directory or absolute. Parent directories are created; existing paths are never overwritten. PNG only; exact resizing or SVG/ICO conversion is separate.' },
      referenceImages: { type: 'array', description: 'For edits, 1–5 image attachment IDs (sha256:…) copied from this conversation or read_image results. Read local files with read_image first. Omit only for text-to-image; do not drop invalid references.', items: { type: 'string' } },
    }, required: ['prompt'], additionalProperties: false },
    output: {
      schema: { type: 'object', properties: {
        image: imageSchema,
        original: { type: 'object', properties: { attachmentId: { type: 'string' }, name: { type: 'string' }, bytes: { type: 'integer' } }, required: ['attachmentId', 'name', 'bytes'], additionalProperties: false },
        delivery: { type: 'string', enum: ['image', 'file'] }, savedPath: { type: 'string' }, saveError: { type: 'string' },
        localPath: { type: 'string' }, accountId: { type: 'string' }, model: { type: 'string' }, quality: { type: 'string' }, warning: { type: 'string' },
      }, required: ['original', 'accountId', 'model', 'quality'], additionalProperties: false },
      render: (_args, value) => {
        // Keep native blocks for vision/editing; presentation belongs to the
        // final reply, not an automatically expanded tool gallery.
        const target = markdownPath(value.savedPath ?? value.localPath)
        const fileMode = value.delivery === 'file'
        const instructions = target
          ? fileMode ? `\nProvide this file link in your final reply; do not display a large image unless requested:\n[${value.savedPath ? 'Saved PNG' : 'Original PNG'}](<${target}>)`
            : `\nDisplay this image in your final reply:\n![Generated image](<${target}>)`
          : '\nNo Host file path is available. Do not invent an image URL; deliver the attached PNG.'
        return [
          { type: 'text', text: `Image generated using ${value.model} (${value.quality}). Original PNG: ${JSON.stringify(value.original)}${value.localPath ? `\nHost file: ${JSON.stringify(value.localPath)}` : ''}${value.savedPath ? `\nSaved file: ${JSON.stringify(value.savedPath)}` : ''}${instructions}${value.saveError ? `\nWarning: Image generated, but saving failed: ${value.saveError}. The original attachment is retained; do not regenerate. Recover/save the existing PNG only, respecting any sandbox denial.` : ''}${value.warning ? `\nWarning: ${value.warning}` : ''}` },
          ...(value.image ? [{ type: 'image', attachment: value.image }] : []),
          { type: 'file', attachment: value.original },
        ]
      },
    },
    timeoutMs: 30 * 60 * 1000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const settings = validateImageSettings(getSettings())
      if (!settings.enabled) throw new UserError('Image generation is disabled in Settings → Codex subscriptions')
      if (typeof args?.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 32000) throw new UserError('Provide a nonempty prompt up to 32000 characters')
      if (!exec.agent?.id) throw new UserError('Image generation requires a session-owned call')
      const session = getSession(exec.agent.id)
      if (!session) throw new UserError('Session is no longer available')
      const { delivery, outputPath } = deliveryOptions(args)
      let exportImage
      if (outputPath !== undefined) {
        if (!prepareExport) throw new UserError('Saving images to a path is unavailable in this environment')
        // Refuse invalid/unavailable/existing destinations before a paid request.
        exportImage = await prepareExport(outputPath, exec)
      }
      const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(30 * 60 * 1000)])
      signal.throwIfAborted()
      const service = attachments()
      if (!service || !service.imageLimits.mediaTypes.includes('image/png')) throw new UserError('PNG attachment storage is unavailable')
      const limit = Math.min(MAX_IMAGE_BYTES, service.imageLimits.maxImageBytes, service.imageLimits.maxMessageImageBytes)
      const editing = args.referenceImages !== undefined
      let images
      if (editing) {
        const refs = args.referenceImages
        if (!Array.isArray(refs) || refs.length < 1 || refs.length > 5 || new Set(refs).size !== refs.length || refs.some(id => typeof id !== 'string' || !ATTACHMENT_ID.test(id))) throw new UserError('Edits require 1–5 distinct sha256 image attachment IDs; use read_image for local files and keep the references')
        const messages = session.deriveMessages()
        const available = sessionImages(messages)
        const originals = sessionOriginals(messages)
        images = []
        let total = 0
        for (const id of refs) {
          const ref = available.get(id)
          if (!ref) throw new UserError('Image is not in this session; read the intended local file with read_image and retry without dropping the reference')
          const original = originals.get(id)
          total += original?.bytes ?? ref.bytes
          if (total > service.imageLimits.maxMessageImageBytes) throw new UserError('Reference images exceed the message image size limit')
          if (original) {
            const data = await readOriginal(service, original, Math.min(MAX_IMAGE_BYTES, service.imageLimits.maxMessageImageBytes), signal)
            images.push({ image_url: `data:image/png;base64,${data.toString('base64')}` })
          } else {
            const stored = await service.readImage(ref, signal)
            images.push({ image_url: `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}` })
          }
        }
      }
      const candidates = await imageAccountCandidates(accounts, settings, accountMemory?.preferred() ?? preferredAccount)
      const failures = []
      let unknownOutcome = false
      const checkActive = () => {
        signal.throwIfAborted()
        if (!getSettings().enabled) throw new UserError('Image generation was disabled before dispatch')
      }
      const body = JSON.stringify({ prompt: args.prompt.trim(), model: settings.model, quality: settings.quality, size: 'auto', background: 'auto', ...(images ? { images } : {}) })
      for (const accountId of candidates) {
        checkActive()
        const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(attemptTimeoutMs)])
        let data
        try {
          let credential
          try { credential = await getCredential(accountId, attemptSignal) }
          catch { throw new ImageAccountError('Account authentication failed; sign in again with this account.') }
          if (!credential?.access || !credential?.accountId) throw new ImageAccountError('Account is not signed in.')
          checkActive()
          attemptSignal.throwIfAborted()
          let response
          try {
            response = await fetchImage(`${BASE}/${editing ? 'edits' : 'generations'}`, {
              method: 'POST', redirect: 'error', signal: attemptSignal,
              headers: { authorization: `Bearer ${credential.access}`, 'chatgpt-account-id': credential.accountId,
                accept: 'application/json', 'content-type': 'application/json', originator: 'pi',
                'x-codex-image-turn-id': String(exec.callId), 'user-agent': 'dsh-codex-subscribe/0.3.1' },
              body,
            })
          } catch { throw new ImageAccountError('Image network request failed; outcome may be unknown.') }
          if (!response.ok) {
            await response.body?.cancel().catch(() => {})
            const hints = { 401: 'Sign in again with this account.', 403: 'Account, plan, workspace or region may not allow images.', 429: 'Image quota or rate limit reached.' }
            throw new ImageAccountError(`HTTP ${response.status}. ${hints[response.status] ?? 'Image service request failed.'}`)
          }
          try {
            const value = await readResponse(response, Math.ceil(limit / 3) * 4 + 1024 * 1024)
            if (!Array.isArray(value?.data) || value.data.length !== 1) throw new Error('Unexpected image count')
            data = decodePng(value.data[0]?.b64_json, limit)
            await service.validateImage({ data, mediaType: 'image/png', name: 'codex-generated.png' })
          } catch { throw new ImageAccountError('Image service returned an invalid, unreadable or oversized image.') }
          attemptSignal.throwIfAborted()
        } catch (error) {
          // Cancellation, global timeout, disable and unload must never start another attempt.
          checkActive()
          const reason = attemptSignal.aborted ? 'Image account request timed out; outcome may be unknown.'
            : error instanceof ImageAccountError ? error.message : 'Image account request failed.'
          if (reason.includes('outcome may be unknown')) unknownOutcome = true
          failures.push({ accountId, reason })
          continue
        }
        checkActive()
        // Local persistence is outside the retry boundary: a successfully generated
        // image must not be generated/charged again because the local disk failed.
        const input = { data, mediaType: 'image/png', name: 'codex-generated.png' }
        const original = await service.saveFile({ data, name: input.name })
        // Once the original exists, downstream failures/cancellation must not
        // turn a paid success into an opaque error that invites regeneration.
        let image, localPath, savedPath, saveError
        const warnings = unknownOutcome ? ['An earlier account request had an unknown outcome; account fallback may have generated additional images or consumed extra quota.'] : []
        const canContinue = () => !signal.aborted && getSettings().enabled
        try { localPath = service.fileHostPath(original) }
        catch { warnings.push('The original PNG is attached, but its Host file path is unavailable. Do not regenerate.') }
        if (canContinue()) {
          try { image = await service.saveImage(input) }
          catch { warnings.push('Preview storage failed; the original PNG is still attached. Do not regenerate.') }
        }
        if (canContinue() && !settings.accountId) {
          preferredAccount = accountId
          try { await accountMemory?.remember(accountId) }
          catch { warnings.push('Image generated successfully, but the preferred account could not be saved for future restarts.') }
        }
        if (exportImage && canContinue()) {
          try { savedPath = await exportImage(data, signal) }
          catch (error) { saveError = error instanceof UserError ? error.message : 'Local export failed; the generated original is still attached' }
        } else if (exportImage) {
          saveError = 'Export was cancelled or image generation was disabled after the original was saved'
        }
        if (!canContinue()) warnings.push('Cancelled or disabled after generation; the original PNG is retained, and no further optional writes were started. Do not regenerate.')
        const warning = warnings.join(' ')
        return { ...(image ? { image } : {}), original, delivery, ...(savedPath ? { savedPath } : {}), ...(saveError ? { saveError } : {}), ...(localPath ? { localPath } : {}), accountId, model: settings.model, quality: settings.quality, ...(warning ? { warning } : {}) }
      }
      const summary = failures.slice(0, 8).map(item => `${item.accountId}: ${item.reason}`).join('; ')
      throw new UserError(`${settings.accountId ? 'Fixed image account failed' : `All ${failures.length} image accounts failed`}. ${summary}${failures.length > 8 ? `; ${failures.length - 8} further failures omitted` : ''}`)
    },
  }
}
