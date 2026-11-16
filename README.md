<p align="center"><img src="public/img/quill.svg" width="88" alt="Quill"></p>

# Quill

An AI trading desk for **Robinhood Chain** (chain 4663) with a checkpoint, plus Base, Arbitrum and Ethereum. Ask in plain words; Quill reads live data, runs the **Checkpoint** on the trade, and writes you a ticket. Nothing moves until you sign it in your own wallet. The agent never holds a key.

| Area | What runs |
|---|---|
| Agent chat | Claude with read tools and `prepare_swap`. Plain-language requests become tickets you review and sign. Without an API key, a command parser handles the common requests. |
| Swap | Any pair on **Robinhood Chain** (ETH, WETH, USDG, 63 tokenized stocks and ETFs such as NVDA, TSLA, SPY, and any coin by address), and on **Base**, **Arbitrum** and **Ethereum**, through KyberSwap routes. Calldata is built on the server from a fresh route, for the known router only. |
| Checkpoint | Pre-trade checks on every quote and again right before signing (see below). |
| Check a token | Paste a contract: bytecode heuristics plus a small test buy and test sell. |
| Perp data | Hyperliquid movers, funding extremes, ticker stats and an order-book fill simulator. Read-only. |
| Limits | Operator ceiling in `data/policy.json`; each wallet can only tighten its own caps or pause. |
| Journal | Every prepare, block, build and sent transaction, with its reason. |
| API and MCP | The same tools over REST and an MCP server (`mcp/`) for Claude Code, Claude Desktop or Cursor. Execution is dry-run by default. |

## How a request flows

1. **Read.** Read tools fetch prices, books, balances and contract code. They cannot move funds.
2. **Check.** The swap is quoted, run through the Checkpoint and your limits, and turned into a ticket (chat and Swap page, valid 10 minutes) or a one-time `confirmationId` (REST/MCP, valid 120 seconds, bound to a hash of the parameters).
3. **Sign.** When you press *Re-check & sign*, the Checkpoint runs again on the live pool, the server re-quotes from scratch and returns unsigned transactions (an approval if needed, then the swap). Your wallet signs. The transaction carries a hard minimum-out from your slippage (max 5%).

## The Checkpoint

| Check | Pass | Warn | Fail |
|---|---|---|---|
| Route | a KyberSwap route via the known router | | no route |
| Price impact | under half the limit | under the limit (default 8%) | over the limit |
| Value kept | up to 3% lost in USD | up to 10% | over 10% |
| Test sell | round trip loses up to 6% | over 6% | over 20%, or no route back |
| Contract | known token, or no risky functions | mint, blacklist, fee setters, proxy, live owner | no contract code |
| Gas | up to 20% of the trade | over 20% | |
| Simulation | the exact swap succeeds from your address | balance too low, or approval needed first | it reverts |
| Limits | inside per-trade, daily, slippage caps | | over a cap, paused, kill switch, blocked token |

The contract check is a bytecode heuristic, not an audit. Token names and symbols come from the internet and are treated as untrusted text, in the UI and in the model's context.

## Run it

Node 20 or newer.

```bash
npm install
```

```bash
npm run serve
```

Then open http://127.0.0.1:9330. Quotes, the Checkpoint and perp data work with no configuration. Add `ANTHROPIC_API_KEY` to turn on the AI chat (see [`.env.example`](.env.example)):

```bash
node --env-file=.env server.mjs
```

Offline demo with simulated quotes and chain reads (also what the tests use):

```bash
npm run mock
```

## Deploy

Quill is one Node server (static app + API), so deploy it as a **Node web service**, not as a static site (Vercel static, Netlify, GitHub Pages would serve the page without its API).

- Start command: `npm start` (Railway reads `railway.json`, health check `/api/health`).
- The platform's `PORT` is used and the server listens on `0.0.0.0`; proxy headers are trusted automatically on Railway, Render, Fly and Heroku.
- Variables: `ANTHROPIC_API_KEY` for the AI chat (optional). Do **not** set `QUILL_MOCK` in production.
- Storage: limits, journal and API token hashes live in `data/`. Mount a volume and set `QUILL_DATA` to it, or they reset on every redeploy.

## API

Read tools are public. Prepare needs an API token; execute needs the `execute` scope and an `Idempotency-Key`. Tokens are stored hashed and start in dry-run.

```bash
npm run token -- my-laptop --owner 0xYourWallet --execute
```

```
GET  /api/tools                                       list tools, tiers, JSON schemas
GET  /api/tools/quote_swap?tokenIn=ETH&tokenOut=USDG&amount=0.01          # chain defaults to robinhood
GET  /api/tools/quote_swap?tokenIn=ETH&tokenOut=TSLA&amount=0.01
GET  /api/tools/check_token?address=0x…&chain=robinhood
GET  /api/tools/analyze_ticker?coin=BTC
POST /api/tools/prepare_swap      x-api-key                    {"tokenOut":"USDG","amount":"0.01"}
POST /api/tools/execute_intent    x-api-key + Idempotency-Key  {"confirmationId":"cf_…"}
```

Live `execute_intent` returns unsigned transactions for the wallet in `sender`, because Quill holds no keys.

## MCP

```bash
claude mcp add quill --env QUILL_URL=http://127.0.0.1:9330 --env QUILL_API_KEY=quill_… -- node /path/to/quill/mcp/index.mjs
```

`QUILL_LIVE=1` lets `execute_intent` reach the server; without it the MCP server answers with a dry-run notice.

## Layout

```
server.mjs        static app + JSON API on one port
src/              chains, KyberSwap routes, Checkpoint (gate.mjs), bytecode heuristics (health.mjs),
                  limits (policy.mjs), tickets (intents.mjs), journal, wallet sign-in (auth.mjs),
                  Hyperliquid reads, tool registry (tools.mjs), the Claude agent (agent.mjs), mock mode
public/           the app (vanilla JS, no build step)
mcp/              MCP server over stdio; forwards to the REST API
scripts/token.mjs create API tokens
test/             end-to-end tests in mock mode
```

## Tests

```bash
npm test
```

Covers the Checkpoint on clean and risky tokens, the per-trade cap, wallet sign-in, ticket build (approval + swap), single use, limits that only tighten, API token scopes, dry-run and idempotency, the command parser and the MCP server.

## Security notes

- Sign-in is a wallet signature over a one-time nonce; the session is an HttpOnly cookie. Browser POSTs must be JSON (CSRF guard).
- Wallet signing happens in your own wallet. The server builds transactions; it never signs.
- Calldata is only built from a server-side route, and only for the configured KyberSwap router.
- No keys, tokens or user data live in this repository. Secrets come from the environment.

## Not included

Direct Pons bonding-curve routes (coins still on a Pons curve are only tradable here if KyberSwap routes them), perp order placement, a custodial agent wallet, a Telegram bot and launch monitoring are not part of this version.

## License

MIT
