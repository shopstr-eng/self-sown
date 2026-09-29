# @self-sown/cli

Terminal client for the [Self-Sown](https://self-sown.com) marketplace. Built
for AI agents that live in a terminal (and humans who prefer one): search the
catalog, mint a free shopping API key, and complete a checkout end to end —
no browser, no membership required for shopping.

Seller-side tooling (listing management, order fulfillment, storefront
settings) lives in the Self-Sown MCP server, not this CLI. The `onboard`
response includes your `mcpEndpoint` if you need it.

## Requirements

Node.js >= 18 (uses the built-in global `fetch`; zero runtime dependencies).

## Install

```bash
npm install -g @self-sown/cli
# or run without installing:
npx @self-sown/cli --help
```

## Quickstart (agents)

```bash
# 1. Mint a free shopping API key (no account or membership needed)
selfsown onboard --name my-shopping-agent --save

# 2. Search the public catalog
selfsown search "raw milk" --limit 5

# 3. Look up a product
selfsown product <product-id>

# 4. Create a checkout session
selfsown checkout create --product <product-id> --quantity 1 \
  --email buyer@example.com --shipping-address '{"zip":"97301"}'

# 5. Pay per the session's payment instructions, then complete
selfsown checkout status <session-id>
selfsown checkout complete <session-id>
```

Every command prints JSON to stdout. Errors print JSON to stderr and exit 1
(exit 2 for usage errors). Pass `--raw` for compact single-line output.

## Commands

| Command                          | Auth         | Description                                                                                                                                                                                                                                                                   |
| -------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onboard --name <n> [--save]`    | none         | Mint a free shopping API key. `--save` writes it to `~/.config/selfsown/config.json` (mode 600). The key is shown once — save it.                                                                                                                                             |
| `search <query>`                 | none         | Search the catalog. Flags: `--category`, `--seller`, `--availability in_stock\|out_of_stock`, `--location`, `--limit`, `--offset`.                                                                                                                                            |
| `product <id>`                   | none         | Fetch one product by id, or `--slug <s> --pubkey <seller-pubkey>`.                                                                                                                                                                                                            |
| `checkout create --product <id>` | shopping key | Create a checkout session. Options: `--quantity`, `--email`, `--variant`, `--size`, `--volume`, `--weight`, `--bulk-units`, `--discount-code`, `--payment-method`, `--mint-url`, `--cashu-token`, `--fiat-method`, `--subscription-frequency`, `--shipping-address '<json>'`. |
| `checkout list`                  | shopping key | List your checkout sessions (`--limit`, `--offset`). Sessions are private to the API key that created them.                                                                                                                                                                   |
| `checkout status <session-id>`   | shopping key | Fetch one session's state.                                                                                                                                                                                                                                                    |
| `checkout complete <session-id>` | shopping key | Idempotently finalize a paid session.                                                                                                                                                                                                                                         |
| `version`                        | none         | Print the CLI version.                                                                                                                                                                                                                                                        |

## Configuration

Resolved in order: `--api-key` flag → `SELF_SOWN_API_KEY` env var →
`~/.config/selfsown/config.json` (written by `onboard --save`).

Point at another deployment with `--base-url <url>` or `SELF_SOWN_BASE_URL`
(default `https://self-sown.com`).

Rate limits: when the API returns 429, the error JSON includes
`retryAfterSeconds` — wait that long and retry.

## Programmatic use

```js
import { main } from "@self-sown/cli";

const exitCode = await main(["search", "honey"]);
```

## License

GPL-3.0-only — see LICENSE.
