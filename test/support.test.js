import assert from 'node:assert/strict'
import test from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { ApiError, createClient } from '../src/client.js'
import { ConfigError, loadConfig } from '../src/config.js'
import { registerTools } from '../src/tools/index.js'
import { createFakeServer, jsonResponse } from './helpers.js'

const baseUrl = 'https://litport.test'
const validKey = `lit_${'a'.repeat(43)}`
const accessToken = `lsc_${'b'.repeat(43)}`
const conversationId = '4f0c2a7e9b1d4c5a8e3f6a1b2c3d4e5f'
const SUPPORT_TOOLS = ['contact_support', 'get_support_replies', 'reply_to_support']

const message = (seq, author, text) => ({ seq, at: '2026-10-16T17:05:00.000Z', author, text, files: [] })

// A fake fetch that records every call and answers each support route like the API.
const recordingFetch = ({ guest = true, onCall } = {}) => {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    const call = { url: new URL(url), method: options.method || 'GET', headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : undefined }
    calls.push(call)
    if (onCall) {
      const custom = onCall(call)
      if (custom) return custom
    }
    const { pathname } = call.url
    if (call.method === 'POST' && pathname === '/api/v1/support/conversations') {
      return jsonResponse(201, {
        conversationId,
        accessToken: guest ? accessToken : null,
        identity: guest ? 'guest' : 'account',
        howToUpgrade: guest ? 'This is a guest conversation.' : null,
        message: message(1, 'you', call.body.message),
      })
    }
    if (call.method === 'POST' && pathname.endsWith('/messages')) return jsonResponse(201, { message: message(2, 'you', call.body.message) })
    if (call.method === 'GET') {
      return jsonResponse(200, { conversationId, identity: guest ? 'guest' : 'account', howToUpgrade: null, lastSeq: 3, waitingOn: 'customer', messages: [message(3, 'mike', 'Hello')], more: false, pollAfterSeconds: 30 })
    }
    throw new Error(`No fake route for ${call.method} ${pathname}`)
  }
  return { calls, fetchImpl }
}

const setup = ({ apiKey = null, guest = apiKey === null, onCall } = {}) => {
  const { calls, fetchImpl } = recordingFetch({ guest, onCall })
  const server = createFakeServer()
  const client = createClient({ apiKey, baseUrl, fetchImpl })
  registerTools(server, { client, config: { apiKey, baseUrl, revealCredentials: false }, fetchImpl })
  return { server, calls }
}

const payload = result => JSON.parse(result.content[0].text)

test('without an API key the server offers the support and documentation tools only', () => {
  const { server } = setup()
  assert.deepEqual([...server.tools.keys()].sort(), [...SUPPORT_TOOLS, 'explain_proxy_error', 'get_doc', 'search_docs'].sort())
})

test('with an API key the support tools join the account tools', () => {
  const { server } = setup({ apiKey: validKey })
  for (const name of [...SUPPORT_TOOLS, 'list_tokens', 'build_proxy_url', 'search_docs']) assert.ok(server.tools.has(name), name)
})

test('the support tools carry honest annotations: reading is read-only, writing is not idempotent', () => {
  const { server } = setup()
  assert.equal(server.tools.get('get_support_replies').config.annotations.readOnlyHint, true)
  for (const name of ['contact_support', 'reply_to_support']) {
    const { annotations } = server.tools.get(name).config
    assert.equal(annotations.readOnlyHint, false, name)
    assert.equal(annotations.destructiveHint, false, name)
    assert.equal(annotations.idempotentHint, false, name)
  }
})

test('contact_support without a key needs an email and does not call the API without one', async () => {
  const { server, calls } = setup()
  const result = await server.call('contact_support', { message: 'Hello' })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /"email" is required/)
  assert.equal(calls.length, 0)
})

test('keyless contact_support creates a guest conversation with no Authorization header and keeps the token to itself', async () => {
  const { server, calls } = setup()
  const result = await server.call('contact_support', { message: 'Which countries do you cover?', email: 'agent@example.com' })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].url.toString(), `${baseUrl}/api/v1/support/conversations`)
  assert.equal(calls[0].headers.Authorization, undefined)
  assert.deepEqual(calls[0].body, { email: 'agent@example.com', message: 'Which countries do you cover?' })

  const shown = payload(result)
  assert.equal(shown.conversationId, conversationId)
  assert.equal(shown.identity, 'guest')
  assert.equal(shown.howToUpgrade, 'This is a guest conversation.')
  assert.equal(shown.message.text, 'Which countries do you cover?')
  assert.match(shown.note, /get_support_replies/)
  // The access token is a credential: it stays in the server process and never reaches the model.
  assert.equal(Object.hasOwn(shown, 'accessToken'), false)
  assert.equal(result.content[0].text.includes(accessToken), false)
})

