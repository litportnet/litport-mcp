import assert from 'node:assert/strict'
import test from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { createClient } from '../src/client.js'
import { registerTools } from '../src/tools/index.js'
import { createFakeServer, jsonResponse } from './helpers.js'

const baseUrl = 'https://litport.test'
const validKey = `lit_${'a'.repeat(43)}`
const WRITE_TOOLS = ['create_token', 'update_token', 'reissue_credentials', 'delete_token']

const proxy = (overrides = {}) => ({
  id: 4242,
  type: 'ppg',
  status: 'active',
  disabledReason: null,
  label: 'Acme',
  externalRef: 'cust-1',
  createdAt: '2026-11-04T12:00:00.000Z',
  expiresAt: null,
  allowanceBytes: null,
  allowanceReservedBytes: null,
  ingress: { hub: 'us-1', protocol: 'http', mode: 'request-selected', supportedProtocols: ['http', 'https', 'socks5'] },
  poolSelection: { mode: 'auth-parameter' },
  packageId: null,
  ipAuth: null,
  username: 'user4242',
  password: 'real-secret-password',
  ...overrides,
})

// A fake fetch that records every call and answers with the next queued response.
const setup = ({ responses = [], apiKey = validKey, revealCredentials = false } = {}) => {
  const calls = []
  const queue = [...responses]
  const fetchImpl = async (url, options = {}) => {
    calls.push({
      url: new URL(url),
      method: options.method || 'GET',
      headers: options.headers || {},
      rawBody: options.body,
      body: options.body ? JSON.parse(options.body) : undefined,
    })
    const next = queue.shift()
    if (!next) throw new Error(`No fake response left for ${options.method} ${url}`)
    return typeof next === 'function' ? next() : next
  }
  const server = createFakeServer()
  const client = createClient({ apiKey, baseUrl, fetchImpl })
  registerTools(server, { client, config: { apiKey, baseUrl, revealCredentials }, fetchImpl })
  return { server, calls, fetchImpl }
}

const apiError = (status, code, message, extra = {}) => jsonResponse(status, {
  error: { code, message, requestId: 'req_1', docsUrl: `https://litport.net/docs/api/errors#${code.toLowerCase().replaceAll('_', '-')}`, ...extra },
})

// What the account API answers to a successful DELETE: 204 and no body to read.
const noContent = () => ({
  ok: true,
  status: 204,
  headers: { get: () => null },
  json: async () => { throw new SyntaxError('Unexpected end of JSON input') },
  text: async () => '',
})

const payload = result => JSON.parse(result.content[0].text)

test('with an API key the proxy write tools and get_usage are registered; without one they are not', () => {
  const keyed = setup().server
  for (const name of [...WRITE_TOOLS, 'get_usage']) assert.ok(keyed.tools.has(name), name)
  const keyless = setup({ apiKey: null }).server
  for (const name of [...WRITE_TOOLS, 'get_usage']) assert.equal(keyless.tools.has(name), false, `${name} needs an account key`)
})

