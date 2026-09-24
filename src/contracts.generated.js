// GENERATED FILE — DO NOT EDIT BY HAND.
// Source: web/app/documentation/contracts/{ppgParams,proxyErrors}.js
// Regenerate with: npm run generate-contracts

export const ppgParameters = Object.freeze([
  {
    "name": "pool",
    "syntax": "pool-<auth-key>",
    "rules": "Required in exported credentials. Lowercase pool key from the dashboard; maximum 80 characters."
  },
  {
    "name": "country",
    "syntax": "country-<slug>",
    "rules": "Lowercase geo slug, maximum 80 characters. uk normalizes to gb."
  },
  {
    "name": "region",
    "syntax": "region-<slug>",
    "rules": "Requires country when used as a canonical geo path."
  },
  {
    "name": "state",
    "syntax": "state-<slug>",
    "rules": "Compatibility alias for region. Do not send state and region together."
  },
  {
    "name": "city",
    "syntax": "city-<slug>",
    "rules": "Requires both country and region."
  },
  {
    "name": "sid",
    "syntax": "sid-<session-id>",
    "rules": "Letters, numbers, and hyphens after sanitization; 3–15 characters."
  },
  {
    "name": "sttl",
    "syntax": "sttl-<seconds>",
    "rules": "1–86400 is honored. 0 or 86401–999999 currently falls back to 600; seven or more digits are invalid."
  }
])

