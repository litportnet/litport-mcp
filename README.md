# Litport MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server for the
[Litport](https://litport.net) API: inspect proxy tokens, usage, packages, and pay-per-GB
pools/geo targeting; create, change, reissue the credentials of, and delete pay-per-GB proxies;
change a token's location, rotation interval, or get a new IP; manage a package's allowed-IP list;
build ready-to-use proxy connection URLs; and contact Litport support — directly from a coding
agent or chat client.

The server cannot buy, renew, or cancel a package, or top up or move account balance. It can create
and delete pay-per-GB proxies, which are live and billed per GB from the account balance as they are
used. It can change a pay-per-GB proxy's label, on/off switch, pool, expiry, and traffic cap, and
reissue the credentials of any proxy the account owns. A package's proxies can only be relabelled or
have their credentials reissued; they end with their package. It can also change a token's location
and rotation interval, request a new IP for a datacenter/ISP token, and add, remove, or set a
package's allowed IPs.

## Install and configure

Create an API key at [litport.net/users/settings](https://litport.net/users/settings), then add the
server to your MCP client's config with `LITPORT_API_KEY` in its `env` block.

The key is optional. Without one the server offers only the [support tools](#contact-support) and
the three tools that need no account (`explain_proxy_error`, `search_docs`, `get_doc`).

### Claude Code

```sh
claude mcp add litport -e LITPORT_API_KEY=lit_your_key_here -- npx -y @litportnet/litport-mcp
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "litport": {
      "command": "npx",
      "args": ["-y", "@litportnet/litport-mcp"],
      "env": {
        "LITPORT_API_KEY": "lit_your_key_here"
      }
    }
  }
}
```

### Claude Desktop

Add the same block to `claude_desktop_config.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "litport": {
      "command": "npx",
      "args": ["-y", "@litportnet/litport-mcp"],
      "env": {
        "LITPORT_API_KEY": "lit_your_key_here"
      }
    }
  }
}
```

### Cursor

Add the same block to `.cursor/mcp.json`, or use Cursor's Settings → MCP → Add new MCP Server with
command `npx -y @litportnet/litport-mcp` and `LITPORT_API_KEY` in the environment variables field.

## Credential exposure — two options

Proxy tokens carry a `username`/`password` pair. Putting every password from `list_tokens` into the
model's context by default is unnecessary exposure for a browse operation, so the server ships two
ways to reach a real password:

| Option | Behavior |
| --- | --- |
| Default (`LITPORT_MCP_REVEAL_CREDENTIALS` unset) | `list_tokens` masks each token's `password` (`null`, with `passwordSet: true`), and adds a `hint` pointing at `get_token_credentials` or `build_proxy_url`. `get_token_credentials` and `build_proxy_url` always return the real password for the one token requested. |
| `LITPORT_MCP_REVEAL_CREDENTIALS=1` | `list_tokens` returns every password unmasked, alongside everything else. |

Either way, nothing is ever permanently unreachable — the default just keeps bulk listings out of the
model's context until a specific token is named. `create_token` and `reissue_credentials` return
the one proxy's username and password the same way `get_token_credentials` does, by design: the
real values are in the result, whatever `LITPORT_MCP_REVEAL_CREDENTIALS` says. `update_token` and
`delete_token` never return credentials, so a label, cap or on/off change does not put a password
into the model's context.

## Tools

| Tool | Calls the API? | Writes? | Description |
| --- | --- | --- | --- |
| `list_tokens` | yes | | List proxy tokens, paginated by cursor and an optional `packageId` filter; masks passwords by default. |
| `get_token_credentials` | yes | | Get one token by id, including its real password. |
| `get_token_usage` | yes | | Get bandwidth usage for a token, optionally by domain and/or hourly charges. |
| `get_usage` | yes | | Get daily usage for many proxies at once over a date range, deleted proxies included, with the daily charge for pay-per-GB proxies. |
| `get_token_location` | yes | | Get a token's current location/carrier target and whether it can change now. |
| `list_location_options` | yes | | List the region/city (datacenter/ISP) or city/carrier (mobile) values a token can move to. |
| `set_token_location` | yes | yes | Change a token's location (and carrier, for mobile), or send `random: true` for another location the proxy can use right now. |
| `set_rotation` | yes | yes | Change a token's rotation interval. |
| `get_new_ip` | yes | yes | Get a new IP for a datacenter/ISP token. A static token uses its weekly allowance; a rotating one has a short wait between calls. Not safe to blindly retry on a static token. |
| `create_token` | yes | yes | Create a live pay-per-GB proxy, optionally locked to a pool, with a label, your own `externalRef`, an expiry and a traffic cap. Returns its credentials. Send `externalRef` so a retry cannot create a second proxy. |
| `update_token` | yes | yes | Change a pay-per-GB proxy's label, on/off switch, pool, expiry or traffic cap (a package's proxy takes a label only). Returns the proxy without its credentials. |
| `reissue_credentials` | yes | yes | Issue a new username, password and change-IP key for a proxy. The old password stops and its open connections close. A `requestId` makes a retry safe. |
| `delete_token` | yes | yes | Delete a pay-per-GB proxy. Its history and usage stay. Returns no credentials. |
| `list_packages` | yes | | List proxy packages: product, status, add-ons, limits, dates, and token IDs. |
| `get_package` | yes | | Get one package by its public numeric ID. |
| `get_allowed_ips` | yes | | Get a package's allowed-IP list and limit. |
| `set_allowed_ips` | yes | yes | Set a package's whole allowed-IP list at once. |
| `add_allowed_ip` | yes | yes | Add one IP to a package's allowed-IP list. |
| `remove_allowed_ip` | yes | yes | Remove one IP from a package's allowed-IP list. |
| `list_pools` | yes | | List pay-per-GB pools and the hubs each connects through. |
| `list_targeting_options` | yes | | List available countries, regions, or cities for one or more pools. |
| `get_balance` | yes | | Get the account's pay-per-GB balance and plan. |
| `explain_proxy_error` | no (local) | | Look up an `X-Proxy-Error-Code` or SOCKS5 reply: what happened, whether to retry, what to do. |
| `build_proxy_url` | yes | | Compose a ready-to-use proxy connection URL for a token, with pool/geo/session targeting or a passwordless allowed-IP endpoint. |
| `search_docs` | yes (public) | | Search the Litport documentation index for pages matching a query. |
| `get_doc` | yes (public) | | Fetch a Litport documentation page as markdown. |
| `contact_support` | yes (works without a key) | yes | Start a support conversation with a first message. |
| `get_support_replies` | yes (works without a key) | | Read a support conversation and its replies. |
| `reply_to_support` | yes (works without a key) | yes | Add a message to a support conversation. |

The read tools are annotated `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`.
Every write tool documents in its own description whether it changes something and whether it is
safe to repeat; `get_new_ip`, `create_token` and `reissue_credentials` are the exceptions
(`idempotentHint: false`) — see below.

When the API refuses a call, the tool's error text holds the API's message, `code`, `retryable`,
`nextChangeAt` and `Retry-After` (whichever it sent) and a docs link. `retryable: true` means the
same call, sent again unchanged after the wait, can succeed and is safe to send; `false` means
change something first, or, after an unclear failure of a call that is not safe to repeat, read the
current state before deciding.

### Contact support

Three tools reach Litport support through the [support API](https://litport.net/docs/api/support).

| Tool | Arguments | What it does |
| --- | --- | --- |
| `contact_support` | `message`, `email` | Starts a conversation with a first message. |
| `get_support_replies` | `conversationId`, `after` | Reads the conversation. `after` is the highest message `seq` already received. |
| `reply_to_support` | `message`, `conversationId` | Adds a message. |

**Without `LITPORT_API_KEY`** the conversation is a guest one. `contact_support` requires `email`
(where we can reach you), and a guest conversation can answer general questions only. The access
token that the API returns once stays in the server process for the session and is never shown to the
model, so a guest conversation can be read only by the session that started it. Litport limits new
guest conversations to 3 per hour and 10 per day per IP address.

**With `LITPORT_API_KEY`** the tools use your account's own conversation, where support can help with
your orders and proxies. `email` is not used.

`conversationId` defaults to the conversation started or used most recently in the session. Replies
are not pushed: `get_support_replies` returns `pollAfterSeconds` (30), so poll about that often.
Messages are limited to 4,000 characters and 30 per conversation per 24 hours, and the API takes no
attachments. Do not put API keys or proxy passwords in a message. You can also email
[mike@litport.net](mailto:mike@litport.net).

### Token location, rotation, and new IP

`set_token_location` sends only the keys you give it — `region`/`city` for a datacenter/ISP token,
or `city`/`carrier` for a mobile token — so give exactly one of those two shapes. With those, it is
safe to repeat: resending the already-saved target is a no-op. A standard US Shared Mobile token
allows this once per 48 hours; on a `409 CHANGE_LIMIT` the error carries `nextChangeAt` and a
`Retry-After` header, both of which the tool surfaces, so the model knows when it can try again
instead of retrying blindly.

`random: true` (sent alone, without `region`, `city`, `carrier` or `country`; the tool refuses the
mix without calling the API) moves the token to another location it can use right now: a different
city when there is one, and for a mobile token otherwise another carrier in the same city. It is
saved as the target like any other change, and the same waits apply. It is **not safe to repeat
blindly**: each repeat moves the proxy again wherever no wait applies, so after a lost result read
`get_token_location` first. `409 LOCATION_UNAVAILABLE` means no other location is available; nothing
changed.

`set_rotation` changes a token's rotation interval to one of its own `rotation.options` values, and
answers `NOT_SUPPORTED` when `rotation.changeable` is false (e.g. a Multi-location mobile token,
whose interval always follows its current phone).

`get_new_ip` requests a new IP for a datacenter/ISP token. On a static token it spends the weekly
allowance and is **not safe to blindly retry**: call `get_token_location` first and check
`canChangeNow`/`nextChangeAt`, because a second call inside the same week fails with
`CHANGE_LIMIT` rather than returning a second new IP. If a call's result is lost or ambiguous,
re-read `get_token_location` instead of calling it again.

On a rotating token it works at any time. The new IP is always different from the current one, and
the token's automatic timer restarts. Two calls must be at least the type's shortest rotation
interval apart (the smallest value in the token's `rotation.options`); inside that wait the call
fails with `CHANGE_LIMIT`, `nextChangeAt` and `Retry-After`. `LOCATION_UNAVAILABLE` means no other IP
qualifies right now: nothing changed, and the call still uses up the wait. After a lost result,
`get_token_location` cannot confirm the change (its `canChangeNow`/`nextChangeAt` are about the
location, not this wait). Calling again after `Retry-After` is harmless and just gives another new
IP; a `CHANGE_LIMIT` right after a lost result does not prove the change happened.

### Pay-per-GB proxy writes

`create_token`, `update_token`, `reissue_credentials` and `delete_token` change live proxies on the
account, so each says so in its description. Writes share the API key's 120 requests per minute.

- **Create.** `create_token` takes `pool` (a pool `authKey` from `list_pools`; leave it out for a
  proxy that picks its pool per request), `label`, `externalRef`, `expiresAt` and `allowanceBytes`.
  It needs a positive balance and an account that is not blocked. **Always send `externalRef`**
  (your own reference, such as your customer's id): a repeat with the same value returns the proxy
  that exists instead of creating a second one, so a timed-out call can be repeated. Without it, a
  repeat creates another proxy. An account can create only so many new proxies per minute, API keys
  and the dashboard together (a repeat of an existing `externalRef` does not count): past it the
  call answers `429 RATE_LIMITED` with a `Retry-After`, and the same call can be sent again after it.
- **Change.** `update_token` sends only the fields you give it; `null` clears `label`, `pool`,
  `expiresAt` or `allowanceBytes`. Switching a proxy on needs a positive balance; switching it off,
  relabelling, and changing the expiry or cap work with an empty balance, so a customer can always
  be cut off. A package's proxy takes `label` only (`FIELD_NOT_ALLOWED` otherwise). The result
  holds the proxy's `id`, `status`, `label`, `externalRef`, pool, cap and expiry, and never its
  username, password or change-IP link; call `get_token_credentials` for those.
- **Traffic cap.** `allowanceBytes` counts all traffic in both directions, protocol overhead
  included, so it is never less than the traffic charged in usage. A proxy can stop a little short
  of its cap, never over it. `allowanceReservedBytes` on a token is what has been set aside against
  the cap; it is not the charged usage. Adding, changing or removing a cap ends the proxy's open
  connections once.
- **Reissue.** `reissue_credentials` replaces the username, password and change-IP key. The old
  password stops and its open connections close; a package's allowed IPs keep working. Use a **new**
  `requestId` for every reissue you mean, and the same one only to retry a call whose answer you did
  not get. Without a `requestId` every call issues a new pair.
- **Delete.** `delete_token` soft-deletes a pay-per-GB proxy and answers with the token id and
  `deleted: true`, never credentials. Its usage stays readable and its `externalRef` can be used
  again. A package's proxies can not be deleted (`NOT_SUPPORTED`).
- **Usage for many proxies.** `get_usage` returns daily usage for up to 100 named proxies, or all of
  them, with `costUnits` per day for pay-per-GB proxies. Deleted proxies are included; one with no
  usage in the range appears only when named in `tokenIds`. The range is at most 92 days and the API
  allows 10 of these calls per minute per key.

### Package allowed-IP writes

The MCP server exposes `set_allowed_ips` (the whole list at once), `add_allowed_ip`, and
`remove_allowed_ip` for exact public IPv4 addresses. IPv6 is unsupported; contact support. They
identify an address by the IP itself — no address ID and no revision precondition. The latest
committed, successful call wins; adding an address already active, or removing one already absent,
is a no-op. `remove_allowed_ip` is marked destructive because it removes passwordless access from an
IP; `set_allowed_ips` is too, because an omitted address is removed. A package includes one IPv4
address or supports up to 50 with the add-on; contact support after reaching 50. The passwordless
endpoint itself lives on each token as `ipAuth` (`list_tokens`/`get_token_credentials`), not here.

### build_proxy_url and the two token types

A **pay-per-GB** token is request-selected: `build_proxy_url` appends the pool, geo and session
segments to the username and picks the port matching the chosen protocol. A token with a saved pool
takes no `pool` argument and refuses a conflicting one; a token without a saved pool requires `pool`,
because the pool sets the price.

An **unlimited** token is assigned exactly one endpoint, so it takes no pool, geo or session
arguments — passing them is refused by name rather than silently producing a username the proxy
rejects, and no pools request is made for it at all. If its hub is no longer in service, the tool
says so instead of returning a broken URL. Passing `passwordless: true` on an unlimited token builds
a credential-free URL from its `ipAuth` endpoint instead — see `add_allowed_ip` first if `ipAuth` is
still `null`.

Parameters are validated against the published rules before anything is returned, so a malformed
country slug or an out-of-range session lifetime is reported without spending a request.

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `LITPORT_API_KEY` | no | Your Litport API key (`lit_…`/`ltp_…`). Needed for every tool except the support and documentation tools. |
| `LITPORT_API_URL` | no | Override the API base URL. Defaults to `https://litport.net`. |
| `LITPORT_MCP_REVEAL_CREDENTIALS` | no | Set to `1` to have `list_tokens` return real passwords. |

## Development

```sh
npm install
npm test               # node --test test/
npm run generate-contracts   # regenerate src/contracts.generated.js from the web app
```

`src/contracts.generated.js` is generated from the web application's canonical contract modules and
is never hand-edited.

## License

MIT

## Contracts

`src/contracts.generated.js` vendors the proxy error reference and pay-per-GB parameter rules from
the Litport web application, so `explain_proxy_error` and `build_proxy_url` answer without a network
call. It is generated, not hand-edited, and a parity check in the application fails if the two ever
disagree. Regenerate with `npm run generate-contracts` from the copy inside the Litport
application repository, where the source contracts live.