test('after a keyless contact, get_support_replies and reply_to_support use the remembered conversation and its lsc_ token', async () => {
  const { server, calls } = setup()
  await server.call('contact_support', { message: 'Hello', email: 'agent@example.com' })

  const replies = await server.call('get_support_replies', { after: 1 })
  const read = calls[1]
  assert.equal(read.method, 'GET')
  assert.equal(read.url.pathname, `/api/v1/support/conversations/${conversationId}`)
  assert.equal(read.url.searchParams.get('after'), '1')
  assert.equal(read.headers.Authorization, `Bearer ${accessToken}`)
  assert.equal(payload(replies).messages[0].author, 'mike')
  assert.equal(replies.content[0].text.includes(accessToken), false)

  const sent = await server.call('reply_to_support', { message: 'Thanks' })
  const post = calls[2]
  assert.equal(post.method, 'POST')
  assert.equal(post.url.pathname, `/api/v1/support/conversations/${conversationId}/messages`)
  assert.equal(post.headers.Authorization, `Bearer ${accessToken}`)
  assert.deepEqual(post.body, { message: 'Thanks' })
  assert.equal(payload(sent).message.text, 'Thanks')
})

test('get_support_replies reads from the start when after is left out', async () => {
  const { server, calls } = setup()
  await server.call('contact_support', { message: 'Hello', email: 'agent@example.com' })
  await server.call('get_support_replies', {})
  assert.equal(calls[1].url.searchParams.has('after'), false)
  await server.call('get_support_replies', { after: 0 })
  assert.equal(calls[2].url.searchParams.get('after'), '0')
})

test('keyless support tools refuse before any call when the session has no conversation or no token for the id', async () => {
  const { server, calls } = setup()
  const noConversation = await server.call('get_support_replies', {})
  assert.equal(noConversation.isError, true)
  assert.match(noConversation.content[0].text, /Call contact_support first/)
  assert.equal((await server.call('reply_to_support', { message: 'Hello' })).isError, true)

  const foreignId = 'f'.repeat(32)
  const noToken = await server.call('get_support_replies', { conversationId: foreignId })
  assert.equal(noToken.isError, true)
  assert.match(noToken.content[0].text, /no access token for conversation/)
  assert.equal(calls.length, 0)
})

test('a second keyless conversation becomes the current one, and the first stays reachable by id', async () => {
  const second = 'a'.repeat(32)
  const secondToken = `lsc_${'c'.repeat(43)}`
  let created = 0
  const { server, calls } = setup({
    onCall: call => {
      if (call.method === 'POST' && call.url.pathname === '/api/v1/support/conversations' && ++created === 2) {
        return jsonResponse(201, { conversationId: second, accessToken: secondToken, identity: 'guest', howToUpgrade: 'x', message: message(1, 'you', 'Other') })
      }
      return null
    },
  })
  await server.call('contact_support', { message: 'First', email: 'agent@example.com' })
  await server.call('contact_support', { message: 'Other', email: 'agent@example.com' })

  await server.call('get_support_replies', {})
  assert.equal(calls[2].url.pathname, `/api/v1/support/conversations/${second}`)
  assert.equal(calls[2].headers.Authorization, `Bearer ${secondToken}`)

  await server.call('get_support_replies', { conversationId })
  assert.equal(calls[3].url.pathname, `/api/v1/support/conversations/${conversationId}`)
  assert.equal(calls[3].headers.Authorization, `Bearer ${accessToken}`)
})

test('with an API key contact_support uses the account conversation: bearer key, no email sent, no token', async () => {
  const { server, calls } = setup({ apiKey: validKey })
  const result = await server.call('contact_support', { message: 'Where is my order?', email: 'ignored@example.com' })

  assert.equal(calls[0].headers.Authorization, `Bearer ${validKey}`)
  assert.deepEqual(calls[0].body, { message: 'Where is my order?' })
  const shown = payload(result)
  assert.equal(shown.identity, 'account')
  assert.equal(shown.accessToken, undefined)
  assert.equal(shown.howToUpgrade, null)

  await server.call('get_support_replies', { after: 2 })
  assert.equal(calls[1].headers.Authorization, `Bearer ${validKey}`)
  await server.call('reply_to_support', { message: 'More detail' })
  assert.equal(calls[2].headers.Authorization, `Bearer ${validKey}`)
  assert.equal(calls[2].url.pathname, `/api/v1/support/conversations/${conversationId}/messages`)
})

test('with an API key a conversation id given by the caller is used with the key', async () => {
  const { server, calls } = setup({ apiKey: validKey })
  await server.call('get_support_replies', { conversationId })
  assert.equal(calls[0].url.pathname, `/api/v1/support/conversations/${conversationId}`)
  assert.equal(calls[0].headers.Authorization, `Bearer ${validKey}`)
})