export const proxyErrors = Object.freeze([
  {
    "code": 0,
    "symbol": "ErrorNone",
    "message": "",
    "http": "No error response",
    "retry": "Not applicable",
    "action": "Treat the request as successful."
  },
  {
    "code": 1,
    "symbol": "ErrorPanic",
    "message": "panic",
    "http": "500",
    "retry": "No tight-loop retry",
    "action": "Retry once with backoff, then contact support with request evidence."
  },
  {
    "code": 2,
    "symbol": "ErrorInternal",
    "message": "Internal proxy error",
    "http": "500 or 503",
    "retry": "Bounded backoff",
    "action": "Retry a limited number of times, then contact support."
  },
  {
    "code": 3,
    "symbol": "ErrorInterrupted",
    "message": "Connection was interrupted",
    "http": "500",
    "retry": "Only when the application operation is safe",
    "action": "Check client and target timeouts before retrying."
  },
  {
    "code": 4,
    "symbol": "ErrorNoToken",
    "message": "Token not found",
    "http": "407",
    "retry": "After correcting credentials",
    "action": "Check the proxy username, password, host, and port."
  },
  {
    "code": 5,
    "symbol": "ErrorNoAccess",
    "message": "Access denied",
    "http": "500 for compatibility",
    "retry": "No automatic retry",
    "action": "Check token status, account access, and destination policy."
  },
  {
    "code": 6,
    "symbol": "ErrorLimited",
    "message": "You have reached the limit of concurrent connections",
    "http": "403",
    "retry": "After capacity is available",
    "action": "Close idle connections or reduce concurrency."
  },
  {
    "code": 7,
    "symbol": "ErrorNoProxy",
    "message": "Internal proxy error",
    "http": "500",
    "retry": "Bounded backoff",
    "action": "Retry briefly; contact support if no upstream becomes available."
  },
  {
    "code": 8,
    "symbol": "ErrorHubMismatch",
    "message": "Proxy host mismatch, check token settings",
    "http": "500",
    "retry": "After correcting the hub",
    "action": "Use the hub shown for the token in the dashboard."
  },
  {
    "code": 9,
    "symbol": "ErrorHubProxyTypeMismatch",
    "message": "Proxy type mismatch, check token settings",
    "http": "500",
    "retry": "After correcting the ingress",
    "action": "Use the token's current HTTP or SOCKS5 endpoint."
  },
  {
    "code": 10,
    "symbol": "ErrorRateLimited",
    "message": "Too many requests",
    "http": "403",
    "retry": "Backoff required",
    "action": "Reduce new-request or new-connection rate for the ingress mode."
  },
  {
    "code": 11,
    "symbol": "ErrorPpgGetProxy",
    "message": "PPG proxy error",
    "wireNote": "May be replaced by a specific wire message.",
    "http": "500",
    "retry": "Depends on the custom message",
    "action": "Correct pool, geography, or session parameters; otherwise retry with backoff."
  },
  {
    "code": 12,
    "symbol": "ErrorPpgStats",
    "message": "PPG stats error",
    "wireNote": "The wire message may be custom.",
    "http": "500",
    "retry": "Bounded backoff",
    "action": "Retry briefly, then contact support if the error continues."
  },
  {
    "code": 13,
    "symbol": "ErrorPpgNotEnoughUnits",
    "message": "Insufficient account balance",
    "http": "402",
    "retry": "Not a network retry",
    "action": "Check or add account balance in the dashboard."
  },
  {
    "code": 14,
    "symbol": "ErrorRemoteProxy",
    "message": "Remote proxy connection error",
    "http": "500 or 503",
    "retry": "Bounded backoff",
    "action": "Retry may select a different remote proxy."
  },
  {
    "code": 15,
    "symbol": "ErrorUpstreamConnection",
    "message": "Upstream server connection error",
    "http": "500 or 503",
    "retry": "Depends on destination safety",
    "action": "Check the destination and retry policy before retrying."
  },
  {
    "code": 16,
    "symbol": "ErrorPpgUpstreamResponse",
    "message": "Internal proxy error",
    "http": "500",
    "retry": "Bounded backoff",
    "action": "Retry briefly; if it persists, contact support with the hub, token ID, destination, timestamp, and code 16—never the proxy password."
  },
  {
    "code": 17,
    "symbol": "ErrorPackageBandwidthExceeded",
    "message": "packageBandwidthExceeded",
    "http": "403",
    "retry": "Not a network retry",
    "action": "The package has used its traffic allowance for the current period. Wait for the period to renew, or move to a larger allowance in the dashboard."
  },
  {
    "code": 18,
    "symbol": "ErrorPackageEntitlementUnavailable",
    "message": "packageEntitlementUnavailable",
    "http": "503",
    "retry": "Bounded backoff",
    "action": "The allowance could not be read or reserved in time. Retry briefly; if it persists, contact support with the hub, token ID, and timestamp."
  },
  {
    "code": 19,
    "symbol": "ErrorPackageInactive",
    "message": "packageInactive",
    "http": "403",
    "retry": "No automatic retry",
    "action": "The package is suspended or cancelled. Check its status and payment method in the dashboard."
  },
  {
    "code": 20,
    "symbol": "ErrorPackageExpired",
    "message": "packageExpired",
    "http": "403",
    "retry": "No automatic retry",
    "action": "The package period has ended. Renew it, or buy a new package, in the dashboard."
  },
  {
    "code": 21,
    "symbol": "ErrorPackageMissing",
    "message": "packageMissing",
    "http": "403",
    "retry": "No automatic retry",
    "action": "The token names a package that no longer exists. Contact support with the token ID."
  },
  {
    "code": 22,
    "symbol": "ErrorPackageStale",
    "message": "packageEntitlementStale",
    "http": "403",
    "retry": "No automatic retry",
    "action": "The hub is holding an allowance record too old to trust. Contact support with the hub, token ID, and timestamp."
  }
])

export const socksReplies = Object.freeze([
  {
    "reply": "auth 0x01",
    "meaning": "Login rejected",
    "categories": "The username/password step (RFC 1929) failed and the connection closed before any request. Most token and account checks run here: unknown, disabled or expired token or a wrong password (4), token access mismatch (5), wrong hub (8) or protocol (9), invalid PPG pool parameters (11), PPG accounting (12), insufficient balance (13), and package state (17–22). Clients usually report this as an authentication failure."
  },
  {
    "reply": "0x01",
    "meaning": "General failure",
    "categories": "Internal failure, or the upstream connection failed after the request was admitted. Commonly codes 2, 14, 15, or 16."
  },
  {
    "reply": "0x02",
    "meaning": "Connection not allowed",
    "categories": "The request was refused after login: destination or network rules (5), concurrent-connection limit (6), no available upstream (7), rate limit (10), PPG upstream selection (11), or PPG UDP that the selected upstream does not support."
  },
  {
    "reply": "0x07",
    "meaning": "Command not supported",
    "categories": "The requested SOCKS5 command is not implemented; this is not an X-Proxy-Error-Code."
  }
])
