import assert from 'node:assert/strict'
import test from 'node:test'

import { createClient } from '../src/client.js'
import { registerTools } from '../src/tools/index.js'
import { createFakeFetch, createFakeServer, jsonResponse } from './helpers.js'

const baseUrl = 'https://litport.test'

const poolsData = {
  pools: [
    { name: 'Residential', proxiesType: 'residential', authKey: 'residential-main', pricePerGb: '5.00', httpPort: 1337, socks5Port: 5337, eligibleHubIds: null },
    { name: 'Datacenter', proxiesType: 'datacenter', authKey: 'dc-main', pricePerGb: '1.00', httpPort: 31337, socks5Port: 35337, eligibleHubIds: ['us-1'] },
  ],
  hubs: [
    { id: 'us-1', name: 'US Hub', hostname: 'hub-us-1.litport.test' },
    { id: 'eu-1', name: 'EU Hub', hostname: 'hub-eu-1.litport.test' },
  ],
}

const flexibleToken = {
  id: 42,
  type: 'ppg',
  status: 'active',
  label: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: null,
  ingress: { hub: 'us-1', protocol: 'http', mode: 'request-selected', supportedProtocols: ['http', 'https', 'socks5'] },
  poolSelection: { mode: 'auth-parameter' },
  username: 'user123',
  password: 'super-secret-pass',
}

const fixedToken = {
  ...flexibleToken,
  id: 43,
  poolSelection: { mode: 'fixed', pool: { authKey: 'residential-main', name: 'Residential' } },
}

const setup = ({ tokens }) => {
  const server = createFakeServer()
  const routes = [
    [`${baseUrl}/api/v1/pools`, jsonResponse(200, { data: poolsData })],
    ...Object.entries(tokens).map(([id, token]) => [`${baseUrl}/api/v1/tokens/${id}`, jsonResponse(200, { data: token })]),
  ]
  const fetchImpl = createFakeFetch(routes)
  const client = createClient({ apiKey: 'lit_test', baseUrl, fetchImpl })
  const config = { apiKey: 'lit_test', baseUrl, revealCredentials: false }
  registerTools(server, { client, config, fetchImpl })
  return server
}

test('flexible (auth-parameter) token composes _pool- in the right place', async () => {
  const server = setup({ tokens: { 42: flexibleToken } })
  const result = await server.call('build_proxy_url', { tokenId: 42, pool: 'residential-main' })
  assert.equal(result.isError, undefined)
  const jsonStart = result.content[0].text.indexOf('{')
  const payload = JSON.parse(result.content[0].text.slice(jsonStart))
  assert.equal(payload.username, 'user123_pool-residential-main')
  assert.equal(payload.urls[0], 'http://user123_pool-residential-main:super-secret-pass@hub-us-1.litport.test:1337')
})

test('fixed token omits _pool- and rejects a conflicting pool', async () => {
  const server = setup({ tokens: { 43: fixedToken } })

  const ok = await server.call('build_proxy_url', { tokenId: 43 })
  assert.equal(ok.isError, undefined)
  const jsonStart = ok.content[0].text.indexOf('{')
  const okPayload = JSON.parse(ok.content[0].text.slice(jsonStart))
  assert.equal(okPayload.username, 'user123')
  assert.doesNotMatch(okPayload.username, /_pool-/)

  const conflict = await server.call('build_proxy_url', { tokenId: 43, pool: 'dc-main' })
  assert.equal(conflict.isError, true)
  assert.match(conflict.content[0].text, /fixed to pool/)
})

test('auth-parameter token without a pool argument is rejected before guessing', async () => {
  const server = setup({ tokens: { 42: flexibleToken } })
  const result = await server.call('build_proxy_url', { tokenId: 42 })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /specify "pool"/)
  assert.match(result.content[0].text, /residential-main/)
})

test('segment ordering is pool, country, region, city, sttl, sid', async () => {
  const server = setup({ tokens: { 42: flexibleToken } })
  const result = await server.call('build_proxy_url', {
    tokenId: 42, pool: 'residential-main', country: 'us', region: 'ca', city: 'los-angeles', sttl: 60, sid: 'abc123',
  })
  const jsonStart = result.content[0].text.indexOf('{')
  const payload = JSON.parse(result.content[0].text.slice(jsonStart))
  assert.equal(payload.username, 'user123_pool-residential-main_country-us_region-ca_city-los-angeles_sttl-60_sid-abc123')
})

test('socks5 protocol selects the pool\'s socks5Port', async () => {
  const server = setup({ tokens: { 42: flexibleToken } })
  const result = await server.call('build_proxy_url', { tokenId: 42, pool: 'residential-main', protocol: 'socks5' })
  const jsonStart = result.content[0].text.indexOf('{')
  const payload = JSON.parse(result.content[0].text.slice(jsonStart))
  assert.equal(payload.urls[0], 'socks5://user123_pool-residential-main:super-secret-pass@hub-us-1.litport.test:5337')
})

test('an ineligible hub is rejected, naming the eligible hubs', async () => {
  const server = setup({ tokens: { 42: flexibleToken } })
  const result = await server.call('build_proxy_url', { tokenId: 42, pool: 'dc-main', hub: 'eu-1' })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /not eligible/)
  assert.match(result.content[0].text, /us-1/)
})

test('invalid sid, sttl, and slug values are all rejected before any request is made', async () => {
  const server = createFakeServer()
  const fetchImpl = createFakeFetch([[/.*/, () => { throw new Error('the API must not be called') }]])
  const client = createClient({ apiKey: 'lit_test', baseUrl, fetchImpl })
  const config = { apiKey: 'lit_test', baseUrl, revealCredentials: false }
  registerTools(server, { client, config, fetchImpl })

  const badSid = await server.call('build_proxy_url', { tokenId: 42, pool: 'residential-main', sid: 'a' })
  assert.equal(badSid.isError, true)
  assert.match(badSid.content[0].text, /sid/)

  const badSttl = await server.call('build_proxy_url', { tokenId: 42, pool: 'residential-main', sttl: 999999 })
  assert.equal(badSttl.isError, true)
  assert.match(badSttl.content[0].text, /sttl/)

  const badSlug = await server.call('build_proxy_url', { tokenId: 42, pool: 'residential-main', country: 'United States' })
  assert.equal(badSlug.isError, true)
  assert.match(badSlug.content[0].text, /country/)
})

test('credentialStyle: "env" keeps the real password out of the URL', async () => {
  const server = setup({ tokens: { 42: flexibleToken } })
  const result = await server.call('build_proxy_url', { tokenId: 42, pool: 'residential-main', credentialStyle: 'env' })
  const jsonStart = result.content[0].text.indexOf('{')
  const payload = JSON.parse(result.content[0].text.slice(jsonStart))
  assert.doesNotMatch(payload.urls[0], /super-secret-pass/)
  assert.match(payload.urls[0], /\$LITPORT_PROXY_PASSWORD/)
  assert.equal(payload.password, 'super-secret-pass')
})

test('count: 3 yields 3 distinct session ids', async () => {
  const server = setup({ tokens: { 42: flexibleToken } })
  const result = await server.call('build_proxy_url', { tokenId: 42, pool: 'residential-main', sttl: 60, count: 3 })
  const jsonStart = result.content[0].text.indexOf('{')
  const payload = JSON.parse(result.content[0].text.slice(jsonStart))
  assert.equal(payload.urls.length, 3)
  const sids = payload.usernames.map(username => username.match(/_sid-([A-Za-z0-9]+)$/)[1])
  assert.equal(new Set(sids).size, 3)
})
