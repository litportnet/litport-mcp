export class ApiError extends Error {
  constructor(message, { status, code, requestId, docsUrl } = {}) {
    super(message)
    this.status = status
    this.code = code
    this.requestId = requestId
    this.docsUrl = docsUrl
  }
}

const buildUrl = (baseUrl, path, query = {}) => {
  const url = new URL(`${baseUrl}/api/v1${path}`)
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    url.searchParams.set(key, String(value))
  }
  return url
}

// Sent on every request so the account API can tell MCP traffic apart from a hand-written HTTP
// client. It identifies the package and version only — never the user, the host, or the key.
export const userAgentFor = version => `litport-mcp/${version}`

export const createClient = ({ apiKey, baseUrl, userAgent, fetchImpl = fetch }) => ({
  get: async (path, query) => {
    const url = buildUrl(baseUrl, path, query)
    let response
    try {
      response = await fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          ...(userAgent ? { 'User-Agent': userAgent } : {}),
        },
      })
    } catch (cause) {
      // Never include the URL object's headers or the key in what surfaces to the model.
      throw new ApiError(`Could not reach the Litport API at ${baseUrl}: ${cause.message}`)
    }

    let body = null
    try {
      body = await response.json()
    } catch {
      body = null
    }

    if (!response.ok) {
      const error = body?.error || {}
      throw new ApiError(error.message || `Litport API request failed with HTTP ${response.status}.`, {
        status: response.status,
        code: error.code,
        requestId: error.requestId,
        docsUrl: error.docsUrl,
      })
    }
    return body
  },
})
