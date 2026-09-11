// dsh-opencode-go-header (local fork)
//
// Host plugin: automatically attach an `x-opencode-session` header to model
// requests that are routed to an OpenCode / OpenCode Go provider route.
//
// OpenCode's relay pins every request that shares the same
// `x-opencode-session` value to the same upstream backend, which keeps its
// prompt cache warm across the turns of one conversation. The value only has
// to be opaque and stable per conversation, so by default we reuse the DSH
// session id that already travels with each model call (the same identity the
// official DeepSeek adapter sends as `x-deepseek-harness-session-id`).
//
// How it works:
//   1. Listen on the `llm/stream` waterfall. Calls whose `options.provider`
//      names a configured OpenCode route and which carry a `sessionId` are
//      driven through an AsyncLocalStorage store holding the header value.
//   2. `globalThis.fetch` is patched once. While a store is active the patch
//      FORCE-SETS `x-opencode-session: <value>` on the outgoing request,
//      overriding any value already present (including static provider
//      config headers) so the per-session identity always wins.
//   3. When no store is active (auxiliary / implicit calls that carry no
//      session id, e.g. memory-plugin summaries), the patch fills the
//      configured `fallback` value on requests that target the OpenCode
//      gateway (opencode.ai and its subdomains), unless the request already
//      carries the header.
//   4. Both registrations are fiber-scoped ctx effects, so plugin stop /
//      update / unload restores the original fetch and removes the listener.
//
// Requests that are neither routed to an OpenCode provider nor aimed at the
// OpenCode gateway pass through untouched.

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { appendFile } from 'node:fs/promises'

export const name = 'opencode-go-session-header'

// Activate only after the abstract `llm` service exists, so the waterfall
// event we listen on is already registered by its provider.
export const inject = ['llm']

const SESSION_HEADER = 'x-opencode-session'

// Provider routes OpenCode(Go) requests are served under. A route naming an
// installed pi-ai catalog provider keeps that provider's id as its route key,
// so both catalog ids are covered; users who route OpenCode through a custom
// provider key add it through config.
const DEFAULT_PROVIDERS = ['opencode', 'opencode-go']

function resolveConfig(config = {}) {
  const providers = Array.isArray(config.providers) && config.providers.length > 0
    ? config.providers.map((value) => String(value))
    : [...DEFAULT_PROVIDERS]
  // session-id: reuse the DSH session id (stable across turns AND restarts,
  // unique per conversation). uuid: derive a process-stable random uuid per
  // DSH session id (opaque, but resets when the process restarts).
  const mode = config.mode === 'uuid' ? 'uuid' : 'session-id'
  // Stable opaque value injected on session-less (auxiliary) requests aimed
  // at the OpenCode gateway. Unset keeps the original pass-through behavior.
  const fallback = typeof config.fallback === 'string' && config.fallback.length > 0
    ? config.fallback
    : undefined
  const debug = config.debug === true
  const debugFile = typeof config.debugFile === 'string' && config.debugFile.length > 0
    ? config.debugFile
    : undefined
  return { providers: new Set(providers), mode, fallback, debug, debugFile }
}

/** Fire-and-forget append of one debug record; failures only log a warning. */
function recordDebug(ctx, file, entry) {
  appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8').catch((error) => {
    ctx.logger.warn('[opencode-go-session-header] debugFile write failed: %s', error?.message ?? String(error))
  })
}

/** Derive the opaque header value for one DSH session id. */
export function headerValueFor(sessionId, mode, table) {
  const raw = String(sessionId)
  if (raw.length === 0) return undefined
  if (mode !== 'uuid') return raw
  let value = table.get(raw)
  if (value === undefined) {
    value = randomUUID()
    table.set(raw, value)
  }
  return value
}

/**
 * Wrap a downstream async iterable so every pull executes inside an
 * AsyncLocalStorage store. Async generators and the promises they create
 * inherit the store as long as the generator body is driven from a pull made
 * inside `als.run`, which is exactly what this wrapper does per `next()`.
 */
