import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { z } from 'zod'

import { createClient } from '../src/client.js'
import { registerTools } from '../src/tools/index.js'
import { createFakeServer, jsonResponse } from './helpers.js'

const baseUrl = 'https://litport.test'

const usagePage = (overrides = {}) => ({
  data: {
    range: { from: '2026-10-05T00:00:00.000Z', to: '2026-11-04T00:00:00.000Z', groupBy: 'day', timezone: 'UTC' },
    tokens: [
      {
        tokenId: 4242,
        type: 'ppg',
        deleted: false,
        label: 'Acme',
        externalRef: 'cust-1',
        trafficBasis: 'customer_chargeable',
        summary: { requests: 10, uploadedBytes: '100', downloadedBytes: '900', totalBytes: '1000', costUnits: '0.0045' },
        buckets: [{
          start: '2026-11-01T00:00:00.000Z', end: '2026-11-02T00:00:00.000Z', requests: 10, uploadedBytes: '100', downloadedBytes: '900', totalBytes: '1000', costUnits: '0.0045',
        }],
      },
      {
        tokenId: 4100,
        type: 'ppg',
        deleted: true,
        label: null,
        externalRef: 'cust-0',
        trafficBasis: 'customer_chargeable',
        summary: { requests: 0, uploadedBytes: '0', downloadedBytes: '0', totalBytes: '0', costUnits: '0' },
        buckets: [],
      },
    ],
    ...overrides,
  },
  page: { nextCursor: 'cursor-2' },
})

const setup = ({ response = jsonResponse(200, usagePage()) } = {}) => {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: new URL(url), method: options.method || 'GET', rawBody: options.body })
    return response
  }
  const server = createFakeServer()
  const client = createClient({ apiKey: 'lit_test', baseUrl, fetchImpl })
  registerTools(server, { client, config: { apiKey: 'lit_test', baseUrl, revealCredentials: false }, fetchImpl })
  return { server, calls }
}

test('get_usage reads GET /usage with the range, ids, limit and cursor, and returns the page as the API sent it', async () => {
  const { server, calls } = setup()
  const result = await server.call('get_usage', {
    from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z', tokenIds: [4242, 4100, 77], limit: 20, cursor: 'cursor-1',
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].rawBody, undefined)
  assert.equal(calls[0].url.pathname, '/api/v1/usage')
  assert.equal(calls[0].url.searchParams.get('from'), '2026-10-01T00:00:00Z')
  assert.equal(calls[0].url.searchParams.get('to'), '2026-11-01T00:00:00Z')
  assert.equal(calls[0].url.searchParams.get('tokenIds'), '4242,4100,77')
  assert.equal(calls[0].url.searchParams.get('limit'), '20')
  assert.equal(calls[0].url.searchParams.get('cursor'), 'cursor-1')

  const body = JSON.parse(result.content[0].text)
  assert.equal(body.data.tokens.length, 2)
  assert.equal(body.data.tokens[0].buckets[0].costUnits, '0.0045')
  assert.equal(body.data.tokens[1].deleted, true)
  assert.equal(body.page.nextCursor, 'cursor-2')
})

test('get_usage with no arguments asks for the default page: no range, no ids, 50 proxies', async () => {
  const { server, calls } = setup()
  await server.call('get_usage', {})
  const params = [...calls[0].url.searchParams.keys()]
  assert.deepEqual(params, ['limit'])
  assert.equal(calls[0].url.searchParams.get('limit'), '50')
})

test('get_usage surfaces INVALID_TOKEN_IDS, INVALID_TIME_RANGE and INVALID_CURSOR', async () => {
  for (const code of ['INVALID_TOKEN_IDS', 'INVALID_TIME_RANGE', 'INVALID_CURSOR']) {
    const { server } = setup({ response: jsonResponse(400, { error: { code, message: 'Bad.', requestId: 'req_1', docsUrl: 'https://litport.net/docs/api/errors' } }) })
    // eslint-disable-next-line no-await-in-loop
    const result = await server.call('get_usage', { tokenIds: [1] })
    assert.equal(result.isError, true, code)
    assert.match(result.content[0].text, new RegExp(code))
  }
})

test('get_usage is a read: annotated read-only, and its description names the deleted-proxy and costUnits rules', () => {
  const { server } = setup()
  const tool = server.tools.get('get_usage')
  assert.deepEqual(tool.config.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true })
  assert.match(tool.config.description, /including deleted proxies/)
  assert.match(tool.config.description, /only when its id is in\s+tokenIds/)
  assert.match(tool.config.description, /costUnits/)
  assert.match(tool.config.description, /null for a package proxy/)
  assert.match(tool.config.description, /at\s+most 92 days/)
  assert.match(tool.config.description, /10 of these calls per minute/)
})

test('get_usage input schema: at most 100 ids, positive integers, a page of 1 to 100', () => {
  const { server } = setup()
  const schema = z.object(server.tools.get('get_usage').config.inputSchema).strict()
  assert.equal(schema.safeParse({}).success, true)
  assert.equal(schema.safeParse({ tokenIds: Array.from({ length: 100 }, (_, index) => index + 1), limit: 100 }).success, true)
  for (const bad of [
    { tokenIds: [] },
    { tokenIds: Array.from({ length: 101 }, (_, index) => index + 1) },
    { tokenIds: [0] },
    { tokenIds: [1.5] },
    { tokenIds: '1,2' },
    { limit: 0 },
    { limit: 101 },
    { groupBy: 'hour' },
  ]) assert.equal(schema.safeParse(bad).success, false, JSON.stringify(bad))
})

test('the package, server.json and its npm entry carry one version, so a release cannot ship them out of step', () => {
  const read = file => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))
  const pkg = read('package.json')
  const server = read('server.json')
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
  assert.equal(server.version, pkg.version)
  assert.equal(server.packages[0].version, pkg.version)
  assert.equal(server.packages[0].identifier, pkg.name)
})
