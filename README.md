# FWAAH!

<img width="1726" height="1136" alt="image" src="https://github.com/user-attachments/assets/142d0d09-1931-42ec-88ab-c620ec623582" />

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
allows a whitelist of read methods (so it can't be abused as a tx relay) and
rejects cross-site referrers, so other websites can't use it as their free
mainnet RPC.
Big cacheable batches (the ticker's ~60 art lookups, a page-load ENS flush)
are split client-side into fixed 20-call groups so each stays on the shared
GET path instead of falling back to an uncached per-visitor POST.

## NFT metadata proxy (`api/meta.js`)

Several big collections' metadata servers (Art Blocks, Milady, VeeFriends,
Opepen) send no CORS headers, so the browser can't fetch their tokenURI JSON
directly. The client tries the direct fetch first and falls back to
`GET /api/meta?u=<url>`, which fetches server-side and replays the response
with CORS headers — edge-cached for a day, so all visitors share one upstream
hit per token. A per-host memo skips the doomed direct attempt after the
first failure. The function refuses private/internal hosts (re-checked on
every redirect hop, so a public URL can't 302 to your LAN or cloud metadata),
caps responses at 5MB, and rejects cross-site referrers so other sites can't
hotlink through it. `npm start` serves a dev twin of the route from
`setupProxy.js` with the same host guards (shared via `api/_shared.js`), so
forks get working art without Vercel — and without an open fetch proxy on
their home network.

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

Connect via the **CONNECT button in the navbar** (a chip with your
address + a disconnect ✕ replaces it once connected — disconnect is
remembered across reloads). Any connect broadcasts to every panel, so
deposits/earnings appear without a refresh.

- **Deposit an NFT** — pick a whitelisted collection, paste the tokenId,
  choose the ETH backing (min shown live). Ownership, whitelist and
  approval are checked with cheap `eth_call`s first; then approve →
  `listNFT` with the backing as `msg.value`. (Browsing your NFTs across 61
  collections would need an indexer — manual entry doesn't.)

The **Pull from the pool** panel uses your injected wallet (MetaMask etc.):

- **PULL** — quotes `acquisitionFee + vrfServiceFee` live (with gas-price
  headroom; the contract refunds overpayment in the same tx) and sends
  `acquire(maxFee, 0)` with a 5% fee-slippage bound.
- When a pull wins, the panel shows the NFT with three buttons:
  **Keep the NFT** (`keepNFT`), **Take ETH** (`acceptDepositorBid`, 85% of
  backing), or **Take FWA tokens** (`acceptBidAsTokens`, minOut set 5% under a
  simulated quote).
- Pull refunds (expiry/slippage/empty-pool) surface with a **withdraw** button.
- In-flight pulls show a **progress bar** calibrated from measured history
  (median ~2.4 min, 90% land inside 5 — see `PULL_*` in `PullPanel.js`).
- **Your deposits** (wallet connected): your NFTs currently in the pool, with
  art, backing and OpenSea links. Found via a depositor-filtered `NFTListed`
  log walk — the newest day paints first, deepening to ~7d in the background
  (2 RPC calls per poll after that; the per-item status sweep runs on the
  slow cadence). The panel also totals your **fee earnings** (withdrawable
  credit + each listing's pending share) with a **withdraw** button —
  `claimListingFees` settles pending into credit, then `withdrawEarnings`
  pays out (two wallet prompts when both are needed).

The wallet signs everything; the app never touches keys. Reads and receipt
watching go through your own node, and pending wins are rediscovered from logs
on every refresh — safe to close and reopen anytime.

## Dashboard

- **Node status bar** — your node's host + block/age/sync/peers/base fee, 2s
  poll (the host comes from the dev server's `/rpc-target`; the hosted site
  never shows anyone's LAN address).
- **Happening now** — a chat-style strip of the last few blocks of protocol
  events pinned to the top (new lines slide in each poll), with a button that
  jumps to the full 24h activity table.
- **Live pulls** — three rows of tiles (6s poll): NFT art, winner
  (ENS via your node + blockies, scaffold-eth style `<FwaAddress/>`), value,
  age. Each win tile's border shows the puller's decision: grey = undecided,
  red = kept the NFT, green = took the ETH, pink = took FWA tokens.
- **High value** — biggest wins of the last 6h, sorted by backing, 150px art.
- **Deposits** — newest NFTs listed into the pool over the last 24h, with art,
  backing and depositor.
- **Stats/charts** — pool balance, fee, listings, sequencer backlog; 24h
  acquisitions + fee volume; outcome mix; protocol health (tree invariant,
  pull EV = the pool's harmonic-mean backing, per-listing fee income over
  24h); decoded activity feed.
- **Top Listing** — the top-pot side game: the single biggest-backed listing
  earns `topListingShareBps` of every pull into a growing pot. Shows the
  NFT's art, the pot, its ≈ETH/day growth, and the backing needed to seize
  the top (current × (1 + threshold)).
- **Rules of the Game** — every owner-tunable knob, read live where the
  contract has a getter (surcharge is derived from fee/EV): pull pricing,
  sell-back payout + owner cuts, top-pot share/threshold, settlement windows,
  kill switches (pulls / withdraw-only / whitelist / FWA sell-back). Knobs
  without getters (min backing, the switches) come from a verified
  `ConfigSet`-history snapshot overlaid with a 7-day event scan, so a knob
  turn shows up within one poll. A **rule changes** feed lists the owner's
  recent `ConfigSet` / whitelist / ownership moves, and admin events also
  land in the main activity feed.
- **Allowed Collections** — deposits are whitelist-gated; the card lists the
  allowed collections by name (snapshot + live overlay).
- **FWA Token Emission** — the rewards module's 15-day emission window as a
  countdown + progress bar (goes red under 3 days), the depositor rate
  (√backing-weighted) and the daily puller pot, read live from the module
  the pool points at.
- **Contracts & Keys** — who holds what: owner, fee payout, whitelist
  manager, and the pool / token / rewards / VRF-service contract addresses.

Note: the node caps `eth_getLogs` at 20k results per call, so wide log windows
are fetched in range chunks (see `Dashboard.refreshLogs`).

## License

MIT — see [LICENSE](LICENSE). Fork away.
