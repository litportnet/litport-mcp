import { z } from 'zod'

import { ApiError } from '../client.js'
import { ppgParameters, proxyErrors, socksReplies } from '../contracts.generated.js'

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

const jsonResult = payload => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
})

// explain_proxy_error and build_proxy_url return readable prose plus the JSON payload, still as a
// single text block — the MCP content array stays one item, just with prose ahead of the JSON.
const textAndJsonResult = (text, payload) => ({
  content: [{ type: 'text', text: `${text}\n\n${JSON.stringify(payload, null, 2)}` }],
})

const errorResult = text => ({
  isError: true,
  content: [{ type: 'text', text }],
})

// The API's error message/code/docsUrl are customer-safe by design (see client.js) — surface them
// verbatim so the model can explain the failure and, where a docsUrl exists, point the user at it.
const apiErrorResult = error => {
  const parts = [error.message || 'The Litport API request failed.']
  if (error.code) parts.push(`code: ${error.code}`)
  if (error.docsUrl) parts.push(`docs: ${error.docsUrl}`)
  return errorResult(parts.join(' | '))
}

const withApiErrorHandling = handler => async (...args) => {
  try {
    return await handler(...args)
  } catch (err) {
    if (err instanceof ApiError) return apiErrorResult(err)
    throw err
  }
}

const annotations = openWorldHint => ({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint,
})

// ---------------------------------------------------------------------------
// Credential masking (list_tokens)
// ---------------------------------------------------------------------------

// The model must never conclude a masked password is unreachable — it always has a specific,
// single-token escape hatch.
const MASK_HINT = 'Passwords are masked in this listing. Call get_token_credentials with a tokenId, '
  + 'or build_proxy_url, to get the real password for a specific token.'

const maskToken = token => {
  const { password: _password, ...rest } = token
  return { ...rest, password: null, passwordSet: true }
}

// ---------------------------------------------------------------------------
// build_proxy_url helpers
// ---------------------------------------------------------------------------

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SID_RE = /^[A-Za-z0-9-]{3,15}$/
const SESSION_ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

// Matches the dashboard's generateSessionId in web/app/views/users/ports.pug.
const randomSessionId = (length = 10) => {
  let result = ''
  for (let i = 0; i < length; i++) {
    result += SESSION_ID_CHARS.charAt(Math.floor(Math.random() * SESSION_ID_CHARS.length))
  }
  return result
}

const normalizeCountry = value => {
  const lower = value.toLowerCase()
  return lower === 'uk' ? 'gb' : lower
}

const paramRule = name => ppgParameters.find(param => param.name === name)?.rules

const validateSlug = (name, value) => {
  if (value.length > 80 || !SLUG_RE.test(value)) {
    const rule = paramRule(name)
    return `${name} must be a lowercase slug of letters, digits, and hyphens (max 80 characters); got "${value}".${rule ? ` (${rule})` : ''}`
  }
  return null
}

const validateProxyUrlParams = ({ pool, country, region, city, sid, sttl }) => {
  const errors = []
  if (pool != null) {
    const err = validateSlug('pool', pool)
    if (err) errors.push(err)
  }
  if (country != null) {
    const err = validateSlug('country', country)
    if (err) errors.push(err)
  }
  if (region != null) {
    const err = validateSlug('region', region)
    if (err) errors.push(err)
  }
  if (city != null) {
    const err = validateSlug('city', city)
    if (err) errors.push(err)
  }
  if (sid != null && !SID_RE.test(sid)) {
    errors.push(`sid must be 3-15 characters of letters, numbers, and hyphens; got "${sid}". (${paramRule('sid')})`)
  }
  if (sttl != null && (!Number.isInteger(sttl) || sttl < 1 || sttl > 86400)) {
    errors.push(`sttl must be an integer between 1 and 86400 seconds; got ${sttl}. (${paramRule('sttl')})`)
  }
  return errors
}

// ---------------------------------------------------------------------------
// registerTools
// ---------------------------------------------------------------------------

