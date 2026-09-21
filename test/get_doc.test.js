import assert from 'node:assert/strict'
import test from 'node:test'

import { registerTools } from '../src/tools/index.js'
import { createFakeServer, textResponse } from './helpers.js'

const baseUrl = 'https://litport.test'

const setup = ({ fetchImpl } = {}) => {
  const server = createFakeServer()
  const client = { get: async () => { throw new Error('unexpected API call') } }
  const config = { apiKey: 'lit_test', baseUrl, revealCredentials: false }
  registerTools(server, { client, config, fetchImpl })
  return server
}

test('rejects an off-origin URL without fetching it', async () => {
  const server = setup({ fetchImpl: async () => { throw new Error('must not fetch') } })
  const result = await server.call('get_doc', { url: 'https://evil.example.com/docs/api/tokens' })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /outside/)
})

test('fetches a bare slug as markdown under /docs', async () => {
  let requestedUrl
  const fetchImpl = async url => {
    requestedUrl = url.toString()
    return textResponse(200, '# Tokens API\n\n...')
  }
  const server = setup({ fetchImpl })
  const result = await server.call('get_doc', { url: 'api/tokens' })
  assert.equal(result.isError, undefined)
  assert.equal(requestedUrl, `${baseUrl}/docs/api/tokens.md`)
  assert.match(result.content[0].text, /Tokens API/)
})

test('fetches a full URL as-is when it already has an extension', async () => {
  let requestedUrl
  const fetchImpl = async url => {
    requestedUrl = url.toString()
    return textResponse(200, '# Pools API')
  }
  const server = setup({ fetchImpl })
  await server.call('get_doc', { url: `${baseUrl}/docs/api/pools.md` })
  assert.equal(requestedUrl, `${baseUrl}/docs/api/pools.md`)
})