test('every write tool says in its description that it changes live proxies', () => {
  const { server } = setup()
  const says = {
    create_token: [/live pay-per-GB proxy/, /billed per GB/, /ALWAYS send\s+externalRef/, /second\s+proxy/, /traffic cap in bytes/],
    update_token: [/live pay-per-GB proxy/, /ends the proxy's open connections once/, /FIELD_NOT_ALLOWED/, /null clears/],
    reissue_credentials: [/old password stops working at once/, /open connections close/, /allowed IPs keep working/, /NEW requestId/, /same one only to retry/, /do not repeat it blindly/],
    delete_token: [/stops working/, /already deleted is not an error/, /NOT_SUPPORTED/, /enabled: false/],
  }
  for (const [name, patterns] of Object.entries(says)) {
    const { description } = server.tools.get(name).config
    for (const pattern of patterns) assert.match(description, pattern, `${name} description`)
  }
})

test('the write tools carry honest annotations', () => {
  const { server } = setup()
  const annotationsOf = name => server.tools.get(name).config.annotations
  // create is not idempotent: without an externalRef a repeat makes a second proxy
  assert.deepEqual(annotationsOf('create_token'), { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true })
  // update can switch a proxy off or end its open connections, and the same arguments leave the same state
  assert.deepEqual(annotationsOf('update_token'), { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true })
  // reissue replaces working credentials, and a repeat without a requestId issues another pair
  assert.deepEqual(annotationsOf('reissue_credentials'), { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true })
  // delete: a second delete is also 204
  assert.deepEqual(annotationsOf('delete_token'), { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true })
  assert.deepEqual(annotationsOf('get_usage'), { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true })
})

test('create_token POSTs exactly the arguments it was given and returns the real credentials even when listings are masked', async () => {
  const { server, calls } = setup({
    responses: [jsonResponse(201, { data: proxy({ allowanceBytes: 5_000_000_000, allowanceReservedBytes: 0, expiresAt: '2026-12-31T23:59:59.999Z' }) })],
    revealCredentials: false,
  })
  const args = { pool: 'residential-main', label: 'Acme', externalRef: 'cust-1', expiresAt: '2026-12-31', allowanceBytes: 5_000_000_000 }
  const result = await server.call('create_token', args)

  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].url.toString(), `${baseUrl}/api/v1/tokens`)
  assert.deepEqual(calls[0].body, args)
  assert.equal(calls[0].headers['Content-Type'], 'application/json')
  assert.equal(calls[0].headers.Authorization, `Bearer ${validKey}`)

  assert.equal(result.isError, undefined)
  const data = payload(result)
  assert.equal(data.data.username, 'user4242')
  assert.equal(data.data.password, 'real-secret-password', 'credentials are handled like get_token_credentials: real, not masked')
  assert.equal(data.data.allowanceBytes, 5_000_000_000)
})

test('create_token with no arguments still sends an empty JSON object, which the API requires', async () => {
  const { server, calls } = setup({ responses: [jsonResponse(201, { data: proxy() })] })
  await server.call('create_token', {})
  assert.equal(calls[0].rawBody, '{}')
  assert.equal(calls[0].headers['Content-Type'], 'application/json')
})

test('create_token leaves out what it was not given, and a repeat with a known externalRef (200) is a success', async () => {
  const { server, calls } = setup({ responses: [jsonResponse(200, { data: proxy() })] })
  const result = await server.call('create_token', { externalRef: 'cust-1', label: undefined })
  assert.deepEqual(calls[0].body, { externalRef: 'cust-1' })
  assert.equal(result.isError, undefined)
  assert.equal(payload(result).data.externalRef, 'cust-1')
})

