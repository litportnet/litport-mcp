import assert from 'node:assert/strict'
import test from 'node:test'

import { ApiError, createClient } from '../src/client.js'
import { ConfigError, loadConfig } from '../src/config.js'
import { jsonResponse } from './helpers.js'

const baseUrl = 'https://litport.test'
const validKey = `lit_${'a'.repeat(43)}`

test('client keeps bearer credentials local, rejects redirects, and does not retry write failures', async () => {
  let calls = 0
  const client = createClient({
    apiKey: validKey,
    baseUrl,
    fetchImpl: async (_url, options) => {
      calls++
      assert.equal(options.headers.Authorization, `Bearer ${validKey}`)
      assert.equal(options.redirect, 'error')
      throw new Error(`redirected to https://evil.test/?key=${validKey}`)
    },
  })
  await assert.rejects(
    client.request('PUT', '/packages/12/allowed-ips/203.0.113.8', { headers: { Authorization: 'Bearer attacker' } }),
    error => error instanceof ApiError && !error.message.includes(validKey),
  )
  assert.equal(calls, 1)
})

test('client aborts a stalled request within its configured timeout', async () => {
  const client = createClient({
    apiKey: validKey,
    baseUrl,
    timeoutMs: 1,
    fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }),
  })
  await assert.rejects(client.get('/packages'), /timed out after 1ms/)
})

test('client timeout includes a stalled response body', async () => {
  const client = createClient({
    apiKey: validKey,
    baseUrl,
    timeoutMs: 5,
    fetchImpl: async (_url, { signal }) => ({ ok: true, json: () => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted body')), { once: true })
    }) }),
  })
  await assert.rejects(client.get('/packages'), /timed out after 5ms/)
})

test('configuration accepts only safe API origins', () => {
  const config = loadConfig({ LITPORT_API_KEY: validKey })
  assert.equal(config.baseUrl, 'https://litport.net')
  assert.equal(loadConfig({ LITPORT_API_KEY: validKey, LITPORT_API_URL: 'http://localhost:3000' }).baseUrl, 'http://localhost:3000')
  assert.throws(() => loadConfig({ LITPORT_API_KEY: validKey, LITPORT_API_URL: 'http://litport.test' }), ConfigError)
  assert.throws(() => loadConfig({ LITPORT_API_KEY: validKey, LITPORT_API_URL: 'https://user:pass@litport.test/api' }), ConfigError)
})

test('an API error keeps the full error object, nextChangeAt, and the Retry-After header', async () => {
  const client = createClient({
    apiKey: validKey,
    baseUrl,
    fetchImpl: async () => jsonResponse(409, {
      error: {
        code: 'CHANGE_LIMIT', message: 'Try again later.', requestId: 'req_1',
        docsUrl: 'https://litport.net/docs/api/errors#change-limit', nextChangeAt: '2026-10-06T00:00:00.000Z',
      },
    }, { 'Retry-After': '86400' }),
  })
  await assert.rejects(client.get('/tokens/1/location'), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.status, 409)
    assert.equal(error.code, 'CHANGE_LIMIT')
    assert.equal(error.requestId, 'req_1')
    assert.equal(error.docsUrl, 'https://litport.net/docs/api/errors#change-limit')
    assert.equal(error.nextChangeAt, '2026-10-06T00:00:00.000Z')
    assert.equal(error.retryAfter, '86400')
    assert.equal(error.error.code, 'CHANGE_LIMIT')
    return true
  })
})

test('an API error with no Retry-After header or nextChangeAt leaves both unset', async () => {
  const client = createClient({
    apiKey: validKey,
    baseUrl,
    fetchImpl: async () => jsonResponse(404, { error: { code: 'TOKEN_NOT_FOUND', message: 'Token not found.' } }),
  })
  await assert.rejects(client.get('/tokens/999'), error => {
    assert.equal(error.nextChangeAt, undefined)
    assert.equal(error.retryAfter, null)
    return true
  })
})
