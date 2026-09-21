export class ConfigError extends Error {}

const DEFAULT_BASE_URL = 'https://litport.net'

// `lit_`/`ltp_` prefixes match web/app/utils/checkUserApiKey.js. Checking the shape here turns a
// typo into one clear message instead of an opaque 401 the model will try to "fix" by retrying.
const API_KEY_RE = /^(?:lit|ltp)_[A-Za-z0-9_-]{43,}$/

export const loadConfig = (env = process.env) => {
  const apiKey = (env.LITPORT_API_KEY || '').trim()
  if (!apiKey) {
    throw new ConfigError('LITPORT_API_KEY is not set. Create an API key in Settings at https://litport.net/users/settings and put it in the MCP server\'s env block.')
  }
  if (!API_KEY_RE.test(apiKey)) {
    throw new ConfigError('LITPORT_API_KEY does not look like a Litport account API key (expected a lit_… or ltp_… value). Proxy usernames and passwords are not account API keys.')
  }
  return {
    apiKey,
    baseUrl: (env.LITPORT_API_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    // Off by default: list_tokens is a browse operation and should not put every password of every
    // token into the model's context. get_token_credentials and build_proxy_url always return the
    // real values for the one token the caller asked about, so nothing is ever unreachable.
    revealCredentials: env.LITPORT_MCP_REVEAL_CREDENTIALS === '1',
  }
}

export const MASKED = null