test('create_token surfaces the API refusals with code and docs link', async () => {
  const cases = [
    [402, 'INSUFFICIENT_BALANCE', 'Top up your balance to create or switch on a pay-per-GB proxy.'],
    [403, 'ACCOUNT_BANNED', "You can't add or turn on proxies while your account is blocked."],
    [409, 'ALLOWANCE_CONFLICT', 'The traffic limit could not be published. Try again.'],
    [409, 'TOKEN_LIMIT_REACHED', 'You have reached the maximum number of pay-per-GB proxy tokens.'],
    [400, 'INVALID_POOL', 'pool is invalid.'],
    [400, 'INVALID_EXPIRY', 'expiresAt must be in the future.'],
  ]
  for (const [status, code, message] of cases) {
    const { server } = setup({ responses: [apiError(status, code, message)] })
    // eslint-disable-next-line no-await-in-loop
    const result = await server.call('create_token', { allowanceBytes: 1 })
    assert.equal(result.isError, true, code)
    assert.match(result.content[0].text, new RegExp(code))
    assert.match(result.content[0].text, /docs: https:\/\/litport\.net\/docs\/api\/errors#/)
    assert.ok(result.content[0].text.startsWith(message), code)
  }
})

test('create_token input schema: bounds on label, externalRef and allowanceBytes', () => {
  const { server } = setup()
  const schema = z.object(server.tools.get('create_token').config.inputSchema).strict()
  assert.equal(schema.safeParse({}).success, true)
  assert.equal(schema.safeParse({ pool: 'p', label: 'x'.repeat(255), externalRef: 'x'.repeat(128), expiresAt: '2026-12-31', allowanceBytes: 1 }).success, true)
  for (const bad of [
    { label: 'x'.repeat(256) },
    { externalRef: '' },
    { externalRef: 'x'.repeat(129) },
    { allowanceBytes: 0 },
    { allowanceBytes: 1.5 },
    { allowanceBytes: '5' },
    { allowanceBytes: null },
    { enabled: true },
    { username: 'abcdef' },
  ]) assert.equal(schema.safeParse(bad).success, false, JSON.stringify(bad))
})

test('update_token PATCHes only the fields given, null included, and returns the proxy', async () => {
  const { server, calls } = setup({ responses: [jsonResponse(200, { data: proxy({ label: null, status: 'disabled', disabledReason: 'owner' }) })] })
  const result = await server.call('update_token', { tokenId: 4242, label: null, enabled: false, pool: null, expiresAt: null, allowanceBytes: null })

  assert.equal(calls[0].method, 'PATCH')
  assert.equal(calls[0].url.toString(), `${baseUrl}/api/v1/tokens/4242`)
  assert.deepEqual(calls[0].body, { label: null, enabled: false, pool: null, expiresAt: null, allowanceBytes: null })
  assert.equal(calls[0].headers['Content-Type'], 'application/json')
  assert.equal(payload(result).data.disabledReason, 'owner')
})

test('update_token returns no credential: a label-only change answers without username, password or change-IP link', async () => {
  const answer = proxy({
    label: 'New note',
    expiresAt: '2026-12-31T23:59:59.999Z',
    allowanceBytes: 5_000_000_000,
    allowanceReservedBytes: 12,
    poolSelection: { mode: 'fixed', pool: { authKey: 'residential-main', name: 'Residential' } },
    rotateUrl: 'https://rotate.example.test/ip?k=rotate-secret-key',
    passwordless: 'https://edge.example.test:8000',
    extraSecret: 'future-credential-field',
  })
  const { server, calls } = setup({ responses: [jsonResponse(200, { data: answer })], revealCredentials: true })
  const result = await server.call('update_token', { tokenId: 4242, label: 'New note' })

  assert.deepEqual(calls[0].body, { label: 'New note' })
  assert.equal(result.isError, undefined)
  const text = result.content[0].text
  for (const secret of ['real-secret-password', 'user4242', 'rotate-secret-key', 'rotateUrl', 'password', 'username', 'future-credential-field', 'edge.example.test']) {
    assert.equal(text.includes(secret), false, `${secret} must not be in the update result`)
  }
  assert.deepEqual(payload(result), {
    data: {
      id: 4242,
      type: 'ppg',
      status: 'active',
      disabledReason: null,
      label: 'New note',
      externalRef: 'cust-1',
      createdAt: '2026-11-04T12:00:00.000Z',
      expiresAt: '2026-12-31T23:59:59.999Z',
      allowanceBytes: 5_000_000_000,
      allowanceReservedBytes: 12,
      poolSelection: { mode: 'fixed', pool: { authKey: 'residential-main', name: 'Residential' } },
      packageId: null,
    },
  })
})

test('update_token returns no credential for any change, a package proxy included', async () => {
  const body = { label: 'x', enabled: false, pool: null, expiresAt: null, allowanceBytes: null }
  for (const change of [{ enabled: false }, { allowanceBytes: null }, { pool: 'residential-main' }, { expiresAt: '2026-12-31' }, body]) {
    const { server } = setup({ responses: [jsonResponse(200, { data: proxy({ type: 'unlimited', packageId: 31, ipAuth: { host: 'ip-auth.example.test', port: 5001 } }) })] })
    // eslint-disable-next-line no-await-in-loop
    const result = await server.call('update_token', { tokenId: 4242, ...change })
    assert.doesNotMatch(result.content[0].text, /real-secret-password|user4242|password|username|ip-auth\.example\.test/, JSON.stringify(change))
    assert.equal(payload(result).data.packageId, 31)
  }
})

test('update_token with an answer that has no proxy in it returns an empty data object, not the raw answer', async () => {
  const { server } = setup({ responses: [jsonResponse(200, { password: 'real-secret-password' })] })
  const result = await server.call('update_token', { tokenId: 4242, label: 'x' })
  assert.deepEqual(payload(result), { data: {} })
})

test('update_token sends a single field alone and never the token id in the body', async () => {
  const { server, calls } = setup({ responses: [jsonResponse(200, { data: proxy({ allowanceBytes: 1_000_000_000 }) })] })
  await server.call('update_token', { tokenId: 4242, allowanceBytes: 1_000_000_000 })
  assert.deepEqual(calls[0].body, { allowanceBytes: 1_000_000_000 })
})

test('update_token with nothing to change makes no request', async () => {
  const { server, calls } = setup()
  const result = await server.call('update_token', { tokenId: 4242 })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /at least one of label, enabled, pool, expiresAt or allowanceBytes/)
  assert.equal(calls.length, 0)
})

