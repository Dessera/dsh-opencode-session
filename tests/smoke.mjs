import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { patchFetch, isOpenCodeEndpoint, headerValueFor, withStore } from '../lib/index.js'

const calls = []
const fakeFetch = async (input, init) => {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  calls.push(headers.get('x-opencode-session'))
  return 'ok'
}

const als = new AsyncLocalStorage()
const patched = patchFetch(fakeFetch, als, 'dsh-auxiliary-calls')

// 1. Store active: force-override wins over an existing header.
await als.run({ value: 'session-aaa' }, () =>
  patched('https://opencode.ai/zen/go/v1/chat/completions', { headers: { 'x-opencode-session': 'static-value' } }))
assert.equal(calls.at(-1), 'session-aaa', 'force override wins over static header')

// 2. No store, opencode.ai host, no header: fallback filled.
await patched('https://opencode.ai/zen/go/v1/chat/completions', { headers: { authorization: 'x' } })
assert.equal(calls.at(-1), 'dsh-auxiliary-calls', 'fallback fills session-less gateway calls')

// 3. No store, opencode.ai host, header already present: untouched.
await patched('https://opencode.ai/zen/go/v1/chat/completions', { headers: { 'x-opencode-session': 'kept' } })
assert.equal(calls.at(-1), 'kept', 'fallback never clobbers an existing header')

// 4. No store, non-opencode host: untouched even without header.
await patched('https://api.example.com/v1/chat', {})
assert.equal(calls.at(-1), null, 'non-gateway hosts untouched')

// 5. No store, no init.headers but Request object: base headers respected.
const req = new Request('https://zen.opencode.ai/v1/models', { headers: { 'x-opencode-session': 'from-request' } })
await patched(req)
assert.equal(calls.at(-1), 'from-request', 'Request-object headers respected')

// 6. URL forms: string, URL, probe host variants.
assert.equal(isOpenCodeEndpoint('https://opencode.ai/zen/go/v1/chat/completions'), true)
assert.equal(isOpenCodeEndpoint(new URL('https://zen.opencode.ai/v1/models')), true)
assert.equal(isOpenCodeEndpoint('https://evil-opencode.ai/x'), false, 'sibling domain not matched')
assert.equal(isOpenCodeEndpoint('https://notopencode.ai/x'), false, 'suffix domain not matched')
assert.equal(isOpenCodeEndpoint('not a url'), false, 'invalid input safe')

// 7. headerValueFor + withStore sanity (unchanged upstream behavior).
const uuidTable = new Map()
assert.equal(headerValueFor('s1', 'session-id', uuidTable), 's1')
const uuid = headerValueFor('s1', 'uuid', uuidTable)
assert.equal(headerValueFor('s1', 'uuid', uuidTable), uuid, 'uuid stable per session')

console.log('all smoke assertions passed')
