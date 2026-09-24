import assert from 'node:assert/strict'
import test from 'node:test'

import { registerTools } from '../src/tools/index.js'
import { createFakeServer } from './helpers.js'

const setup = () => {
  const server = createFakeServer()
  const client = { get: async () => { throw new Error('explain_proxy_error must never call the API') } }
  const fetchImpl = async () => { throw new Error('explain_proxy_error must never fetch') }
  const config = { apiKey: 'lit_test', baseUrl: 'https://litport.test', revealCredentials: false }
  registerTools(server, { client, config, fetchImpl })
  return server
}

test('resolves a known code with retry guidance and action, no network call', async () => {
  const server = setup()
  const result = await server.call('explain_proxy_error', { code: 13 })
  assert.equal(result.isError, undefined)
  assert.match(result.content[0].text, /ErrorPpgNotEnoughUnits/)
  assert.match(result.content[0].text, /Insufficient account balance/)
  assert.match(result.content[0].text, /Retry:/)
  assert.match(result.content[0].text, /Action:/)
  const jsonStart = result.content[0].text.indexOf('{')
  const payload = JSON.parse(result.content[0].text.slice(jsonStart))
  assert.equal(payload.proxyError.code, 13)
  assert.equal(payload.proxyError.http, '402')
})

test('reports an unknown code honestly and lists the valid range', async () => {
  const server = setup()
  const result = await server.call('explain_proxy_error', { code: 999 })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /No matching/)
  assert.match(result.content[0].text, /range from/)
})

test('requires at least one of code or message', async () => {
  const server = setup()
  const result = await server.call('explain_proxy_error', {})
  assert.equal(result.isError, true)
})

test('matches a SOCKS5 reply by hex code', async () => {
  const server = setup()
  const result = await server.call('explain_proxy_error', { message: '0x02' })
  assert.equal(result.isError, undefined)
  assert.match(result.content[0].text, /Connection not allowed/)
  // Credential and account failures are rejected at the SOCKS5 login, not with reply 0x02.
  assert.doesNotMatch(result.content[0].text, /Authentication/)
})
