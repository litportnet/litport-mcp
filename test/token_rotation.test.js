import assert from 'node:assert/strict'
import test from 'node:test'

import { createClient } from '../src/client.js'
import { registerTools } from '../src/tools/index.js'
import { createFakeFetch, createFakeServer, jsonResponse } from './helpers.js'

const baseUrl = 'https://litport.test'

const setup = ({ routes = [] } = {}) => {
  const server = createFakeServer()
  const fetchImpl = createFakeFetch(routes)
  const client = createClient({ apiKey: 'lit_test', baseUrl, fetchImpl })
  registerTools(server, { client, config: { apiKey: 'lit_test', baseUrl, revealCredentials: false }, fetchImpl })
  return server
}

test('set_rotation sends {intervalSec} only', async () => {
  const calls = []
  const record = (url, options) => {
    calls.push({ url: url.toString(), options })
    return jsonResponse(200, { data: { tokenId: 201, intervalSec: 600, options: [300, 600], changeable: true } })
  }
  const server = setup({ routes: [[`${baseUrl}/api/v1/tokens/201/rotation`, record]] })

  assert.deepEqual(server.tools.get('set_rotation').config.annotations, {
    readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  })

  const result = await server.call('set_rotation', { tokenId: 201, intervalSec: 600 })
  assert.equal(calls[0].options.method, 'PUT')
  assert.deepEqual(JSON.parse(calls[0].options.body), { intervalSec: 600 })
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json')
  assert.equal(JSON.parse(result.content[0].text).data.intervalSec, 600)
})

test('set_rotation surfaces NOT_SUPPORTED for a Multi-location token', async () => {
  const server = setup({
    routes: [[`${baseUrl}/api/v1/tokens/401/rotation`, jsonResponse(409, { error: { code: 'NOT_SUPPORTED', message: "This proxy's rotation interval can't be changed." } })]],
  })
  const result = await server.call('set_rotation', { tokenId: 401, intervalSec: 600 })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /NOT_SUPPORTED/)
})

test('set_rotation surfaces INVALID_ROTATION for an interval outside the token\'s options', async () => {
  const server = setup({
    routes: [[`${baseUrl}/api/v1/tokens/201/rotation`, jsonResponse(400, { error: { code: 'INVALID_ROTATION', message: 'intervalSec must be one of the listed options.' } })]],
  })
  const result = await server.call('set_rotation', { tokenId: 201, intervalSec: 7 })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /INVALID_ROTATION/)
})

test('get_new_ip is registered as a non-idempotent write, sent as a bare POST with no body', async () => {
  const calls = []
  const record = (url, options) => {
    calls.push({ url: url.toString(), options })
    return jsonResponse(200, { data: { tokenId: 301, kind: 'datacenter', mode: 'static', status: 'pending', canChangeNow: false, nextChangeAt: '2026-10-06T00:00:00.000Z' } })
  }
  const server = setup({ routes: [[`${baseUrl}/api/v1/tokens/301/new-ip`, record]] })

  assert.deepEqual(server.tools.get('get_new_ip').config.annotations, {
    readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
  })

  await server.call('get_new_ip', { tokenId: 301 })
  assert.equal(calls[0].options.method, 'POST')
  assert.equal(calls[0].options.body, undefined)
  assert.equal(calls[0].options.headers['Content-Type'], undefined)
})

test('get_new_ip surfaces CHANGE_LIMIT with nextChangeAt and Retry-After so the model does not blindly retry', async () => {
  const server = setup({
    routes: [[`${baseUrl}/api/v1/tokens/301/new-ip`, jsonResponse(409, {
      error: { code: 'CHANGE_LIMIT', message: 'You can replace this proxy once a week.', nextChangeAt: '2026-10-06T00:00:00.000Z' },
    }, { 'Retry-After': '604800' })]],
  })
  const result = await server.call('get_new_ip', { tokenId: 301 })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /CHANGE_LIMIT/)
  assert.match(result.content[0].text, /nextChangeAt: 2026-10-06T00:00:00\.000Z/)
  assert.match(result.content[0].text, /Retry-After: 604800s/)
})
