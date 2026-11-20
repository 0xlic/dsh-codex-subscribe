// Keep the Harness-selected route stable while dispatching a compatible
// physical account. Never store a fallback replay envelope under that route.
export async function prepareChatAccount(entry, options, primary) {
  const signal = options.signal
  const prepared = await entry.adapter.prepareSingle(entry.provider, options.model, signal)
  signal?.throwIfAborted()
  if (!compatibleChatModel(primary.model, prepared.model, options.reasoningEffort)) return undefined
  return async function* (requestSignal = options.signal) {
    requestSignal?.throwIfAborted()
    const messages = options.messages.map(message => {
      if (message.role !== 'assistant') return message
      const { replayState: _private, ...source } = message.source
      return { ...message, source }
    })
    for await (const chunk of prepared.stream({ ...options, signal: requestSignal, provider: entry.provider, messages })) {
      if (chunk.type === 'finish') {
        const { replayState: _private, ...publicChunk } = chunk
        yield publicChunk
      } else yield chunk
    }
  }
}

export function compatibleChatModel(original, candidate, effort) {
  if (original.id !== candidate.id) return false
  if (effort !== undefined && !candidate.reasoning?.efforts.some(option => option.id === effort)) return false
  if (effort === undefined && original.reasoning?.defaultEffort !== candidate.reasoning?.defaultEffort) return false
  if ((candidate.context?.contextWindow ?? 0) < (original.context?.contextWindow ?? 0)) return false
  if (original.systemPromptUpdate !== candidate.systemPromptUpdate || original.toolUpdate !== candidate.toolUpdate) return false
  return (original.inputModalities ?? []).every(modality => candidate.inputModalities?.includes(modality))
}
