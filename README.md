# Litport MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server for the
[Litport](https://litport.net) API: inspect proxy tokens, usage, packages, and pay-per-GB
pools/geo targeting; change a token's location, rotation interval, or get a new IP; manage a
package's allowed-IP list; and build ready-to-use proxy connection URLs — directly from a coding
agent or chat client.

The server cannot create, buy, renew, cancel, or disable a token or package, reset credentials, or
spend account balance. It can change a token's location and rotation interval, request a new IP for
a static datacenter/ISP token, and add, remove, or set a package's allowed IPs.

## Install and configure

Create an API key at [litport.net/users/settings](https://litport.net/users/settings), then add the
server to your MCP client's config with `LITPORT_API_KEY` in its `env` block.

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
model's context until a specific token is named.

## Tools

| Tool | Calls the API? | Writes? | Description |
| --- | --- | --- | --- |
| `list_tokens` | yes | | List proxy tokens, paginated by cursor and an optional `packageId` filter; masks passwords by default. |
| `get_token_credentials` | yes | | Get one token by id, including its real password. |
| `get_token_usage` | yes | | Get bandwidth usage for a token, optionally by domain and/or hourly charges. |
| `get_token_location` | yes | | Get a token's current location/carrier target and whether it can change now. |
| `list_location_options` | yes | | List the region/city (datacenter/ISP) or city/carrier (mobile) values a token can move to. |
| `set_token_location` | yes | yes | Change a token's location (and carrier, for mobile). |
| `set_rotation` | yes | yes | Change a token's rotation interval. |
| `get_new_ip` | yes | yes | Replace a static datacenter/ISP token's IP, using its weekly allowance. Not safe to blindly retry. |
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

The read tools are annotated `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`.
Every write tool documents in its own description whether it changes something and whether it is
safe to repeat; `get_new_ip` is the one exception (`idempotentHint: false`) — see below.

### Token location, rotation, and new IP

`set_token_location` sends only the keys you give it — `region`/`city` for a datacenter/ISP token,
or `city`/`carrier` for a mobile token — so give exactly one of those two shapes. It is safe to
repeat: resending the already-saved target is a no-op. A standard US Shared Mobile token allows this
once per 48 hours; on a `409 CHANGE_LIMIT` the error carries `nextChangeAt` and a `Retry-After`
header, both of which the tool surfaces, so the model knows when it can try again instead of
retrying blindly.

`set_rotation` changes a token's rotation interval to one of its own `rotation.options` values, and
answers `NOT_SUPPORTED` when `rotation.changeable` is false (e.g. a Multi-location mobile token,
whose interval always follows its current phone).

`get_new_ip` requests a new IP for a static datacenter/ISP token, spending its weekly allowance. It
is **not safe to blindly retry**: call `get_token_location` first and check
`canChangeNow`/`nextChangeAt`, because a second call inside the same week fails with
`CHANGE_LIMIT` rather than returning a second new IP. If a call's result is lost or ambiguous,
re-read `get_token_location` instead of calling it again.

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
| `LITPORT_API_KEY` | yes | Your Litport API key (`lit_…`/`ltp_…`). |
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
