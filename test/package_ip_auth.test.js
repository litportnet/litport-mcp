import assert from 'node:assert/strict'
import test from 'node:test'

import { createClient } from '../src/client.js'
import { registerTools } from '../src/tools/index.js'
import { createFakeFetch, createFakeServer, jsonResponse } from './helpers.js'

const baseUrl = 'https://litport.test'
const validKey = `lit_${'a'.repeat(43)}`

const setup = ({ routes = [] } = {}) => {
  const server = createFakeServer()
  const fetchImpl = createFakeFetch(routes)
  const client = createClient({ apiKey: validKey, baseUrl, fetchImpl })
  registerTools(server, {
    client,
    config: { apiKey: validKey, baseUrl, revealCredentials: false },
    fetchImpl,
  })
  return server
}

test('packages and allowed-ips tools are registered and use the documented 0.2.0 API paths, and the removed 0.1.x tools are gone', async () => {
  const server = setup({
    routes: [
      [/\/api\/v1\/packages\?/, jsonResponse(200, { data: [{ id: 12 }], page: { nextCursor: null } })],
      [/\/api\/v1\/packages\/12$/, jsonResponse(200, { data: { id: 12 } })],
      [/\/api\/v1\/packages\/12\/allowed-ips$/, jsonResponse(200, { data: { packageId: 12, limit: 50, ips: ['8.8.8.8'], available: true, unavailableCode: null } })],
    ],
  })

  for (const name of ['list_packages', 'get_package', 'get_allowed_ips']) {
    assert.equal(server.tools.get(name).config.annotations.readOnlyHint, true)
  }
  for (const name of ['set_allowed_ips', 'add_allowed_ip', 'remove_allowed_ip']) assert.equal(server.tools.has(name), true)
  // 0.1.3's ip-auth tools are gone in 0.2.0, replaced by the four above.
  for (const name of ['get_package_ip_auth', 'list_package_ip_auth_endpoints', 'add_package_ip', 'replace_package_ip', 'revoke_package_ip', 'get_account']) {
    assert.equal(server.tools.has(name), false, `${name} was removed in 0.2.0`)
  }

  assert.deepEqual(JSON.parse((await server.call('list_packages', { limit: 1 })).content[0].text).data, [{ id: 12 }])
  assert.equal(JSON.parse((await server.call('get_package', { packageId: 12 })).content[0].text).data.id, 12)
  assert.deepEqual(JSON.parse((await server.call('get_allowed_ips', { packageId: 12 })).content[0].text).data.ips, ['8.8.8.8'])
})

test('set_allowed_ips sends the whole list with no revision precondition', async () => {
  const calls = []
  const record = (url, options) => {
    calls.push({ url: url.toString(), options })
    return jsonResponse(200, { data: { packageId: 12, limit: 50, ips: ['203.0.113.8'], available: true, unavailableCode: null } })
  }
  const server = setup({ routes: [[/\/packages\/12\/allowed-ips$/, record]] })

  assert.deepEqual(server.tools.get('set_allowed_ips').config.annotations, {
    readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true,
  })

  const result = await server.call('set_allowed_ips', { packageId: 12, ips: ['203.0.113.8'] })
  assert.equal(calls[0].options.method, 'PUT')
  assert.equal(calls[0].options.body, '{"ips":["203.0.113.8"]}')
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(result.content[0].text).data.ips, ['203.0.113.8'])
})

test('add_allowed_ip and remove_allowed_ip put the IP in the path, with no body or Content-Type', async () => {
  const calls = []
  const record = (url, options) => {
    calls.push({ url: url.toString(), options })
    return jsonResponse(200, { data: { packageId: 12, limit: 50, ips: [], available: true, unavailableCode: null } })
  }
  const server = setup({ routes: [[/\/packages\/12\/allowed-ips\/203\.0\.113\.8/, record]] })

  assert.deepEqual(server.tools.get('add_allowed_ip').config.annotations, {
    readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  })
  assert.equal(server.tools.get('remove_allowed_ip').config.annotations.destructiveHint, true)

  await server.call('add_allowed_ip', { packageId: 12, ip: '203.0.113.8' })
  await server.call('remove_allowed_ip', { packageId: 12, ip: '203.0.113.8' })

  assert.deepEqual(calls.map(({ url, options }) => ({ path: url, method: options.method, body: options.body })), [
    { path: `${baseUrl}/api/v1/packages/12/allowed-ips/203.0.113.8`, method: 'PUT', body: undefined },
    { path: `${baseUrl}/api/v1/packages/12/allowed-ips/203.0.113.8`, method: 'DELETE', body: undefined },
  ])
  for (const { options } of calls) {
    assert.equal(options.headers.Authorization, `Bearer ${validKey}`)
    assert.equal(options.headers['Content-Type'], undefined)
    assert.equal(options.redirect, 'error')
    assert.ok(options.signal instanceof AbortSignal)
  }
})

test('IPv6 rejection is exposed as a support-directed API error', async () => {
  const server = setup({
    routes: [[/\/packages\/12\/allowed-ips\//, jsonResponse(400, { error: { code: 'IPV6_UNSUPPORTED', message: 'IPv6 requests are unsupported; contact support.' } })]],
  })
  const result = await server.call('add_allowed_ip', { packageId: 12, ip: '2001:db8::1' })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /IPV6_UNSUPPORTED/)
  assert.match(result.content[0].text, /contact support/i)
})

test('ALLOWED_IPS_LIMIT_REACHED (renamed from the 0.1.x IP_AUTH_LIMIT_REACHED) surfaces the API\'s message and code', async () => {
  const server = setup({
    routes: [[/\/packages\/12\/allowed-ips\//, jsonResponse(409, { error: { code: 'ALLOWED_IPS_LIMIT_REACHED', message: 'This package has reached its IP authentication limit. Contact support.' } })]],
  })
  const result = await server.call('add_allowed_ip', { packageId: 12, ip: '203.0.113.9' })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /ALLOWED_IPS_LIMIT_REACHED/)
})
