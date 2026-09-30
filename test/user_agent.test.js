import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { createClient, userAgentFor } from '../src/client.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('every API request identifies the package and its version', async () => {
  const seen = []
  const client = createClient({
    apiKey: 'lit_x',
    baseUrl: 'https://litport.net',
    userAgent: userAgentFor(pkg.version),
    fetchImpl: async (url, options) => { seen.push(options.headers); return { ok: true, json: async () => ({ data: [] }) } },
  })
  await client.get('/tokens')
  await client.get('/pools')
  assert.equal(seen.length, 2)
  for (const headers of seen) {
    assert.equal(headers['User-Agent'], `litport-mcp/${pkg.version}`)
  }
})

test('the user agent tracks the published version rather than a hardcoded string', () => {
  assert.equal(userAgentFor(pkg.version), `litport-mcp/${pkg.version}`)
  assert.match(userAgentFor('9.9.9'), /^litport-mcp\/9\.9\.9$/)
})

test('the user agent carries no account or host information', () => {
  const agent = userAgentFor(pkg.version)
  assert.doesNotMatch(agent, /lit_|ltp_/, 'must never embed an API key')
  assert.equal(agent.includes('@'), false)
  assert.ok(agent.length < 40, 'stays short enough to store without truncation')
})
