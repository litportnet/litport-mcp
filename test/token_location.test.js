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

test('get_token_location passes the API response through unchanged', async () => {
  const location = {
    tokenId: 201, kind: 'datacenter', mode: 'rotating',
    target: { country: 'us', region: 'any', city: 'any' }, effective: null,
    status: 'ready', canChangeNow: true, nextChangeAt: null,
  }
  const server = setup({ routes: [[`${baseUrl}/api/v1/tokens/201/location`, jsonResponse(200, { data: location })]] })
  const result = await server.call('get_token_location', { tokenId: 201 })
  assert.equal(result.isError, undefined)
  assert.deepEqual(JSON.parse(result.content[0].text).data, location)
})

test('get_token_location surfaces NOT_SUPPORTED for a token whose location cannot change', async () => {
  const server = setup({
    routes: [[`${baseUrl}/api/v1/tokens/501/location`, jsonResponse(409, { error: { code: 'NOT_SUPPORTED', message: "This proxy's location can't be changed." } })]],
  })
  const result = await server.call('get_token_location', { tokenId: 501 })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /NOT_SUPPORTED/)
})

test('list_location_options forwards level, region, and city', async () => {
  let requestedUrl
  const server = setup({
    routes: [[`${baseUrl}/api/v1/tokens/201/location/options`, url => {
      requestedUrl = url.toString()
      return jsonResponse(200, { data: [{ value: 'atlanta', label: 'Atlanta' }], page: { nextCursor: null } })
    }]],
  })
  const result = await server.call('list_location_options', { tokenId: 201, level: 'city', region: 'georgia' })
  const url = new URL(requestedUrl)
  assert.equal(url.searchParams.get('level'), 'city')
  assert.equal(url.searchParams.get('region'), 'georgia')
  assert.deepEqual(JSON.parse(result.content[0].text).data, [{ value: 'atlanta', label: 'Atlanta' }])
})

test('set_token_location sends only the keys given, for a datacenter/ISP shape', async () => {
  const calls = []
  const record = (url, options) => { calls.push({ url: url.toString(), options }); return jsonResponse(200, { data: {} }) }
  const server = setup({ routes: [[`${baseUrl}/api/v1/tokens/201/location`, record]] })

  assert.deepEqual(server.tools.get('set_token_location').config.annotations, {
    readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  })

  await server.call('set_token_location', { tokenId: 201, region: 'georgia', city: 'atlanta' })
  assert.equal(calls[0].options.method, 'PUT')
  assert.deepEqual(JSON.parse(calls[0].options.body), { region: 'georgia', city: 'atlanta' })
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json')
})

test('set_token_location sends only the keys given, for a mobile shape', async () => {
  const calls = []
  const record = (url, options) => { calls.push({ url: url.toString(), options }); return jsonResponse(200, { data: {} }) }
  const server = setup({ routes: [[`${baseUrl}/api/v1/tokens/301/location`, record]] })

  await server.call('set_token_location', { tokenId: 301, city: 'atlanta', carrier: 'att' })
  assert.deepEqual(JSON.parse(calls[0].options.body), { city: 'atlanta', carrier: 'att' })
})

test('a CHANGE_LIMIT error surfaces nextChangeAt and Retry-After so the model does not retry blindly', async () => {
  const server = setup({
    routes: [[`${baseUrl}/api/v1/tokens/301/location`, jsonResponse(409, {
      error: {
        code: 'CHANGE_LIMIT', message: 'You can change location and carrier once per 48 hours.',
        nextChangeAt: '2026-10-06T00:00:00.000Z',
      },
    }, { 'Retry-After': '86400' })]],
  })
  const result = await server.call('set_token_location', { tokenId: 301, city: 'atlanta', carrier: 'att' })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /CHANGE_LIMIT/)
  assert.match(result.content[0].text, /2026-10-06T00:00:00\.000Z/)
  assert.match(result.content[0].text, /86400/)
})