export const registerTools = (server, { client, config, fetchImpl = fetch }) => {
  server.registerTool('list_tokens', {
    description: 'List the account\'s proxy tokens (PPG and unlimited), paginated by cursor. Passwords '
      + 'are masked unless the server is configured with LITPORT_MCP_REVEAL_CREDENTIALS=1.',
    inputSchema: {
      limit: z.number().int().min(1).max(100).default(50),
      cursor: z.string().optional(),
      type: z.enum(['ppg', 'unlimited']).optional(),
      status: z.enum(['active', 'expired', 'disabled']).optional(),
    },
    annotations: annotations(true),
  }, withApiErrorHandling(async ({ limit = 50, cursor, type, status }) => {
    const response = await client.get('/tokens', { limit, cursor, type, status })
    const data = response.data.map(token => (config.revealCredentials ? token : maskToken(token)))
    const payload = { ...response, data }
    if (!config.revealCredentials) payload.hint = MASK_HINT
    return jsonResult(payload)
  }))

  server.registerTool('get_token_credentials', {
    description: 'Get a single token by id, including its real username and password. This is the '
      + 'single-token escape hatch when list_tokens has masked the password.',
    inputSchema: {
      tokenId: z.number().int().describe('The numeric token id, e.g. from list_tokens.'),
    },
    annotations: annotations(true),
  }, withApiErrorHandling(async ({ tokenId }) => {
    const response = await client.get(`/tokens/${tokenId}`)
    return jsonResult(response)
  }))

  server.registerTool('get_token_usage', {
    description: 'Get bandwidth usage for a token over a time range, optionally broken down by domain '
      + 'and/or per-hour charges.',
    inputSchema: {
      tokenId: z.number().int(),
      from: z.string().optional().describe('ISO-8601 start timestamp.'),
      to: z.string().optional().describe('ISO-8601 end timestamp.'),
      groupBy: z.enum(['hour', 'day', 'month']).default('day'),
      includeDomains: z.boolean().optional(),
      includeCharges: z.boolean().optional().describe('Requires groupBy: "hour".'),
    },
    annotations: annotations(true),
  }, withApiErrorHandling(async ({ tokenId, from, to, groupBy = 'day', includeDomains, includeCharges }) => {
    if (includeCharges && groupBy !== 'hour') {
      return errorResult(`includeCharges requires groupBy: "hour" (got "${groupBy}"). Call again with `
        + 'groupBy set to "hour", or drop includeCharges.')
    }
    const includeParts = []
    if (includeDomains) includeParts.push('domains')
    if (includeCharges) includeParts.push('charges')
    const response = await client.get(`/tokens/${tokenId}/usage`, {
      from,
      to,
      groupBy,
      include: includeParts.length ? includeParts.join(',') : undefined,
    })
    return jsonResult(response)
  }))

  server.registerTool('list_pools', {
    description: 'List the PPG pools available to this account, and the hubs they can connect through.',
    annotations: annotations(true),
  }, withApiErrorHandling(async () => {
    const response = await client.get('/pools')
    return jsonResult(response)
  }))

  server.registerTool('list_targeting_options', {
    description: 'List available geo-targeting options (countries, regions, or cities) for one or more '
      + 'pools.',
    inputSchema: {
      pool: z.string().describe('Comma-separated pool authKeys.'),
      level: z.enum(['country', 'region', 'city']),
      country: z.string().optional(),
      region: z.string().optional(),
      q: z.string().optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    annotations: annotations(true),
  }, withApiErrorHandling(async ({ pool, level, country, region, q, offset, limit }) => {
    if (level === 'region' && !country) {
      return errorResult('level: "region" requires a "country" argument.')
    }
    if (level === 'city' && (!country || !region)) {
      return errorResult('level: "city" requires both "country" and "region" arguments.')
    }
    const response = await client.get('/geo', { pool, level, country, region, q, offset, limit })
    return jsonResult(response)
  }))

  server.registerTool('get_account', {
    description: 'Get the account\'s balance and plan.',
    annotations: annotations(true),
  }, withApiErrorHandling(async () => {
    const response = await client.get('/account')
    return jsonResult(response)
  }))

  server.registerTool('explain_proxy_error', {
    description: 'Look up what an X-Proxy-Error-Code or SOCKS5 reply means, whether to retry, and what '
      + 'action to take. Purely local — makes no API call.',
    inputSchema: {
      code: z.number().int().optional().describe('The numeric X-Proxy-Error-Code.'),
      message: z.string().optional().describe('A wire message, error symbol, or SOCKS5 reply (e.g. "0x01") to search for.'),
    },
    annotations: annotations(false),
  }, async ({ code, message }) => {
    if (code == null && (message == null || message === '')) {
      const codes = proxyErrors.map(error => error.code)
      return errorResult(`Provide a numeric "code" or a "message" to look up. Valid X-Proxy-Error-Code `
        + `values range from ${Math.min(...codes)} to ${Math.max(...codes)}.`)
    }

    let match = code != null ? proxyErrors.find(error => error.code === code) : null
    if (!match && message) {
      const needle = message.trim().toLowerCase()
      match = proxyErrors.find(error => (error.message && error.message.toLowerCase().includes(needle))
        || error.symbol.toLowerCase().includes(needle))
    }

    const socksNeedle = message != null ? message.trim() : null
    const looksLikeSocksReply = socksNeedle != null && /^0x[0-9a-f]{1,2}$/i.test(socksNeedle)
    const socksMatch = looksLikeSocksReply
      ? socksReplies.find(reply => reply.reply.toLowerCase() === socksNeedle.toLowerCase())
      : null

    if (!match && !socksMatch) {
      const codes = proxyErrors.map(error => error.code)
      return errorResult(
        `No matching proxy error or SOCKS5 reply found for ${code != null ? `code ${code}` : `message "${message}"`}. `
        + `Valid X-Proxy-Error-Code values range from ${Math.min(...codes)} to ${Math.max(...codes)}. `
        + `Valid SOCKS5 replies: ${socksReplies.map(reply => reply.reply).join(', ')}.`,
      )
    }

    const lines = []
    if (match) {
      lines.push(`${match.symbol} (code ${match.code}): ${match.message || '(no wire message)'}`)
      lines.push(`Retry: ${match.retry}`)
      lines.push(`Action: ${match.action}`)
    }
    if (socksMatch) {
      lines.push(`SOCKS5 reply ${socksMatch.reply}: ${socksMatch.meaning} (${socksMatch.categories})`)
    }
    return textAndJsonResult(lines.join('\n'), { proxyError: match || null, socksReply: socksMatch || null })
  })

  server.registerTool('build_proxy_url', {
    description: 'Build a ready-to-use proxy connection URL for a token, with optional pool/geo/session '
      + 'targeting. Replicates the dashboard\'s export format exactly.',
    inputSchema: {
      tokenId: z.number().int(),
      pool: z.string().optional().describe('Pool authKey. Required for tokens not fixed to a pool.'),
      country: z.string().optional(),
      region: z.string().optional(),
      city: z.string().optional(),
      sid: z.string().optional().describe('Session id, 3-15 chars of letters/numbers/hyphens.'),
      sttl: z.number().int().optional().describe('Session TTL in seconds, 1-86400.'),
      hub: z.string().optional().describe('Hub id. Defaults to the token\'s assigned hub.'),
      protocol: z.enum(['http', 'https', 'socks5']).optional().describe('Defaults to the token\'s ingress protocol.'),
      credentialStyle: z.enum(['inline', 'env']).default('inline'),
      count: z.number().int().min(1).max(50).default(1),
    },
    annotations: annotations(true),
  }, withApiErrorHandling(async ({ tokenId, pool, country, region, city, sid, sttl, hub, protocol, credentialStyle = 'inline', count = 1 }) => {
    const normalizedCountry = country != null ? normalizeCountry(country) : undefined
    const normalizedRegion = region != null ? region.toLowerCase() : undefined
    const normalizedCity = city != null ? city.toLowerCase() : undefined

    const validationErrors = validateProxyUrlParams({
      pool, country: normalizedCountry, region: normalizedRegion, city: normalizedCity, sid, sttl,
    })
    if (validationErrors.length > 0) return errorResult(validationErrors.join(' '))

    const [tokenResponse, poolsResponse] = await Promise.all([
      client.get(`/tokens/${tokenId}`),
      client.get('/pools'),
    ])
    const token = tokenResponse.data
    const { pools, hubs } = poolsResponse.data

    // An unlimited token is assigned exactly one endpoint, which the API now resolves for us. It has
    // no pool, and pool/geo/session selectors are PPG features, so accepting them here would build a
    // username the proxy rejects.
    if (token.type !== 'ppg') {
      const ingress = token.ingress || {}
      if (ingress.mode !== 'assigned') {
        return errorResult(`Token ${tokenId} is type "${token.type}" with no assigned endpoint; a proxy URL cannot be built for it.`)
      }
      if (ingress.status === 'hub-unavailable' || !ingress.host || !ingress.port) {
        return errorResult(`Token ${tokenId} is assigned to hub "${ingress.hub}", which is no longer in service, so it has no usable endpoint. Contact support to move the token to a current hub.`)
      }
      const rejected = Object.entries({ pool, country, region, city, sid, sttl })
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([name]) => name)
      if (rejected.length > 0) {
        return errorResult(`Token ${tokenId} is an unlimited token, which connects to one assigned endpoint. `
          + `Pool, geo and session selectors (${rejected.join(', ')}) are pay-per-GB parameters and are not supported on it.`)
      }
      if (hub && hub !== ingress.hub) {
        return errorResult(`Token ${tokenId} is assigned to hub "${ingress.hub}" and cannot be moved to "${hub}" from here.`)
      }
      if (protocol && protocol !== ingress.protocol) {
        return errorResult(`Token ${tokenId} is assigned the "${ingress.protocol}" ingress; its port is tied to that protocol, so "${protocol}" cannot be selected from here.`)
      }
      const assignedPassword = credentialStyle === 'env' ? '$LITPORT_PROXY_PASSWORD' : token.password
      const assignedUrl = `${ingress.protocol}://${token.username}:${assignedPassword}@${ingress.host}:${ingress.port}`
      return textAndJsonResult(assignedUrl, {
        urls: Array.from({ length: count }, () => assignedUrl),
        username: token.username,
        pool: null,
        hub: { id: ingress.hub, hostname: ingress.host },
        protocol: ingress.protocol,
        pricePerGb: null,
        ...(credentialStyle === 'env' ? { password: token.password, note: 'Export LITPORT_PROXY_PASSWORD with this value; it is not embedded in the URL.' } : {}),
      })
    }

    if (!token.poolSelection) {
      return errorResult(`Token ${tokenId} is a ppg token with no pool selection information; a proxy URL cannot be built for it.`)
    }

    let resolvedPoolAuthKey
    let appendPoolSegment
    if (token.poolSelection.mode === 'fixed') {
      const fixedPool = token.poolSelection.pool
      if (!fixedPool) {
        return errorResult(`Token ${tokenId}'s assigned pool is not exposed by the API; a proxy URL cannot be built for it.`)
      }
      if (pool && pool !== fixedPool.authKey) {
        return errorResult(`Token ${tokenId} is fixed to pool "${fixedPool.authKey}" and rejects a conflicting pool argument ("${pool}").`)
      }
      resolvedPoolAuthKey = fixedPool.authKey
      appendPoolSegment = false
    } else {
      if (!pool) {
        return errorResult(`Token ${tokenId} is not fixed to a pool; specify "pool" — the pool determines `
          + `the price. Available pools: ${pools.map(p => p.authKey).join(', ')}.`)
      }
      resolvedPoolAuthKey = pool
      appendPoolSegment = true
    }

    const poolRecord = pools.find(p => p.authKey === resolvedPoolAuthKey)
    if (!poolRecord) {
      return errorResult(`Pool "${resolvedPoolAuthKey}" was not found. Available pools: ${pools.map(p => p.authKey).join(', ')}.`)
    }

    const hubId = hub || token.ingress.hub
    if (!hubId) {
      return errorResult(`Token ${tokenId} has no assigned hub; specify "hub".`)
    }
    const hubRecord = hubs.find(h => h.id === hubId)
    if (!hubRecord) {
      return errorResult(`Hub "${hubId}" was not found. Available hubs: ${hubs.map(h => h.id).join(', ')}.`)
    }
    if (Array.isArray(poolRecord.eligibleHubIds) && !poolRecord.eligibleHubIds.includes(hubRecord.id)) {
      const eligible = hubs.filter(h => poolRecord.eligibleHubIds.includes(h.id)).map(h => h.id)
      return errorResult(`Pool "${poolRecord.authKey}" is not eligible for hub "${hubRecord.id}". Eligible hubs: ${eligible.join(', ')}.`)
    }

    const resolvedProtocol = protocol || token.ingress.protocol
    if (!['http', 'https', 'socks5'].includes(resolvedProtocol)) {
      return errorResult(`Unsupported protocol "${resolvedProtocol}".`)
    }
    const port = resolvedProtocol === 'socks5' ? poolRecord.socks5Port : poolRecord.httpPort
    const host = `${hubRecord.hostname}:${port}`

    const usernames = []
    const urls = []
    for (let i = 0; i < count; i++) {
      // Only generate a session id automatically when sttl was requested but sid was not — an explicit
      // sid is reused verbatim across every generated URL, matching what the caller asked for.
      const effectiveSid = sid ?? (sttl != null ? randomSessionId(10) : undefined)
      const segments = [token.username]
      if (appendPoolSegment) segments.push(`pool-${resolvedPoolAuthKey}`)
      if (normalizedCountry) segments.push(`country-${normalizedCountry}`)
      if (normalizedRegion) segments.push(`region-${normalizedRegion}`)
      if (normalizedCity) segments.push(`city-${normalizedCity}`)
      if (sttl != null) segments.push(`sttl-${sttl}`)
      if (effectiveSid) segments.push(`sid-${effectiveSid}`)
      const username = segments.join('_')
      usernames.push(username)
      const password = credentialStyle === 'env' ? '$LITPORT_PROXY_PASSWORD' : token.password
      urls.push(`${resolvedProtocol}://${username}:${password}@${host}`)
    }

    const payload = {
      urls,
      username: usernames[0],
      ...(count > 1 ? { usernames } : {}),
      pool: { authKey: poolRecord.authKey, name: poolRecord.name, pricePerGb: poolRecord.pricePerGb },
      hub: { id: hubRecord.id, name: hubRecord.name, hostname: hubRecord.hostname },
      protocol: resolvedProtocol,
      pricePerGb: poolRecord.pricePerGb,
    }
    if (credentialStyle === 'env') {
      payload.password = token.password
      payload.note = 'Export LITPORT_PROXY_PASSWORD before use — the real password is in this payload\'s '
        + '"password" field, not embedded in the URLs above.'
    }

    return textAndJsonResult(urls.join('\n'), payload)
  }))

  server.registerTool('search_docs', {
    description: 'Search the Litport documentation index (llms.txt) for pages matching a query.',
    inputSchema: {
      query: z.string(),
      limit: z.number().int().min(1).default(5),
    },
    annotations: annotations(true),
  }, async ({ query, limit = 5 }) => {
    let text
    try {
      const response = await fetchImpl(`${config.baseUrl}/llms.txt`)
      if (!response.ok) return errorResult(`Could not fetch the documentation index (HTTP ${response.status}).`)
      text = await response.text()
    } catch (cause) {
      return errorResult(`Could not fetch the documentation index: ${cause.message}`)
    }

    const entries = []
    const lineRe = /^-\s*\[([^\]]+)\]\(([^)]+)\)(?::\s*(.*))?$/
    for (const rawLine of text.split('\n')) {
      const match = lineRe.exec(rawLine.trim())
      if (match) entries.push({ title: match[1], url: match[2], description: match[3] || '' })
    }

    const needle = query.toLowerCase()
    const results = entries
      .filter(entry => entry.title.toLowerCase().includes(needle) || entry.description.toLowerCase().includes(needle))
      .slice(0, limit)

    return jsonResult({ query, results })
  })

  server.registerTool('get_doc', {
    description: 'Fetch a Litport documentation page as markdown, by full URL or bare slug (e.g. "api/tokens").',
    inputSchema: {
      url: z.string(),
    },
    annotations: annotations(true),
  }, async ({ url }) => {
    const allowedOrigin = new URL(config.baseUrl).origin
    let target
    try {
      if (/^https?:\/\//i.test(url)) {
        target = new URL(url)
      } else {
        const slug = url.replace(/^\/+/, '')
        const docsPath = slug === 'docs' || slug.startsWith('docs/') ? slug : `docs/${slug}`
        target = new URL(`/${docsPath}`, config.baseUrl)
      }
    } catch (cause) {
      return errorResult(`"${url}" is not a valid URL or slug: ${cause.message}`)
    }
    if (target.origin !== allowedOrigin) {
      return errorResult(`"${url}" is outside ${allowedOrigin}; get_doc only fetches Litport documentation.`)
    }
    if (!/\.[a-z0-9]+$/i.test(target.pathname)) {
      target.pathname = `${target.pathname.replace(/\/+$/, '')}.md`
    }
    try {
      const response = await fetchImpl(target)
      if (!response.ok) return errorResult(`Could not fetch ${target.toString()}: HTTP ${response.status}.`)
      const text = await response.text()
      return { content: [{ type: 'text', text }] }
    } catch (cause) {
      return errorResult(`Could not fetch ${target.toString()}: ${cause.message}`)
    }
  })
}