export function withStore(iterable, store, als) {
  const iterator = typeof iterable[Symbol.asyncIterator] === 'function'
    ? iterable[Symbol.asyncIterator]()
    : iterable
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    async next() {
      return als.run(store, () => iterator.next())
    },
    async return(value) {
      if (typeof iterator.return === 'function') {
        try {
          return await iterator.return(value)
        } catch {
          // The downstream stream may already be torn down; treat as done.
        }
      }
      return { done: true, value }
    },
    async throw(error) {
      if (typeof iterator.throw === 'function') {
        return als.run(store, () => iterator.throw(error))
      }
      throw error
    },
  }
}

/** True when the request targets the OpenCode gateway (opencode.ai and subdomains). */
export function isOpenCodeEndpoint(input) {
  try {
    const source = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : typeof Request !== 'undefined' && input instanceof Request
          ? input.url
          : typeof input?.url === 'string' ? input.url : ''
    if (source.length === 0) return false
    const host = new URL(source).hostname.toLowerCase()
    return host === 'opencode.ai' || host.endsWith('.opencode.ai')
  } catch {
    return false
  }
}

/**
 * Build a patched fetch that force-injects the header while a store is
 * active, and fills the fallback value on OpenCode gateway requests outside
 * a store. Header precedence mirrors native fetch: when `init.headers` is
 * present it wins; otherwise a Request's own headers are the base.
 */
export function patchFetch(original, als, fallbackValue) {
  return function patchedFetch(input, init) {
    const state = als.getStore()
    if (state) {
      // Force override: the per-session value wins over anything already
      // present, including static headers merged in by the provider config.
      const headers = new Headers(
        init?.headers
          ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined),
      )
      headers.set(SESSION_HEADER, state.value)
      return original.call(this, input, { ...init, headers })
    }
    if (fallbackValue !== undefined && isOpenCodeEndpoint(input)) {
      const headers = new Headers(
        init?.headers
          ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined),
      )
      if (!headers.has(SESSION_HEADER)) {
        headers.set(SESSION_HEADER, fallbackValue)
        return original.call(this, input, { ...init, headers })
      }
    }
    return original.apply(this, arguments)
  }
}

export function apply(ctx, config) {
  const { providers, mode, fallback, debug, debugFile } = resolveConfig(config)
  const als = new AsyncLocalStorage()
  const uuidBySession = new Map()

  const originalFetch = globalThis.fetch
  if (typeof originalFetch !== 'function') {
    ctx.logger.warn('[opencode-go-session-header] globalThis.fetch is unavailable; cannot inject x-opencode-session')
    return
  }

  const patched = patchFetch(originalFetch, als, fallback)

  ctx.effect(() => {
    globalThis.fetch = patched
    ctx.logger.info(
      '[opencode-go-session-header] active for providers [%s] with mode %s%s',
      [...providers].join(', '),
      mode,
      fallback === undefined ? '' : `, fallback ${fallback}`,
    )
    return () => {
      if (globalThis.fetch === patched) globalThis.fetch = originalFetch
    }
  }, 'opencode-go-session-header.fetch-patch')

  ctx.on('llm/stream', (options, next) => {
    if (options === undefined || options === null || typeof options !== 'object') return next()
    if (!providers.has(String(options.provider))) return next()
    const sessionId = options.sessionId
    if (sessionId === undefined || sessionId === null) return next()
    const value = headerValueFor(sessionId, mode, uuidBySession)
    if (value === undefined) return next()

    // Reaching the adapter is the only way the actual HTTP request happens;
    // `next()` returns the downstream (lazy) stream. Call it exactly once,
    // then drive its iterator from inside the store.
    let downstream
    try {
      downstream = next()
    } catch (error) {
      // Let the caller handle an adapter dispatch failure as it normally would.
      throw error
    }
    if (downstream === undefined || downstream === null) return downstream
    if (typeof downstream[Symbol.asyncIterator] !== 'function') return downstream

    if (debug || debugFile !== undefined) {
      const entry = {
        ts: new Date().toISOString(),
        provider: options.provider,
        model: options.model,
        session: String(sessionId),
        header: SESSION_HEADER,
        value,
      }
      if (debugFile !== undefined) recordDebug(ctx, debugFile, entry)
      if (debug) {
        ctx.logger.info(
          '[opencode-go-session-header] streaming provider "%s" with %s=%s',
          options.provider,
          SESSION_HEADER,
          value,
        )
      }
    }
    return withStore(downstream, { value }, als)
  }, { prepend: true })
}

export default { name, inject, apply }
