# Litport MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server for the
[Litport](https://litport.net) account API: inspect proxy tokens, usage, pools, geo targeting, and
build ready-to-use proxy connection URLs, directly from a coding agent or chat client.

The server is **read-only**. None of its tools can create, modify, delete, or disable a token, and
none of them can spend account balance — only `web/app/views/users/ports.pug`'s dashboard export and
the Litport dashboard itself do that.

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

| Tool | Calls the API? | Description |
| --- | --- | --- |
| `list_tokens` | yes | List proxy tokens, paginated by cursor; masks passwords by default. |
| `get_token_credentials` | yes | Get one token by id, including its real password. |
| `get_token_usage` | yes | Get bandwidth usage for a token, optionally by domain and/or hourly charges. |
| `list_pools` | yes | List PPG pools and the hubs they connect through. |
| `list_targeting_options` | yes | List available countries, regions, or cities for one or more pools. |
| `get_account` | yes | Get account balance and plan. |
| `explain_proxy_error` | no (local) | Look up an `X-Proxy-Error-Code` or SOCKS5 reply: what happened, whether to retry, what to do. |
| `build_proxy_url` | yes | Compose a ready-to-use proxy connection URL for a token, with pool/geo/session targeting. |
| `search_docs` | yes (public) | Search the Litport documentation index for pages matching a query. |
| `get_doc` | yes (public) | Fetch a Litport documentation page as markdown. |

All ten tools are annotated `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`.

### build_proxy_url and the two token types

A **pay-per-GB** token is request-selected: `build_proxy_url` appends the pool, geo and session
segments to the username and picks the port matching the chosen protocol. A token with a saved pool
takes no `pool` argument and refuses a conflicting one; a token without a saved pool requires `pool`,
because the pool sets the price.

An **unlimited** token is assigned exactly one endpoint, so it takes no pool, geo or session
arguments — passing them is refused by name rather than silently producing a username the proxy
rejects. If its hub is no longer in service, the tool says so instead of returning a broken URL.

Parameters are validated against the published rules before anything is returned, so a malformed
country slug or an out-of-range session lifetime is reported without spending a request.

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `LITPORT_API_KEY` | yes | Your Litport account API key (`lit_…`/`ltp_…`). |
| `LITPORT_API_URL` | no | Override the API base URL. Defaults to `https://litport.net`. |
| `LITPORT_MCP_REVEAL_CREDENTIALS` | no | Set to `1` to have `list_tokens` return real passwords. |

## Development

```sh
npm install
npm test               # node --test test/
# src/contracts.generated.js is regenerated from the Litport application repository,
# not from this one — see Contracts below.
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
