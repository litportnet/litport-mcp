import assert from 'node:assert/strict'
import test from 'node:test'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { createClient } from '../src/client.js'
import { registerTools } from '../src/tools/index.js'

const unlimitedToken = (ingress, overrides = {}) => ({
  id: 7, type: 'unlimited', status: 'active', label: null,
  createdAt: '2026-08-25T00:00:00.000Z', expiresAt: null,
  ingress, username: 'user7', password: 'sekret', ipAuth: null,
  ...overrides,
})

const callBuild = async (token, args) => {
  // build_proxy_url must not fetch /pay-per-gb/pools (or the old /pools) for an unlimited token;
  // a fake fetch that throws on any pools request proves it.
  const fetchImpl = async url => {
    if (String(url).includes('/pools')) throw new Error('build_proxy_url must not fetch pools for an unlimited token')
    return { ok: true, json: async () => ({ data: token }) }
  }
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

test('an unlimited token builds a working URL from its assigned endpoint, with no pools fetch', async () => {
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

test('passwordless builds a credential-free URL from token.ipAuth when it is ready', async () => {
  const result = await callBuild(
    unlimitedToken(ASSIGNED, { ipAuth: { host: 'ipauth-us-10.litport.net', port: 8443 } }),
    { tokenId: 7, passwordless: true },
  )
  assert.ok(!result.isError, text(result))
  assert.match(text(result), /socks5:\/\/ipauth-us-10\.litport\.net:8443/)
  assert.doesNotMatch(text(result), /sekret/)
  const payload = JSON.parse(text(result).slice(text(result).indexOf('{')))
  assert.equal(payload.username, null)
  assert.equal(payload.passwordless, true)
})

test('passwordless is refused by name when the token has no ready ipAuth endpoint', async () => {
  const result = await callBuild(unlimitedToken(ASSIGNED, { ipAuth: null }), { tokenId: 7, passwordless: true })
  assert.equal(result.isError, true)
  assert.match(text(result), /add_allowed_ip/)
})
