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
// nextChangeAt and Retry-After (both set on a 409 CHANGE_LIMIT, e.g. from set_token_location or
// get_new_ip) are surfaced the same way, so the model sees a wait exists instead of retrying blindly.
// `retryable` is the API's own verdict on whether sending the same call again can succeed and is safe.
const apiErrorResult = error => {
  const parts = [error.message || 'The Litport API request failed.']
  if (error.code) parts.push(`code: ${error.code}`)
  if (typeof error.retryable === 'boolean') parts.push(`retryable: ${error.retryable}`)
  if (error.nextChangeAt) parts.push(`nextChangeAt: ${error.nextChangeAt}`)
  if (error.retryAfter) parts.push(`Retry-After: ${error.retryAfter}s`)
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

// idempotentHint defaults to true (repeating a write with the same arguments leaves the same
// state) -- get_new_ip is the one write that passes false, because a repeat on a static token inside
// the week fails with CHANGE_LIMIT, and a repeat on a rotating one gives another IP, rather than
// reproducing the same result.
const writeAnnotations = (destructiveHint, idempotentHint = true) => ({
  readOnlyHint: false,
  destructiveHint,
  idempotentHint,
  openWorldHint: true,
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
// Credential-free write results (update_token)
// ---------------------------------------------------------------------------

// What update_token returns of the API's answer: an allowlist, so a credential-bearing field the API adds
// later (the username, password, change-IP link, an endpoint) is left out until someone chooses to show it.
// create_token and reissue_credentials return the whole proxy on purpose; the API's PATCH answer has the
// credentials too, and a label change must not put them into the model's context.
const MUTATION_RESULT_FIELDS = [
  'id', 'type', 'status', 'disabledReason', 'label', 'externalRef', 'createdAt', 'expiresAt',
  'allowanceBytes', 'allowanceReservedBytes', 'poolSelection', 'packageId',
]

const withoutCredentials = response => {
  const proxy = response && typeof response === 'object' ? response.data : null
  const data = {}
  if (proxy && typeof proxy === 'object') {
    for (const field of MUTATION_RESULT_FIELDS) {
      if (Object.hasOwn(proxy, field)) data[field] = proxy[field]
    }
  }
  return { data }
}

// ---------------------------------------------------------------------------
// build_proxy_url helpers
// ---------------------------------------------------------------------------

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SID_RE = /^[A-Za-z0-9-]{3,15}$/
const SESSION_ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

// Matches the session IDs the Litport dashboard's proxy export generates.
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
// Keyless mode
// ---------------------------------------------------------------------------

// Without LITPORT_API_KEY the server offers only the tools that can work: the support tools (guest
// conversations) and the three that need no account (explain_proxy_error reads a bundled table,
// search_docs and get_doc read public pages). Listing the account tools as well would only invite
// retries of calls that cannot succeed.
const KEYLESS_TOOLS = new Set([
  'contact_support',
  'get_support_replies',
  'reply_to_support',
  'explain_proxy_error',
  'search_docs',
  'get_doc',
])

const keylessOnly = server => ({
  registerTool: (name, ...rest) => (KEYLESS_TOOLS.has(name) ? server.registerTool(name, ...rest) : undefined),
})

// ---------------------------------------------------------------------------
// registerTools
// ---------------------------------------------------------------------------

export const registerTools = (rawServer, { client, config, fetchImpl = fetch }) => {
  const server = client.hasApiKey ? rawServer : keylessOnly(rawServer)

  // ---- Tokens ---------------------------------------------------------------------------------

  server.registerTool('list_tokens', {
    description: 'List the account\'s proxy tokens (PPG and unlimited), paginated by cursor. Passwords '
      + 'are masked unless the server is configured with LITPORT_MCP_REVEAL_CREDENTIALS=1.',
    inputSchema: {
      limit: z.number().int().min(1).max(100).default(50),
      cursor: z.string().optional(),
      type: z.enum(['ppg', 'unlimited']).optional(),
      status: z.enum(['active', 'expired', 'disabled']).optional(),
      packageId: z.number().int().optional().describe('Only tokens on this package (from list_packages/get_package).'),
    },
    annotations: annotations(true),
  }, withApiErrorHandling(async ({ limit = 50, cursor, type, status, packageId }) => {
    const response = await client.get('/tokens', { limit, cursor, type, status, packageId })
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

  server.registerTool('get_usage', {
    description: 'Get daily usage for many proxies at once over one date range (default: the last 30 days; at '
      + 'most 92 days), including deleted proxies, newest proxy first, paged by cursor. Each proxy carries '
      + 'its label, externalRef, deleted flag, a summary and per-day buckets. Pay-per-GB proxies also carry '
      + 'costUnits (the charge for the day in balance units; null for a package proxy or a day with no '
      + 'recorded charge). A deleted proxy with no usage in the range appears only when its id is in '
      + 'tokenIds. The API allows 10 of these calls per minute per key (RATE_LIMITED beyond that). Use get_token_usage '
      + 'for one proxy by hour or month, with domains or charge components.',
    inputSchema: {
      from: z.string().optional().describe('Inclusive UTC ISO-8601 timestamp, e.g. 2026-11-01T00:00:00Z.'),
      to: z.string().optional().describe('Exclusive UTC ISO-8601 timestamp, after from.'),
      tokenIds: z.array(z.number().int().min(1)).min(1).max(100).optional()
        .describe('Only these proxies (at most 100 ids). An id that is not the account\'s is skipped. Omit for all proxies.'),
      limit: z.number().int().min(1).max(100).default(50).describe('Proxies per page.'),
      cursor: z.string().optional().describe('page.nextCursor from the previous page.'),
    },
    annotations: annotations(true),
  }, withApiErrorHandling(async ({ from, to, tokenIds, limit = 50, cursor }) => {
    const response = await client.get('/usage', {
      from,
      to,
      tokenIds: tokenIds && tokenIds.length > 0 ? tokenIds.join(',') : undefined,
      limit,
      cursor,
    })
    return jsonResult(response)
  }))

  server.registerTool('get_token_location', {
    description: 'Get a token\'s current location/carrier target: whether it can change right now, and '
      + 'nextChangeAt when it cannot. Answers 409 NOT_SUPPORTED for a token whose location can\'t '
      + 'change at all (pay-per-GB, Private Device, a day plan, a non-US mobile token, ...).',
    inputSchema: {
      tokenId: z.number().int(),
    },
    annotations: annotations(true),
  }, withApiErrorHandling(async ({ tokenId }) => {
    const response = await client.get(`/tokens/${tokenId}/location`)
    return jsonResult(response)
  }))

  server.registerTool('list_location_options', {
    description: 'List the values a token can move to at one level of its location hierarchy: '
      + '"region" then "city" for a datacenter/ISP token, or "city" then "carrier" for a mobile '
      + 'token. Call get_token_location first if you don\'t already know which kind applies to a '
      + 'given tokenId.',
    inputSchema: {
      tokenId: z.number().int(),
      level: z.enum(['region', 'city', 'carrier']),
      region: z.string().optional().describe('Required with level: "city" on a datacenter/ISP token.'),
      city: z.string().optional().describe('Required with level: "carrier" on a mobile token.'),
    },
    annotations: annotations(true),
  }, withApiErrorHandling(async ({ tokenId, level, region, city }) => {
    const response = await client.get(`/tokens/${tokenId}/location/options`, { level, region, city })
    return jsonResult(response)
  }))

  server.registerTool('set_token_location', {
    description: 'Change a token\'s location (and carrier, for a mobile token). Send region and city '
      + 'for a datacenter/ISP token, or city and carrier for a mobile token — only the arguments you '
      + 'give are sent to the API, so give exactly one of those two shapes. Or send random: true alone '
      + 'to move it to another location this proxy can use right now (not safe to repeat blindly: each '
      + 'repeat moves it again, so after a lost result read get_token_location first). With region and '
      + 'city or city and carrier, repeating is safe: sending the already-saved target is a no-op. A '
      + 'static datacenter/ISP token gets a new IP in the new '
      + 'location and spends its weekly allowance. A standard US Shared Mobile token allows this once per '
      + '48 hours; on a 409 CHANGE_LIMIT, wait for nextChangeAt (also in the error) before retrying.',
    inputSchema: {
      tokenId: z.number().int(),
      region: z.string().optional().describe('Datacenter/ISP only, together with city.'),
      city: z.string().optional().describe('Datacenter/ISP (with region) or mobile (with carrier).'),
      carrier: z.string().optional().describe('Mobile only, together with city.'),
      country: z.string().optional().describe('Optional; must be "us" when given.'),
      random: z.boolean().optional().describe('true: the server picks another location this proxy can use right now (a different city when there is one; for a mobile proxy otherwise another carrier in the same city). Send it alone, without region, city, carrier or country.'),
    },
    // Not idempotent: with random: true every repeat moves the proxy again.
    annotations: writeAnnotations(false, false),
  }, withApiErrorHandling(async ({ tokenId, region, city, carrier, country, random }) => {
    if (random === true) {
      if ([region, city, carrier, country].some(value => value !== undefined)) {
        return errorResult('Send random alone, without region, city, carrier or country.')
      }
      return jsonResult(await client.request('PUT', `/tokens/${tokenId}/location`, { body: { random: true } }))
    }
    const body = {}
    if (region !== undefined) body.region = region
    if (city !== undefined) body.city = city
    if (carrier !== undefined) body.carrier = carrier
    if (country !== undefined) body.country = country
    const response = await client.request('PUT', `/tokens/${tokenId}/location`, { body })
    return jsonResult(response)
  }))

  server.registerTool('set_rotation', {
    description: 'Change a token\'s rotation interval to one of the values in its own rotation.options '
      + '(see list_tokens/get_token_credentials). Answers 409 NOT_SUPPORTED when rotation.changeable '
      + 'is false — e.g. a Multi-location mobile token, whose interval always follows whichever phone '
      + 'it is currently placed on.',
    inputSchema: {
      tokenId: z.number().int(),
      intervalSec: z.number().int().describe('One of the token\'s rotation.options values, in seconds.'),
    },
    annotations: writeAnnotations(false),
  }, withApiErrorHandling(async ({ tokenId, intervalSec }) => {
    const response = await client.request('PUT', `/tokens/${tokenId}/rotation`, { body: { intervalSec } })
    return jsonResult(response)
  }))

  server.registerTool('get_new_ip', {
    description: 'Get a new IP address for a datacenter/ISP token, in the same location. A static '
      + 'token spends its weekly allowance. This is NOT safe to blindly retry on a static token: call '
      + 'get_token_location first and check canChangeNow/nextChangeAt, because a second call inside '
      + 'the same week fails with CHANGE_LIMIT instead of returning a second new IP. If a call\'s '
      + 'result is lost or ambiguous, re-read get_token_location instead of calling this again. A '
      + 'rotating token can get a new IP at any time. The new IP is always different from the current '
      + 'one, and the token\'s automatic timer restarts. Two calls must be at least the type\'s '
      + 'shortest rotation interval apart (the smallest value in the token\'s rotation.options); a '
      + 'call inside that wait fails with CHANGE_LIMIT, so wait for nextChangeAt (also Retry-After). '
      + 'LOCATION_UNAVAILABLE means no other IP qualifies right now: nothing changed, and the call '
      + 'still uses up the wait. After a lost result on a rotating token, get_token_location cannot '
      + 'confirm the change, because its canChangeNow/nextChangeAt are about the location and not '
      + 'this wait. Calling again after Retry-After is harmless; it just gives another new IP. A '
      + 'CHANGE_LIMIT right after a lost result does not prove the change happened. Any other token '
      + '(mobile, pay-per-GB, Private Device) answers NOT_SUPPORTED.',
    inputSchema: {
      tokenId: z.number().int(),
    },
    annotations: writeAnnotations(true, false),
  }, withApiErrorHandling(async ({ tokenId }) => {
    const response = await client.request('POST', `/tokens/${tokenId}/new-ip`)
    return jsonResult(response)
  }))

  // ---- Proxy writes ---------------------------------------------------------------------------
  // create_token, update_token, reissue_credentials and delete_token change live pay-per-GB proxies (and, for
  // reissue_credentials, any proxy the account owns). Their descriptions say so, because the model reads
  // them before it decides to call. Only create_token and reissue_credentials return credentials, by design:
  // the proxy's real username and password, as get_token_credentials returns them, whatever
  // LITPORT_MCP_REVEAL_CREDENTIALS says. update_token and delete_token never do: routine maintenance (a label,
  // a cap, an off switch) must not put a password into the model's context.

  server.registerTool('create_token', {
    description: 'Create a live pay-per-GB proxy on the account. It works at once, is billed per GB from the '
      + 'account balance as it is used. The result holds its real username and password, like '
      + 'get_token_credentials: this tool returns credentials by design. Needs a positive balance and an account that is not blocked. ALWAYS send '
      + 'externalRef (your own reference, such as your customer\'s id): if a call times out, repeat it with '
      + 'the same externalRef and you get the proxy that exists; without one a repeat creates a second '
      + 'proxy. A repeat with an externalRef the account already uses returns that proxy and changes '
      + 'nothing, even if the other arguments differ. pool is a pool authKey from list_pools; leave it out '
      + 'for a proxy that picks its pool per request. expiresAt is an ISO 8601 date-time after now, or a date '
      + 'that means the end of that day in UTC. allowanceBytes is a traffic cap in bytes over all traffic '
      + 'in both directions. Writes share the API key\'s 120 requests per minute; creating is also limited '
      + 'per account per minute, and past it the call answers 429 RATE_LIMITED with a Retry-After.',
    inputSchema: {
      pool: z.string().optional().describe('Pool authKey from list_pools. Omit for a proxy that picks its pool per request.'),
      label: z.string().max(255).optional().describe('Your note for the proxy, up to 255 characters.'),
      externalRef: z.string().min(1).max(128).optional().describe('Your own reference, 1-128 printable characters, unique among the account\'s live proxies. Always send one.'),
      expiresAt: z.string().optional().describe('ISO 8601 date-time with a zone (2026-12-31T10:00:00Z), or a date (2026-12-31) for the end of that day in UTC. Must be after now.'),
      allowanceBytes: z.number().int().min(1).optional().describe('Traffic cap in bytes (1 GB = 1,000,000,000 bytes).'),
    },
    annotations: writeAnnotations(false, false),
  }, withApiErrorHandling(async ({ pool, label, externalRef, expiresAt, allowanceBytes }) => {
    const body = {}
    if (pool !== undefined) body.pool = pool
    if (label !== undefined) body.label = label
    if (externalRef !== undefined) body.externalRef = externalRef
    if (expiresAt !== undefined) body.expiresAt = expiresAt
    if (allowanceBytes !== undefined) body.allowanceBytes = allowanceBytes
    const response = await client.request('POST', '/tokens', { body })
    return jsonResult(response)
  }))

  server.registerTool('update_token', {
    description: 'Change a live pay-per-GB proxy. Send only what you want to change: a field you leave out '
      + 'stays as it is, and null clears label, pool, expiresAt or allowanceBytes (null pool means the '
      + 'proxy picks its pool per request; null allowanceBytes removes the cap). enabled: false switches '
      + 'the proxy off; enabled: true needs a positive balance and an account that is not blocked. '
      + 'Adding, changing or removing allowanceBytes ends the proxy\'s open connections once; clients '
      + 'reconnect under the new cap. Switching off, relabelling and changing the expiry or the cap work '
      + 'with an empty balance, so a customer can always be cut off. A package\'s proxy takes label only '
      + '(any other field is FIELD_NOT_ALLOWED). Safe to repeat: the same arguments leave the same state. '
      + 'The result is the proxy\'s id, status, label, externalRef, pool, cap and expiry, and never its '
      + 'username, password or change-IP link; call get_token_credentials for those.',
    inputSchema: {
      tokenId: z.number().int().describe('The numeric token id, e.g. from list_tokens.'),
      label: z.string().max(255).nullable().optional().describe('New note, or null to clear it.'),
      enabled: z.boolean().optional().describe('false switches the proxy off, true switches it on.'),
      pool: z.string().nullable().optional().describe('Pool authKey from list_pools, or null for a proxy that picks its pool per request.'),
      expiresAt: z.string().nullable().optional().describe('ISO 8601 date-time after now, or a date (end of that day in UTC), or null for no expiry.'),
      allowanceBytes: z.number().int().min(1).nullable().optional().describe('Traffic cap in bytes, or null to remove the cap.'),
    },
    annotations: writeAnnotations(true),
  }, withApiErrorHandling(async ({ tokenId, label, enabled, pool, expiresAt, allowanceBytes }) => {
    const body = {}
    if (label !== undefined) body.label = label
    if (enabled !== undefined) body.enabled = enabled
    if (pool !== undefined) body.pool = pool
    if (expiresAt !== undefined) body.expiresAt = expiresAt
    if (allowanceBytes !== undefined) body.allowanceBytes = allowanceBytes
    if (Object.keys(body).length === 0) {
      return errorResult('Give at least one of label, enabled, pool, expiresAt or allowanceBytes to change.')
    }
    const response = await client.request('PATCH', `/tokens/${tokenId}`, { body })
    return jsonResult(withoutCredentials(response))
  }))

  server.registerTool('reissue_credentials', {
    description: 'Issue a new username, password and change-IP key for a proxy the account owns (pay-per-GB or '
      + 'package) and return them. The old password stops working at once and its open connections close; '
      + 'the old change-IP link stops. A package\'s allowed IPs keep working and their connections are '
      + 'not closed, so to cut one customer off a shared package, reissue rather than rely on allowed IPs. '
      + 'requestId makes a retry safe: use a NEW requestId for every reissue you mean, and the same one '
      + 'only to retry a call whose answer you did not get; a repeat with the same requestId returns the '
      + 'current credentials and issues nothing new. Without a requestId every call issues a new pair, so '
      + 'do not repeat it blindly. The result holds the new real password, like get_token_credentials: '
      + 'this tool returns credentials by design.',
    inputSchema: {
      tokenId: z.number().int().describe('The numeric token id, e.g. from list_tokens.'),
      requestId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional()
        .describe('1-64 characters: letters, digits, underscore or hyphen. New for each reissue; the same only for a retry.'),
    },
    annotations: writeAnnotations(true, false),
  }, withApiErrorHandling(async ({ tokenId, requestId }) => {
    const response = await client.request('POST', `/tokens/${tokenId}/credentials`, requestId === undefined ? {} : { body: { requestId } })
    return jsonResult(response)
  }))

  server.registerTool('delete_token', {
    description: 'Delete a pay-per-GB proxy. It stops working and its open connections close. Its history stays: '
      + 'get_usage and get_token_usage still report it, marked deleted, and its externalRef can be used '
      + 'again. Deleting a proxy that is already deleted is not an error. A package\'s proxies can not be '
      + 'deleted (NOT_SUPPORTED): they end with their package. To pause a proxy instead, call update_token '
      + 'with enabled: false. The result is the token id and deleted: true, never credentials.',
    inputSchema: {
      tokenId: z.number().int().describe('The numeric token id, e.g. from list_tokens.'),
    },
    annotations: writeAnnotations(true),
  }, withApiErrorHandling(async ({ tokenId }) => {
    await client.request('DELETE', `/tokens/${tokenId}`)
    return jsonResult({ tokenId, deleted: true })
  }))

  // ---- Packages ---------------------------------------------------------------------------------

  server.registerTool('list_packages', {
    description: 'List the account\'s proxy packages — product, status, add-ons, limits, renewal/end '
      + 'dates, and token IDs — paginated by cursor.',
    inputSchema: {
      limit: z.number().int().min(1).max(100).default(50),
      cursor: z.string().optional(),
    },
    annotations: annotations(true),
  }, withApiErrorHandling(async ({ limit = 50, cursor }) => {
    const response = await client.get('/packages', { limit, cursor })
    return jsonResult(response)
  }))

  server.registerTool('get_package', {
    description: 'Get one proxy package by its public numeric package ID.',
    inputSchema: { packageId: z.number().int() },
    annotations: annotations(true),
  }, withApiErrorHandling(async ({ packageId }) => {
    const response = await client.get(`/packages/${packageId}`)
    return jsonResult(response)
  }))

  server.registerTool('get_allowed_ips', {
    description: 'Get a package\'s allowed-IP list: the addresses themselves, the limit, and whether '
      + 'the passwordless endpoint is available. The passwordless endpoint itself is on each token as '
      + '`ipAuth` (see list_tokens/get_token_credentials/build_proxy_url), not here.',
    inputSchema: {
      packageId: z.number().int(),
    },
    annotations: annotations(true),
  }, withApiErrorHandling(async ({ packageId }) => {
    const response = await client.get(`/packages/${packageId}/allowed-ips`)
    return jsonResult(response)
  }))

  server.registerTool('set_allowed_ips', {
    description: 'Set a package\'s whole allowed-IP list at once. All-or-nothing: one invalid address '
      + 'fails the whole call (400), and going over the package\'s limit fails with 409 '
      + 'ALLOWED_IPS_LIMIT_REACHED. An empty array clears the list. No preceding read is required — '
      + 'the latest committed, successful call wins, and it is safe to repeat.',
    inputSchema: {
      packageId: z.number().int(),
      ips: z.array(z.string()).describe('The complete list of IPv4 addresses to allow. [] clears it.'),
    },
    annotations: writeAnnotations(true),
  }, withApiErrorHandling(async ({ packageId, ips }) => {
    const response = await client.request('PUT', `/packages/${packageId}/allowed-ips`, { body: { ips } })
    return jsonResult(response)
  }))

  server.registerTool('add_allowed_ip', {
    description: 'Add one exact public IPv4 address to a package\'s allowed-IP list. IPv6 is '
      + 'unsupported; contact support. This grants passwordless access to every ready endpoint in '
      + 'that package from the address. No preceding read is required — the latest committed, '
      + 'successful call wins, and adding an address already active is a no-op.',
    inputSchema: {
      packageId: z.number().int(),
      ip: z.string().min(1).describe('Exact public IPv4 address.'),
    },
    annotations: writeAnnotations(false),
  }, withApiErrorHandling(async ({ packageId, ip }) => {
    const response = await client.request('PUT', `/packages/${packageId}/allowed-ips/${encodeURIComponent(ip)}`)
    return jsonResult(response)
  }))

  server.registerTool('remove_allowed_ip', {
    description: 'Remove one address from a package\'s allowed-IP list. This takes away passwordless '
      + 'access for that IP across the whole package; credentials still work. No preceding read is '
      + 'required — the latest committed, successful call wins, and removing an address already '
      + 'absent is a no-op. The row is only marked revoked, so audit history is kept.',
    inputSchema: {
      packageId: z.number().int(),
      ip: z.string().min(1),
    },
    annotations: writeAnnotations(true),
  }, withApiErrorHandling(async ({ packageId, ip }) => {
    const response = await client.request('DELETE', `/packages/${packageId}/allowed-ips/${encodeURIComponent(ip)}`)
    return jsonResult(response)
  }))

  // ---- Pay-per-GB ---------------------------------------------------------------------------------

  server.registerTool('list_pools', {
    description: 'List the pay-per-GB pools available to this account, the hubs each one connects '
      + 'through, and the geo-targeting levels each supports.',
    annotations: annotations(true),
  }, withApiErrorHandling(async () => {
    const response = await client.get('/pay-per-gb/pools')
    return jsonResult(response)
  }))

  server.registerTool('list_targeting_options', {
    description: 'List available pay-per-GB geo-targeting options (countries, regions, or cities) for '
      + 'one or more pools, paginated by cursor.',
    inputSchema: {
      pool: z.string().describe('Comma-separated pool authKeys.'),
      level: z.enum(['country', 'region', 'city']),
      country: z.string().optional(),
      region: z.string().optional(),
      q: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(50),
      cursor: z.string().optional(),
    },
    annotations: annotations(true),
  }, withApiErrorHandling(async ({ pool, level, country, region, q, limit = 50, cursor }) => {
    if (level === 'region' && !country) {
      return errorResult('level: "region" requires a "country" argument.')
    }
    if (level === 'city' && (!country || !region)) {
      return errorResult('level: "city" requires both "country" and "region" arguments.')
    }
    const response = await client.get('/pay-per-gb/geo', { pool, level, country, region, q, limit, cursor })
    return jsonResult(response)
  }))

  server.registerTool('get_balance', {
    description: 'Get the account\'s pay-per-GB balance and plan.',
    annotations: annotations(true),
  }, withApiErrorHandling(async () => {
    const response = await client.get('/pay-per-gb/balance')
    return jsonResult(response)
  }))

  // ---- Other ---------------------------------------------------------------------------------

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
      + 'targeting for a pay-per-GB token, or a passwordless URL using a package\'s allowed-IP '
      + 'endpoint for an unlimited token. Replicates the dashboard\'s export format exactly.',
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
      passwordless: z.boolean().optional().describe('Unlimited tokens only: build a credential-free URL '
        + 'from the token\'s package allowed-IP endpoint (token.ipAuth) instead of embedding a '
        + 'password. Requires ipAuth to already be non-null, which in turn requires the caller\'s own '
        + 'IP to already be on the package allowlist (see add_allowed_ip). count and credentialStyle '
        + 'are ignored when this is set.'),
    },
    annotations: annotations(true),
  }, withApiErrorHandling(async ({ tokenId, pool, country, region, city, sid, sttl, hub, protocol, credentialStyle = 'inline', count = 1, passwordless }) => {
    const normalizedCountry = country != null ? normalizeCountry(country) : undefined
    const normalizedRegion = region != null ? region.toLowerCase() : undefined
    const normalizedCity = city != null ? city.toLowerCase() : undefined

    const validationErrors = validateProxyUrlParams({
      pool, country: normalizedCountry, region: normalizedRegion, city: normalizedCity, sid, sttl,
    })
    if (validationErrors.length > 0) return errorResult(validationErrors.join(' '))

    const tokenResponse = await client.get(`/tokens/${tokenId}`)
    const token = tokenResponse.data

    // An unlimited token is assigned exactly one endpoint, which the API already resolves for us --
    // no /pay-per-gb/pools fetch is needed for it at all.
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

      if (passwordless) {
        if (!token.ipAuth) {
          return errorResult(`Token ${tokenId} has no ready passwordless endpoint (token.ipAuth is null). Add the caller's IP with add_allowed_ip for its package, then retry.`)
        }
        const passwordlessUrl = `${ingress.protocol}://${token.ipAuth.host}:${token.ipAuth.port}`
        return textAndJsonResult(passwordlessUrl, {
          urls: [passwordlessUrl],
          username: null,
          pool: null,
          hub: { id: ingress.hub, hostname: token.ipAuth.host },
          protocol: ingress.protocol,
          pricePerGb: null,
          passwordless: true,
        })
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

    if (passwordless) {
      return errorResult(`Token ${tokenId} is a pay-per-GB token; passwordless URLs are only for unlimited tokens.`)
    }

    if (!token.poolSelection) {
      return errorResult(`Token ${tokenId} is a ppg token with no pool selection information; a proxy URL cannot be built for it.`)
    }

    const poolsResponse = await client.get('/pay-per-gb/pools')
    const pools = poolsResponse.data

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
    // poolRecord.hubs is already the list of hubs this pool can be used through, as the API returns it.
    const hubRecord = poolRecord.hubs.find(h => h.id === hubId)
    if (!hubRecord) {
      return errorResult(`Hub "${hubId}" is not eligible for pool "${poolRecord.authKey}". Eligible hubs: ${poolRecord.hubs.map(h => h.id).join(', ')}.`)
    }

    const resolvedProtocol = protocol || token.ingress.protocol
    if (!['http', 'https', 'socks5'].includes(resolvedProtocol)) {
      return errorResult(`Unsupported protocol "${resolvedProtocol}".`)
    }
    const port = resolvedProtocol === 'socks5' ? poolRecord.socks5Port : poolRecord.httpPort
    // An HTTPS proxy is checked against the hub's certificate, which is issued for httpsHostname; `hostname` may be a
    // neutral name (the account's own setting) that fails that check. The URL and the hub metadata carry the same name.
    const hostname = resolvedProtocol === 'https' ? (hubRecord.httpsHostname ?? hubRecord.hostname) : hubRecord.hostname
    const host = `${hostname}:${port}`

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
      hub: { id: hubRecord.id, name: hubRecord.name, hostname },
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

  // ---- Support ----------------------------------------------------------------------------------
  // Without an API key a conversation is a guest one, and the API returns its access token (lsc_…)
  // only once. The token stays in this process for the session and is never put in a tool result, so
  // it cannot end up in the model's context. With an API key every call reaches the account's own
  // conversation and no token exists.

  const supportTokens = new Map()
  let currentConversationId = null

  const resolveSupportConversation = conversationId => {
    const id = conversationId || currentConversationId
    if (!id) return { error: 'There is no support conversation in this session yet. Call contact_support first.' }
    if (supportTokens.has(id)) return { id, bearer: supportTokens.get(id) }
    if (client.hasApiKey) return { id, bearer: undefined }
    return { error: `This session has no access token for conversation ${id}. A conversation started without an API key can only be read by the session that started it.` }
  }

  const conversationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
    .describe('Defaults to the conversation started or used most recently in this session.')

  server.registerTool('contact_support', {
    description: 'Contact Litport support: start a conversation with a first message. Without '
      + 'LITPORT_API_KEY this is a guest conversation: "email" is required (where we can reach you) and '
      + 'only general questions can be answered; at most 3 new guest conversations per hour. With '
      + 'LITPORT_API_KEY it is the account\'s own conversation, where support can help with orders and '
      + 'proxies, and "email" is not used. Replies are not instant: call get_support_replies about every '
      + '30 seconds. To add to a conversation that already exists, use reply_to_support. Never put API '
      + 'keys or proxy passwords in the message.',
    inputSchema: {
      message: z.string().min(1).max(4000).describe('The question or request, up to 4,000 characters.'),
      email: z.email().optional().describe('Required without LITPORT_API_KEY; not used with it.'),
    },
    annotations: writeAnnotations(false, false),
  }, withApiErrorHandling(async ({ message, email }) => {
    const keyless = !client.hasApiKey
    if (keyless && !email) {
      return errorResult('"email" is required when the server has no LITPORT_API_KEY: it is where we can reach you.')
    }
    const response = await client.request('POST', '/support/conversations', keyless
      ? { body: { email, message }, bearer: null }
      : { body: { message } })
    currentConversationId = response.conversationId
    if (response.accessToken) supportTokens.set(response.conversationId, response.accessToken)
    const { accessToken: _accessToken, ...visible } = response
    return jsonResult({
      ...visible,
      note: 'The reply is not instant. Call get_support_replies about every 30 seconds.',
    })
  }))

  server.registerTool('get_support_replies', {
    description: 'Read a support conversation: the messages after "after", oldest first, and who the '
      + 'conversation is waiting on (waitingOn: "us" means Litport, "customer" means you). Replies '
      + 'are not pushed, so poll about every 30 seconds (pollAfterSeconds). Pass the last seq you already '
      + 'have as "after" to get only new messages; leave it out to read from the start. When "more" is '
      + 'true, call again with "after" set to the last seq received.',
    inputSchema: {
      conversationId: conversationIdSchema.optional(),
      after: z.number().int().min(0).optional().describe('The highest message seq you already have.'),
    },
    annotations: annotations(true),
  }, withApiErrorHandling(async ({ conversationId, after }) => {
    const target = resolveSupportConversation(conversationId)
    if (target.error) return errorResult(target.error)
    const response = await client.request('GET', `/support/conversations/${encodeURIComponent(target.id)}`, {
      query: { after },
      bearer: target.bearer,
    })
    return jsonResult(response)
  }))

  server.registerTool('reply_to_support', {
    description: 'Add a message to a support conversation started with contact_support: an answer to a '
      + 'question from support, or more detail. Up to 4,000 characters, 30 messages per conversation per '
      + '24 hours. No attachments. Never put API keys or proxy passwords in the message.',
    inputSchema: {
      message: z.string().min(1).max(4000),
      conversationId: conversationIdSchema.optional(),
    },
    annotations: writeAnnotations(false, false),
  }, withApiErrorHandling(async ({ message, conversationId }) => {
    const target = resolveSupportConversation(conversationId)
    if (target.error) return errorResult(target.error)
    const response = await client.request('POST', `/support/conversations/${encodeURIComponent(target.id)}/messages`, {
      body: { message },
      bearer: target.bearer,
    })
    return jsonResult(response)
  }))
}