test('update_token surfaces FIELD_NOT_ALLOWED for a package proxy and INSUFFICIENT_BALANCE for switching on', async () => {
  const first = setup({ responses: [apiError(400, 'FIELD_NOT_ALLOWED', "enabled can't be changed on this proxy. Only the label can.")] })
  const refused = await first.server.call('update_token', { tokenId: 7, enabled: false })
  assert.equal(refused.isError, true)
  assert.match(refused.content[0].text, /FIELD_NOT_ALLOWED/)

  const second = setup({ responses: [apiError(402, 'INSUFFICIENT_BALANCE', 'Top up your balance to create or switch on a pay-per-GB proxy.')] })
  const noBalance = await second.server.call('update_token', { tokenId: 7, enabled: true })
  assert.match(noBalance.content[0].text, /INSUFFICIENT_BALANCE/)

  const third = setup({ responses: [apiError(404, 'TOKEN_NOT_FOUND', 'Token not found.')] })
  assert.match((await third.server.call('update_token', { tokenId: 999, label: 'x' })).content[0].text, /TOKEN_NOT_FOUND/)
})

test('update_token input schema accepts null to clear and refuses wrong types', () => {
  const { server } = setup()
  const schema = z.object(server.tools.get('update_token').config.inputSchema).strict()
  assert.equal(schema.safeParse({ tokenId: 1, label: null, pool: null, expiresAt: null, allowanceBytes: null, enabled: true }).success, true)
  for (const bad of [
    {},
    { tokenId: '1' },
    { tokenId: 1, enabled: null },
    { tokenId: 1, enabled: 'yes' },
    { tokenId: 1, allowanceBytes: 0 },
    { tokenId: 1, label: 'x'.repeat(256) },
    { tokenId: 1, externalRef: 'x' },
  ]) assert.equal(schema.safeParse(bad).success, false, JSON.stringify(bad))
})

test('reissue_credentials without a requestId is a bare POST with no body, and returns the new real password', async () => {
  const { server, calls } = setup({ responses: [jsonResponse(200, { data: proxy({ password: 'brand-new-password' }) })] })
  const result = await server.call('reissue_credentials', { tokenId: 4242 })

  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].url.toString(), `${baseUrl}/api/v1/tokens/4242/credentials`)
  assert.equal(calls[0].rawBody, undefined)
  assert.equal(calls[0].headers['Content-Type'], undefined)
  assert.equal(payload(result).data.password, 'brand-new-password')
})

test('reissue_credentials sends the requestId in a JSON body', async () => {
  const { server, calls } = setup({ responses: [jsonResponse(200, { data: proxy() })] })
  await server.call('reissue_credentials', { tokenId: 4242, requestId: 'reissue-2026-11-04_a' })
  assert.deepEqual(calls[0].body, { requestId: 'reissue-2026-11-04_a' })
  assert.equal(calls[0].headers['Content-Type'], 'application/json')
})

test('reissue_credentials input schema holds the requestId to the API rule', () => {
  const { server } = setup()
  const schema = z.object(server.tools.get('reissue_credentials').config.inputSchema).strict()
  assert.equal(schema.safeParse({ tokenId: 1 }).success, true)
  assert.equal(schema.safeParse({ tokenId: 1, requestId: 'a'.repeat(64) }).success, true)
  for (const bad of [
    { tokenId: 1, requestId: '' },
    { tokenId: 1, requestId: 'a'.repeat(65) },
    { tokenId: 1, requestId: 'has space' },
    { tokenId: 1, requestId: 'a/b' },
    { tokenId: 1, requestId: 7 },
    { tokenId: 1, password: 'x' },
  ]) assert.equal(schema.safeParse(bad).success, false, JSON.stringify(bad))
})