test('API errors keep their code and Retry-After so the model waits instead of retrying', async () => {
  const { server } = setup({
    onCall: () => jsonResponse(429, { error: { code: 'RATE_LIMITED', message: 'Too many requests.', requestId: 'req_1', docsUrl: 'https://litport.net/docs/api/support' } }, { 'Retry-After': '30' }),
  })
  const result = await server.call('contact_support', { message: 'Hello', email: 'agent@example.com' })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /RATE_LIMITED/)
  assert.match(result.content[0].text, /Retry-After: 30s/)
  assert.match(result.content[0].text, /docs\/api\/support/)
})

test('a conversation id that could change the request path is rejected by the tool schema', () => {
  const { server } = setup()
  const { conversationId: schema } = server.tools.get('get_support_replies').config.inputSchema
  assert.equal(schema.safeParse(conversationId).success, true)
  for (const bad of ['../tokens', 'a/b', 'a?after=1', '', 'x'.repeat(65), 'a b']) assert.equal(schema.safeParse(bad).success, false, bad)
  const { message: messageSchema, email } = server.tools.get('contact_support').config.inputSchema
  assert.equal(messageSchema.safeParse('x'.repeat(4000)).success, true)
  assert.equal(messageSchema.safeParse('x'.repeat(4001)).success, false)
  assert.equal(messageSchema.safeParse('').success, false)
  assert.equal(email.safeParse('not an address').success, false)
})

test('a real MCP server lists the keyless tools with valid input schemas and answers a call end to end', async () => {
  const { fetchImpl, calls } = recordingFetch()
  const server = new McpServer({ name: 'litport', version: '0' })
  registerTools(server, { client: createClient({ apiKey: null, baseUrl, fetchImpl }), config: { apiKey: null, baseUrl, revealCredentials: false }, fetchImpl })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  try {
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map(tool => tool.name).sort(), [...SUPPORT_TOOLS, 'explain_proxy_error', 'get_doc', 'search_docs'].sort())
    const contact = tools.find(tool => tool.name === 'contact_support')
    assert.equal(contact.inputSchema.properties.message.maxLength, 4000)
    assert.equal(contact.inputSchema.properties.email.format, 'email')
    assert.deepEqual(contact.inputSchema.required, ['message'])

    const result = await client.callTool({ name: 'contact_support', arguments: { message: 'Hello', email: 'agent@example.com' } })
    assert.equal(JSON.parse(result.content[0].text).conversationId, conversationId)
    assert.equal(calls.length, 1)
  } finally {
    await client.close()
    await server.close()
  }
})

test('the client sends no Authorization header for bearer null, an lsc_ token for a string, and refuses an account call without a key', async () => {
  const { calls, fetchImpl } = recordingFetch()
  const keyless = createClient({ apiKey: null, baseUrl, fetchImpl })
  assert.equal(keyless.hasApiKey, false)

  await keyless.request('POST', '/support/conversations', { body: { email: 'agent@example.com', message: 'Hello' }, bearer: null })
  assert.equal(calls[0].headers.Authorization, undefined)
  assert.equal(calls[0].headers['Content-Type'], 'application/json')

  await keyless.request('GET', `/support/conversations/${conversationId}`, { bearer: accessToken })
  assert.equal(calls[1].headers.Authorization, `Bearer ${accessToken}`)

  await assert.rejects(keyless.get('/tokens'), error => error instanceof ApiError && /needs a Litport account API key/.test(error.message))
  assert.equal(calls.length, 2, 'the refused call never reached the network')

  const withKey = createClient({ apiKey: validKey, baseUrl, fetchImpl })
  assert.equal(withKey.hasApiKey, true)
  await withKey.get('/tokens')
  assert.equal(calls[2].headers.Authorization, `Bearer ${validKey}`)
})

test('a caller-supplied Authorization header still cannot replace the credential the client chose', async () => {
  const { calls, fetchImpl } = recordingFetch()
  const keyless = createClient({ apiKey: null, baseUrl, fetchImpl })
  await keyless.request('GET', `/support/conversations/${conversationId}`, { bearer: accessToken, headers: { Authorization: 'Bearer attacker' } })
  assert.equal(calls[0].headers.Authorization, `Bearer ${accessToken}`)
})

test('configuration accepts a missing API key, and still rejects a malformed one', () => {
  const keyless = loadConfig({})
  assert.equal(keyless.apiKey, null)
  assert.equal(keyless.baseUrl, 'https://litport.net')
  assert.equal(loadConfig({ LITPORT_API_KEY: '   ' }).apiKey, null)
  assert.equal(loadConfig({ LITPORT_API_KEY: validKey }).apiKey, validKey)
  assert.throws(() => loadConfig({ LITPORT_API_KEY: 'proxy_password' }), ConfigError)
})
