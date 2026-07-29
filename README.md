# FWAAH!

*Fake World Assets at home* (fwaah.com) — a self-hosted FWA frontend + live dashboard that runs
entirely against **your own node** (or your own Alchemy endpoint), so you can
watch the pool and play even if the official website goes down.

Core contract: `0xB276F62DB0ce8CA2Ca5bc522695bE604521eAc1c` (mainnet).
Built on the [Corona React](https://github.com/BootstrapDash/corona-react-free-admin-template)
admin theme, modernized to react-scripts 5 + dart-sass.

## Run

Needs [Node.js](https://nodejs.org) 18+ and an Ethereum mainnet RPC — your own
node, or a free [Alchemy](https://dashboard.alchemy.com) endpoint.

```
npm install
cp .env.example .env   # then set NODE_RPC_URL to your node
npm start              # http://localhost:3000
```

`NODE_RPC_URL` is where the dev server's `/rpc` proxy forwards JSON-RPC calls
(default `http://127.0.0.1:8545`) — your own node on any host, or an Alchemy
URL. The proxy means the browser never deals with CORS. It also works inline:
`NODE_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/KEY npm start`.

## RPC resolution (works out of the box when hosted)

The app picks its RPC endpoint in this order:

1. `?rpc=<url>` query param — saved to localStorage, so visitors can point the
   hosted site at their own node once and it sticks
2. the saved localStorage override
3. on fwaah.com: `/api/rpc` — the edge-cached shared proxy (below)
4. `REACT_APP_RPC_URL` baked in at build time (forks: your node or Alchemy URL)
5. `/rpc` (the dev-server proxy)

## Hosted vs at-home mode (automatic)

The app detects which mode it's in — no config:

- **at home** (RPC is `/rpc`, localhost, or a LAN address): polls hard
  (2s node bar, 6s ticker) with zero caching. Your node, your rules.
- **hosted** (fwaah.com / the `/api/rpc` proxy / a remote https RPC): polls are
  4–5× slower and reads go through a short-TTL in-page cache, on top of the
  shared edge cache below.

Force hosted behaviour locally with `?hosted=1` to see the difference.

## Shared edge cache (`api/rpc.js`)

On fwaah.com every visitor talks to `/api/rpc`, a Vercel serverless function
that forwards to the real RPC (`RPC_UPSTREAM` env var — the Alchemy key stays
server-side, never in the client bundle). Cacheable read batches are sent as
`GET /api/rpc?q=<base64url(batch)>` with deterministic request ids, so every
visitor produces byte-identical URLs — and the function's
`s-maxage` headers let Vercel's edge serve them all from ONE upstream call per
TTL window (6s blocks, 12s contract reads, 60s logs). N visitors ≈ 1 visitor
of upstream load. Receipt polling and writes never cache. The function only
allows a whitelist of read methods, so it can't be abused as a tx relay.

## Deploying to fwaah.com

```
vercel deploy            # builds the CRA app + the api/rpc function
vercel env add RPC_UPSTREAM   # your Alchemy URL, server-side only
```

`vercel.json` carries the SPA rewrite (excluding `/api/*`) so `/dashboard`
deep-links work. On fwaah.com the site shows the big
**"fork this and get Fake World Assets At Home"** banner linking to GitHub
(`src/app/shared/ForkBanner.js` — update `GITHUB_URL` to the real repo);
preview it locally with `?forkbanner=1`.

Forks don't need Vercel at all: `npm start` against your node, or build with
`REACT_APP_RPC_URL` pointed anywhere.

## Playing (wallet)

The **Pull from the pool** panel uses your injected wallet (MetaMask etc.):

- **PULL** — quotes `acquisitionFee + vrfServiceFee` live (with gas-price
  headroom; the contract refunds overpayment in the same tx) and sends
  `acquire(maxFee, 0)` with a 5% fee-slippage bound.
- When a pull wins, the panel shows the NFT with three buttons:
  **Keep the NFT** (`keepNFT`), **Take ETH** (`acceptDepositorBid`, 85% of
  backing), or **Take FWA tokens** (`acceptBidAsTokens`, minOut set 5% under a
  simulated quote).
- Pull refunds (expiry/slippage/empty-pool) surface with a **withdraw** button.

The wallet signs everything; the app never touches keys. Reads and receipt
watching go through your own node, and pending wins are rediscovered from logs
on every refresh — safe to close and reopen anytime.

## Dashboard

- **Node status bar** — your node's host + block/age/sync/peers/base fee, 2s
  poll (the host comes from the dev server's `/rpc-target`; the hosted site
  never shows anyone's LAN address).
- **Live pulls** — three rows of tiles (6s poll): NFT art, winner
  (ENS via your node + blockies, scaffold-eth style `<FwaAddress/>`), value, age.
- **High value** — biggest wins of the last 6h, sorted by backing, 150px art.
- **Deposits** — newest NFTs listed into the pool over the last 24h, with art,
  backing and depositor.
- **Stats/charts** — pool balance, fee, listings, sequencer backlog; 24h
  acquisitions + fee volume; outcome mix; protocol health (tree invariant);
  decoded activity feed.

Note: the node caps `eth_getLogs` at 20k results per call, so wide log windows
are fetched in range chunks (see `Dashboard.refreshLogs`).