test('reissue_credentials surfaces INVALID_REQUEST_ID, CONCURRENT_CHANGE and an unknown proxy', async () => {
  for (const [status, code] of [[400, 'INVALID_REQUEST_ID'], [409, 'CONCURRENT_CHANGE'], [404, 'TOKEN_NOT_FOUND']]) {
    const { server } = setup({ responses: [apiError(status, code, 'Nope.')] })
    // eslint-disable-next-line no-await-in-loop
    const result = await server.call('reissue_credentials', { tokenId: 1 })
    assert.equal(result.isError, true, code)
    assert.match(result.content[0].text, new RegExp(code))
  }
})

test('delete_token sends DELETE and answers that the proxy is deleted, though the API sends no body', async () => {
  const { server, calls } = setup({ responses: [noContent] })
  const result = await server.call('delete_token', { tokenId: 4242 })

  assert.equal(calls[0].method, 'DELETE')
  assert.equal(calls[0].url.toString(), `${baseUrl}/api/v1/tokens/4242`)
  assert.equal(calls[0].rawBody, undefined)
  assert.equal(result.isError, undefined)
  assert.deepEqual(payload(result), { tokenId: 4242, deleted: true })
})

test('delete_token returns no credential even if the API sent a body', async () => {
  const { server } = setup({ responses: [jsonResponse(200, { data: proxy() })] })
  const result = await server.call('delete_token', { tokenId: 4242 })
  assert.deepEqual(payload(result), { tokenId: 4242, deleted: true })
  assert.doesNotMatch(result.content[0].text, /real-secret-password|user4242|password|username/)
})

test('create_token and reissue_credentials say they return credentials by design; update_token and delete_token say they never do', () => {
  const { server } = setup()
  const description = name => server.tools.get(name).config.description
  assert.match(description('create_token'), /real username and password/)
  assert.match(description('create_token'), /returns credentials by design/)
  assert.match(description('reissue_credentials'), /returns credentials by design/)
  assert.match(description('update_token'), /never its\s+username, password or change-IP link/)
  assert.match(description('update_token'), /get_token_credentials/)
  assert.match(description('delete_token'), /never credentials/)
})

test('delete_token surfaces NOT_SUPPORTED for a package proxy and TOKEN_NOT_FOUND', async () => {
  const notSupported = setup({ responses: [apiError(409, 'NOT_SUPPORTED', "Only pay-per-GB proxies can be deleted. A package's proxies end with the package.")] })
  const refused = await notSupported.server.call('delete_token', { tokenId: 12 })
  assert.equal(refused.isError, true)
  assert.match(refused.content[0].text, /NOT_SUPPORTED/)
  assert.equal(refused.content[0].text.includes('deleted: true'), false)

  const missing = setup({ responses: [apiError(404, 'TOKEN_NOT_FOUND', 'Token not found.')] })
  assert.match((await missing.server.call('delete_token', { tokenId: 13 })).content[0].text, /TOKEN_NOT_FOUND/)
})

