import assert from 'node:assert/strict'
import test from 'node:test'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { createClient } from '../src/client.js'
import { registerTools } from '../src/tools/index.js'

const POOLS = { data: { pools: [{ name: 'kilo', proxiesType: 'residential', authKey: 'residential-kilo', pricePerGb: '4.5', httpPort: 1337, socks5Port: 5337, eligibleHubIds: null }], hubs: [{ id: 'us-10', name: 'Dallas', hostname: 'hub-us-10.litport.net' }] } }

const unlimitedToken = ingress => ({
  id: 7, type: 'unlimited', status: 'active', label: null,
  createdAt: '2026-08-25T00:00:00.000Z', expiresAt: null,
  ingress, username: 'user7', password: 'sekret',
})

const callBuild = async (token, args) => {
  const fetchImpl = async url => ({ ok: true, json: async () => String(url).includes('/pools') ? POOLS : { data: token } })
  const server = new McpServer({ name: 't', version: '0' })
  const tools = {}
  const original = server.registerTool.bind(server)
  server.registerTool = (name, def, handler) => { tools[name] = handler; return original(name, def, handler) }
  registerTools(server, {
    client: createClient({ apiKey: 'lit_x', baseUrl: 'https://litport.net', fetchImpl }),
    config: { baseUrl: 'https://litport.net', revealCredentials: false },
  })
  return tools.build_proxy_url(args)
}

const text = result => result.content.map(part => part.text).join('\n')

const ASSIGNED = { hub: 'us-10', protocol: 'socks5', mode: 'assigned', host: 'hub-us-10.litport.net', port: 35337, status: 'available' }

test('an unlimited token builds a working URL from its assigned endpoint', async () => {
  const result = await callBuild(unlimitedToken(ASSIGNED), { tokenId: 7 })
  assert.ok(!result.isError, text(result))
  assert.match(text(result), /socks5:\/\/user7:sekret@hub-us-10\.litport\.net:35337/)
})

test('an unlimited token on a retired hub explains the problem instead of emitting a broken URL', async () => {
  const result = await callBuild(
    unlimitedToken({ hub: 'us-4', protocol: 'socks5', mode: 'assigned', host: null, port: null, status: 'hub-unavailable' }),
    { tokenId: 7 },
  )
  assert.equal(result.isError, true)
  assert.match(text(result), /no longer in service/)
  assert.doesNotMatch(text(result), /undefined|null:/)
})

test('pay-per-GB selectors are rejected on an unlimited token, naming the offending ones', async () => {
  const result = await callBuild(unlimitedToken(ASSIGNED), { tokenId: 7, country: 'us', sttl: 600 })
  assert.equal(result.isError, true)
  assert.match(text(result), /country/)
  assert.match(text(result), /sttl/)
  assert.doesNotMatch(text(result), /\bpool\b,/)
})

test('an unlimited token refuses a protocol its assigned port does not match', async () => {
  const result = await callBuild(unlimitedToken(ASSIGNED), { tokenId: 7, protocol: 'http' })
  assert.equal(result.isError, true)
  assert.match(text(result), /tied to that protocol/)
})

test('env credential style keeps the password out of an unlimited token URL', async () => {
  const result = await callBuild(unlimitedToken(ASSIGNED), { tokenId: 7, credentialStyle: 'env' })
  assert.ok(!result.isError, text(result))
  assert.match(text(result), /\$LITPORT_PROXY_PASSWORD/)
  const payload = JSON.parse(text(result).slice(text(result).indexOf('{')))
  assert.equal(payload.urls[0].includes('sekret'), false)
  assert.equal(payload.password, 'sekret')
})
