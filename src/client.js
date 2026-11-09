export class ApiError extends Error {
  constructor(message, { status, code, requestId, docsUrl, retryable, nextChangeAt, retryAfter, error } = {}) {
    super(message)
    this.status = status
    this.code = code
    this.requestId = requestId
    this.docsUrl = docsUrl
    // The API's own answer to "can this same request, sent again, succeed and is it safe to send?" -- set only
    // when the API sent a boolean, so a caller can tell "false" from "not said".
    if (typeof retryable === 'boolean') this.retryable = retryable
    // nextChangeAt (a 409 CHANGE_LIMIT field) and the Retry-After header both tell a caller when a
    // wait ends -- kept as their own properties, plus the whole decoded `error` object verbatim, so
    // a tool never has to guess which of the API's documented fields survived.
    this.nextChangeAt = nextChangeAt
    this.retryAfter = retryAfter
    this.error = error
  }
}

const REQUEST_TIMEOUT_MS = 10_000

const buildUrl = (baseUrl, path, query = {}) => {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    throw new ApiError('Litport API paths must start with exactly one slash.')
  }
  const apiUrl = new URL('/api/v1/', baseUrl)
  const url = new URL(path.slice(1), apiUrl)
  if (url.origin !== apiUrl.origin || !url.pathname.startsWith('/api/v1/')) {
    throw new ApiError('Litport API request path is outside the configured API origin.')
  }
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    url.searchParams.set(key, String(value))
  }
  return url
}

// Sent on every request so the account API can tell MCP traffic apart from a hand-written HTTP
// client. It identifies the package and version only — never the user, the host, or the key.
export const userAgentFor = version => `litport-mcp/${version}`

export const createClient = ({ apiKey, baseUrl, userAgent, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS }) => {
  // `bearer` picks the credential for one call: omitted = the account API key, a string = a support
  // conversation access token (lsc_…), null = no Authorization header (a keyless first message).
  const request = async (method, path, { body, headers = {}, query, bearer } = {}) => {
    if (bearer === undefined && !apiKey) {
      throw new ApiError('This call needs a Litport account API key. Set LITPORT_API_KEY in the MCP server\'s env block; Settings at https://litport.net/users/settings creates one.')
    }
    const credential = bearer === undefined ? apiKey : bearer
    const url = buildUrl(baseUrl, path, query)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const safeHeaders = Object.fromEntries(Object.entries(headers).filter(([name]) => ![
      'accept', 'authorization', 'content-type', 'user-agent',
    ].includes(name.toLowerCase())))
    let response
    let responseBody = null
    try {
      response = await fetchImpl(url, {
        headers: {
          ...safeHeaders,
          ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
          Accept: 'application/json',
          ...(userAgent ? { 'User-Agent': userAgent } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        method,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
        // Authorization headers must never follow a redirect to an unreviewed origin.
        redirect: 'error',
      })
      try {
        responseBody = await response.json()
      } catch (error) {
        if (controller.signal.aborted) throw error
      }
    } catch (cause) {
      // Never include request headers, the key, or a redirect target in what surfaces to the model.
      const message = controller.signal.aborted
        ? `Litport API request timed out after ${timeoutMs}ms.`
        : 'Could not reach the Litport API.'
      throw new ApiError(message)
    } finally {
      clearTimeout(timeout)
    }

    if (!response.ok) {
      const error = responseBody?.error || {}
      const retryAfter = typeof response.headers?.get === 'function' ? response.headers.get('retry-after') : null
      throw new ApiError(error.message || `Litport API request failed with HTTP ${response.status}.`, {
        status: response.status,
        code: error.code,
        requestId: error.requestId,
        docsUrl: error.docsUrl,
        retryable: error.retryable,
        nextChangeAt: error.nextChangeAt,
        retryAfter,
        error,
      })
    }
    return responseBody
  }

  return {
    request,
    // Keep the original GET helper as the stable read-only client API.
    get: (path, query) => request('GET', path, { query }),
    hasApiKey: Boolean(apiKey),
  }
}
