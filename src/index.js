#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { createClient } from './client.js'
import { ConfigError, loadConfig } from './config.js'
import { registerTools } from './tools/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(path.join(here, '../package.json'), 'utf8'))

const main = async () => {
  let config
  try {
    config = loadConfig()
  } catch (err) {
    if (err instanceof ConfigError) {
      // The protocol lives on stdout — a config error must never write there, or a client would try
      // to parse it as a JSON-RPC message.
      process.stderr.write(`${err.message}\n`)
      process.exit(1)
      return
    }
    throw err
  }

  const client = createClient({ apiKey: config.apiKey, baseUrl: config.baseUrl })
  const server = new McpServer({ name: 'litport', version: pkg.version })
  registerTools(server, { client, config })

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(err => {
  process.stderr.write(`${err?.stack || err}\n`)
  process.exit(1)
})