test('a 503 on a write carries Retry-After to the model', async () => {
  const { server } = setup({
    responses: [jsonResponse(503, { error: { code: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable.', requestId: 'req_2', docsUrl: 'https://litport.net/docs/api/errors#service-unavailable' } }, { 'Retry-After': '60' })],
  })
  const result = await server.call('create_token', { externalRef: 'cust-9' })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /SERVICE_UNAVAILABLE/)
  assert.match(result.content[0].text, /Retry-After: 60s/)
})

test('an API error shows the API\'s retryable verdict, true or false, and leaves it out when the API sent none', async () => {
  const cases = [
    [429, 'RATE_LIMITED', 'Too many proxies were created in the last minute. Wait a moment and try again.', { retryable: true }, /\| code: RATE_LIMITED \| retryable: true \|/],
    [503, 'SERVICE_UNAVAILABLE', 'Service temporarily unavailable.', { retryable: false }, /\| code: SERVICE_UNAVAILABLE \| retryable: false \|/],
    [400, 'INVALID_POOL', 'pool is invalid.', { retryable: false }, /\| retryable: false \|/],
  ]
  for (const [status, code, message, extra, pattern] of cases) {
    const { server } = setup({ responses: [apiError(status, code, message, extra)] })
    // eslint-disable-next-line no-await-in-loop
    const result = await server.call('create_token', { externalRef: 'cust-9' })
    assert.equal(result.isError, true, code)
    assert.match(result.content[0].text, pattern, code)
  }
  const { server } = setup({ responses: [apiError(400, 'INVALID_POOL', 'pool is invalid.')] })
  assert.doesNotMatch((await server.call('create_token', {})).content[0].text, /retryable/)
  const { server: strange } = setup({ responses: [apiError(400, 'INVALID_POOL', 'pool is invalid.', { retryable: 'yes' })] })
  assert.doesNotMatch((await strange.call('create_token', {})).content[0].text, /retryable/)
})

test('create_token says an account can create only so many proxies a minute, and that past it the answer is 429 with Retry-After', async () => {
  const { server } = setup()
  assert.match(server.tools.get('create_token').config.description, /limited\s+per account per minute/)
  assert.match(server.tools.get('create_token').config.description, /429 RATE_LIMITED with a Retry-After/)
  const { server: limited } = setup({
    responses: [jsonResponse(429, { error: { code: 'RATE_LIMITED', message: 'Too many proxies were created in the last minute. Wait a moment and try again.', requestId: 'req_3', docsUrl: 'https://litport.net/docs/api/errors#rate-limited', retryable: true } }, { 'Retry-After': '41' })],
  })
  const result = await limited.call('create_token', { externalRef: 'cust-9' })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /RATE_LIMITED \| retryable: true \| Retry-After: 41s/)
})

test('a real MCP server lists the new tools with valid schemas and runs update_token with null end to end', async () => {
  const { calls, fetchImpl } = setup({ responses: [jsonResponse(200, { data: proxy({ expiresAt: null }) }), noContent, jsonResponse(201, { data: proxy() })] })
  const server = new McpServer({ name: 'litport', version: '0' })
  registerTools(server, { client: createClient({ apiKey: validKey, baseUrl, fetchImpl }), config: { apiKey: validKey, baseUrl, revealCredentials: false }, fetchImpl })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  try {
    const { tools } = await client.listTools()
    const byName = new Map(tools.map(tool => [tool.name, tool]))
    for (const name of [...WRITE_TOOLS, 'get_usage']) assert.ok(byName.has(name), name)
    assert.deepEqual(byName.get('update_token').inputSchema.required, ['tokenId'])
    assert.deepEqual(byName.get('reissue_credentials').inputSchema.required, ['tokenId'])
    assert.deepEqual(byName.get('create_token').inputSchema.required ?? [], [])
    assert.deepEqual(byName.get('update_token').inputSchema.properties.expiresAt.type ?? byName.get('update_token').inputSchema.properties.expiresAt.anyOf?.map(item => item.type), ['string', 'null'])

    const updated = await client.callTool({ name: 'update_token', arguments: { tokenId: 4242, expiresAt: null } })
    assert.equal(updated.isError, undefined)
    assert.deepEqual(calls[0].body, { expiresAt: null })

    const deleted = await client.callTool({ name: 'delete_token', arguments: { tokenId: 4242 } })
    assert.deepEqual(JSON.parse(deleted.content[0].text), { tokenId: 4242, deleted: true })

    const created = await client.callTool({ name: 'create_token', arguments: { externalRef: 'cust-1' } })
    assert.equal(JSON.parse(created.content[0].text).data.password, 'real-secret-password')

    // a value the schema refuses never reaches the API
    const before = calls.length
    const refused = await client.callTool({ name: 'create_token', arguments: { allowanceBytes: 0 } })
    assert.equal(refused.isError, true)
    assert.equal(calls.length, before)
  } finally {
    await client.close()
    await server.close()
  }
})
