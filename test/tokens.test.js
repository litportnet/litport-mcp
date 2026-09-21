import assert from 'node:assert/strict'
import test from 'node:test'

import { createClient } from '../src/client.js'
import { registerTools } from '../src/tools/index.js'
import { createFakeFetch, createFakeServer, jsonResponse } from './helpers.js'

const baseUrl = 'https://litport.test'

const sampleToken = (overrides = {}) => ({
  id: 42,
  type: 'ppg',
  status: 'active',
  label: 'scraper token',
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: null,
  ingress: { hub: 'us-1', protocol: 'http', mode: 'request-selected', supportedProtocols: ['http', 'https', 'socks5'] },
  poolSelection: { mode: 'auth-parameter' },
  username: 'user123',
  password: 'super-secret-pass',
  ...overrides,
})

const setup = ({ routes, revealCredentials = false }) => {
  const server = createFakeServer()
  const fetchImpl = createFakeFetch(routes)
  const client = createClient({ apiKey: 'lit_testkeytesttesttesttesttesttesttesttesttest', baseUrl, fetchImpl })
  const config = { apiKey: 'lit_test', baseUrl, revealCredentials }
  registerTools(server, { client, config, fetchImpl })
  return server
}

test('list_tokens masks the password by default and adds passwordSet + a hint', async () => {
  const server = setup({
    routes: [[`${baseUrl}/api/v1/tokens`, jsonResponse(200, { data: [sampleToken()], page: { nextCursor: null } })]],
  })
  const result = await server.call('list_tokens', {})
  assert.equal(result.isError, undefined)
  const payload = JSON.parse(result.content[0].text)
  assert.equal(payload.data.length, 1)
  assert.equal(payload.data[0].password, null)
  assert.equal(payload.data[0].passwordSet, true)
  assert.equal(payload.data[0].username, 'user123')
  assert.match(payload.hint, /get_token_credentials|build_proxy_url/)
})

test('list_tokens passes credentials through unchanged when revealCredentials is true', async () => {
  const server = setup({
    routes: [[`${baseUrl}/api/v1/tokens`, jsonResponse(200, { data: [sampleToken()], page: { nextCursor: null } })]],
    revealCredentials: true,
  })
  const result = await server.call('list_tokens', {})
  const payload = JSON.parse(result.content[0].text)
  assert.equal(payload.data[0].password, 'super-secret-pass')
  assert.equal(payload.hint, undefined)
})

test('get_token_credentials returns the real password even when revealCredentials is false', async () => {
  const server = setup({
    routes: [[`${baseUrl}/api/v1/tokens/42`, jsonResponse(200, { data: sampleToken() })]],
    revealCredentials: false,
  })
  const result = await server.call('get_token_credentials', { tokenId: 42 })
  const payload = JSON.parse(result.content[0].text)
  assert.equal(payload.data.password, 'super-secret-pass')
})

test('get_token_usage rejects includeCharges with groupBy=day without calling the API', async () => {
  const server = setup({
    routes: [[/.*/, () => { throw new Error('the API must not be called') }]],
  })
  const result = await server.call('get_token_usage', { tokenId: 42, groupBy: 'day', includeCharges: true })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /groupBy/)
  assert.match(result.content[0].text, /hour/)
})

test('get_token_usage calls the API with the include list built from the two booleans', async () => {
  let requestedUrl
  const server = setup({
    routes: [[`${baseUrl}/api/v1/tokens/42/usage`, url => {
      requestedUrl = url.toString()
      return jsonResponse(200, { data: {} })
    }]],
  })
  const result = await server.call('get_token_usage', { tokenId: 42, groupBy: 'hour', includeDomains: true, includeCharges: true })
  assert.equal(result.isError, undefined)
  const url = new URL(requestedUrl)
  assert.equal(url.searchParams.get('include'), 'domains,charges')
  assert.equal(url.searchParams.get('groupBy'), 'hour')
})
