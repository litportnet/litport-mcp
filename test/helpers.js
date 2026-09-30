// Shared test scaffolding: a fake McpServer that just records registered tools, and a fake fetch
// that answers from an in-memory route table so no test ever touches the network.
export const createFakeServer = () => {
  const tools = new Map()
  return {
    tools,
    registerTool: (name, config, handler) => {
      tools.set(name, { config, handler })
    },
    call: (name, args) => tools.get(name).handler(args),
  }
}

// routes: Map or object keyed by "METHOD path" (path includes querystring-free /api/v1 prefix as
// produced by client.js's buildUrl) -> (url) => Response-shaped object, or a plain object treated as
// a 200 JSON body.
export const createFakeFetch = routes => async (url, options) => {
  const key = url.toString()
  for (const [pattern, respond] of routes) {
    if (typeof pattern === 'string' ? key.startsWith(pattern) : pattern.test(key)) {
      const result = typeof respond === 'function' ? respond(url, options) : respond
      if (result && typeof result.ok === 'boolean') return result
      return {
        ok: true,
        status: 200,
        json: async () => result,
        text: async () => JSON.stringify(result),
      }
    }
  }
  throw new Error(`No fake route matches ${key}`)
}

// `headers` is optional and only needed by a test that checks a header client.js reads off the raw
// response (e.g. Retry-After) -- every existing two-argument call site is unaffected.
export const jsonResponse = (status, body, headers = {}) => {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => normalized[String(name).toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

export const textResponse = (status, text) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => { throw new Error('not json') },
  text: async () => text,
})
