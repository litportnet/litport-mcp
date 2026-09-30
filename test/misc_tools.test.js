import assert from 'node:assert/strict'
import test from 'node:test'

import { createClient } from '../src/client.js'
import { registerTools } from '../src/tools/index.js'
import { createFakeFetch, createFakeServer, jsonResponse, textResponse } from './helpers.js'

const baseUrl = 'https://litport.test'

const setup = ({ routes = [], fetchImpl } = {}) => {
  const server = createFakeServer()
  const effectiveFetch = fetchImpl || createFakeFetch(routes)
  const client = createClient({ apiKey: 'lit_test', baseUrl, fetchImpl: effectiveFetch })
  const config = { apiKey: 'lit_test', baseUrl, revealCredentials: false }
  registerTools(server, { client, config, fetchImpl: effectiveFetch })
  return server
}

test('list_pools passes the API response through unchanged, from /pay-per-gb/pools', async () => {
  const poolsData = [{ name: 'Residential', authKey: 'residential-main', hubs: [], geoLevels: [] }]
  const server = setup({ routes: [[`${baseUrl}/api/v1/pay-per-gb/pools`, jsonResponse(200, { data: poolsData, page: { nextCursor: null } })]] })
  const result = await server.call('list_pools', {})
  const payload = JSON.parse(result.content[0].text)
  assert.deepEqual(payload.data, poolsData)
})

test('get_balance passes the API response through unchanged, from /pay-per-gb/balance', async () => {
  const balanceData = { balance: { unitsActive: '1', unitsReserved: '0', unitsAvailable: '1', unitsExpireAt: null }, plan: { id: 'pro', expiresAt: null } }
  const server = setup({ routes: [[`${baseUrl}/api/v1/pay-per-gb/balance`, jsonResponse(200, { data: balanceData })]] })
  const result = await server.call('get_balance', {})
  const payload = JSON.parse(result.content[0].text)
  assert.deepEqual(payload.data, balanceData)
})

test('list_targeting_options rejects level=region without country, without calling the API', async () => {
  const server = setup({ routes: [[/.*/, () => { throw new Error('must not call the API') }]] })
  const result = await server.call('list_targeting_options', { pool: 'residential-main', level: 'region' })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /requires a "country"/)
})

test('list_targeting_options rejects level=city without region, without calling the API', async () => {
  const server = setup({ routes: [[/.*/, () => { throw new Error('must not call the API') }]] })
  const result = await server.call('list_targeting_options', { pool: 'residential-main', level: 'city', country: 'us' })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /requires both "country" and "region"/)
})

test('list_targeting_options calls /pay-per-gb/geo and forwards limit and cursor, never offset', async () => {
  let requestedUrl
  const server = setup({
    routes: [[`${baseUrl}/api/v1/pay-per-gb/geo`, url => {
      requestedUrl = url.toString()
      return jsonResponse(200, { data: [{ value: 'us', label: 'United States' }], page: { nextCursor: null } })
    }]],
  })
  const result = await server.call('list_targeting_options', { pool: 'residential-main', level: 'country', limit: 10, cursor: 'abc' })
  const url = new URL(requestedUrl)
  assert.equal(url.searchParams.get('limit'), '10')
  assert.equal(url.searchParams.get('cursor'), 'abc')
  assert.equal(url.searchParams.has('offset'), false)
  assert.deepEqual(JSON.parse(result.content[0].text).data, [{ value: 'us', label: 'United States' }])
})

test('search_docs ranks matches from llms.txt by title/description substring', async () => {
  const llmsTxt = [
    '# Litport documentation',
    '',
    '- [API Tokens](https://litport.test/docs/api/tokens.md): List and inspect proxy tokens.',
    '- [Proxy Errors](https://litport.test/docs/proxy-errors.md): X-Proxy-Error-Code reference.',
    '',
  ].join('\n')
  const server = setup({ fetchImpl: async () => textResponse(200, llmsTxt) })
  const result = await server.call('search_docs', { query: 'token' })
  const payload = JSON.parse(result.content[0].text)
  assert.equal(payload.results.length, 1)
  assert.equal(payload.results[0].title, 'API Tokens')
})
