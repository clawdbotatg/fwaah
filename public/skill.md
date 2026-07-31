---
name: fwaah
description: Answer questions about the FWA pool (Fake World Assets, Ethereum mainnet) — pull price, pool stats, rules, whitelist, emissions, the Crown — using fwaah.com's live JSON snapshot, and go deeper on-chain with the bundled addresses, ABIs, selectors, and event topics.
---

# FWAAH! agent skill — the FWA pool, machine-readable

You are helping a user understand **FWA (Fake World Assets)**, an NFT liquidity
game on Ethereum mainnet, via **fwaah.com** ("Fake World Assets at home"), an
open-source dashboard for it. This file is self-contained: mechanics first,
then the live data feed, then everything needed to read the chain directly.

## Get live data (do this first)

```
curl -s https://fwaah.com/livedatasnapshot.json
```

One pre-decoded JSON document with the whole pool state. It is edge-cached
(~60s fresh, served stale up to 10 min while revalidating) — poll it freely,
it costs the site at most one RPC refresh per minute no matter how many
agents ask. Prefer it over raw chain reads for anything it already answers.

Running a fork at home? The same path exists on your own origin (the dev
server builds it against your `NODE_RPC_URL`), e.g. `http://localhost:3000/livedatasnapshot.json`.

### Snapshot field guide

| section | what's in it |
| --- | --- |
| `block`, `generatedAt` | mainnet block + wall time the snapshot was built at |
| `contracts` | core / token / rewards / VRF addresses, owner, payout, whitelist manager, deploy block, Sourcify source+ABI URLs |
| `pool` | active listing count, pool ETH balance, **current pull price** (`pullPriceEth`), pending/unsettled pulls, escrow, accrued owner fees |
| `crown` | the top-backed listing: which NFT, its backing, its pot (see mechanics) |
| `activity24h` | last-24h totals: pull count, total pull fees in ETH, deposits, withdrawals, and a `pullOutcomes` tally (kept / sold back for ETH / sold back for FWA / relisted / defaulted / refunded) |
| `recentPulls` | last 15 pulls, newest first: which NFT (collection name + tokenId), its backing, the winner, and the **outcome** — "kept the NFT", "sold back for X ETH", "pending — winner choosing", … — plus tx hash and approx time |
| `topPulls24h` | the 5 highest-backing NFTs pulled in the last 24h, same shape |
| `recentDeposits` | last 10 NFTs listed into the pool: collection, tokenId, backing, depositor |
| `recentRuleChanges` | latest owner knob turns and whitelist edits, human-labeled (e.g. "pull surcharge (bps) → 500", "whitelist: Bold Pepes allowed"), with tx hashes — check here before assuming a rule is stable |
| `rules` | every owner-tunable knob, live: surcharge, sell-back payout, owner cuts, crown tithe/threshold, windows, min backing, max pulls/tx, kill switches (`pullsEnabled`, `withdrawOnlyMode`), whitelist on/off |
| `emission` | FWA token emission schedule: start/end ISO timestamps, `secondsRemaining`, `ended`, FWA/day to depositors and pullers, total supply, whether external buys are open, buyback pool ETH |
| `whitelist` | `enabled` flag + the full list of collections allowed to deposit, `{address, name}` |

## How the game works (mechanics)

- **Deposit:** anyone lists a whitelisted NFT with ETH backing (≥
  `rules.minDepositBackingEth`). The NFT sits in the pool; the backing is the
  depositor's ask.
- **Pull:** anyone pays the pull fee (`pool.pullPriceEth`) for a *random* NFT.
  Selection weight is **inverse to backing** — cheap listings get pulled more
  often. The fee is the harmonic-mean expected value of the pool ×
  (1 + `rules.pullSurchargeBps`). Randomness comes from VRF, so a pull
  resolves over a few blocks (`pendingPulls` → allocated).
- **Winner's choice:** after an NFT is allocated, the winner has
  `rules.winnerSettlementWindowSeconds` (24h) to either **keep the NFT**,
  **sell it back** for `rules.sellBackPayoutBps` (85%) of its backing in ETH,
  or take the sell-back value in **FWA tokens** instead. Unsettled pulls
  finalize after `rules.finalizeWindowSeconds`.
- **Fees:** each pull's fee is split **equally across active listings** (not
  by weight) — depositors earn fees while they wait. Owner cuts and the crown
  tithe come off the top; the surcharge splits between depositor fees and the
  puller's FWA allowance on a hot/cold timing gap (official docs).
- **The Crown:** the top-backed listing is "the Crown" — it earns
  `rules.crownTitheBps` of every pull into its own pot (`crown.potEth`),
  claimable by its depositor. Taking the crown requires backing at least
  `rules.crownTakeoverThresholdBps` higher than the current holder's.
- **Whitelist:** when `whitelist.enabled` is true, only listed collections can
  be deposited. Pulling is never gated.
- **Emissions:** for a fixed window (see `emission.startsAt` → `endsAt`) the
  rewards module streams FWA tokens: a per-second drip to depositors
  (weighted by √backing) and a daily pot split across the day's pullers.
  Protocol fees fund FWA buybacks (split depositors / purchasers / burn).
  While `emission.externalBuysOpen` is false, FWA can be sold but not bought
  on the open market.

### Answering common questions

- **"Is collection X allowed yet?"** — case-insensitively match X against
  `whitelist.collections[].name` (and address). In the list → deposits open.
  Not in the list while `whitelist.enabled` → can't be deposited yet. If
  `whitelist.enabled` is false, everything is allowed.
- **"When do emissions stop?"** — `emission.endsAt` (ISO) /
  `emission.secondsRemaining`. If `emission.ended`, they already have.
- **"What happens when emissions stop?"** — the FWA drip to depositors and
  the daily puller pot stop accruing; the core ETH game (deposit, pull, fees,
  the Crown) continues unchanged. Post-emission parameter changes are decided
  by the owner via on-chain `ConfigSet` events — check `rules` in a fresh
  snapshot rather than assuming, and note that any claim about *future* knob
  values is speculation.
- **"What does a pull cost right now / what's in the pool?"** — `pool`.
- **"Who holds the Crown?"** — `crown` (NFT, backing, pot, depositor).
- **"What's been pulled lately / any big pulls?"** — `recentPulls` and
  `topPulls24h`, each with the NFT, backing, winner, and outcome.
- **"How active is the pool / do winners keep or sell?"** — `activity24h`:
  volume, fee flow, and the outcome split (sell-backs vs keeps is a good
  read on whether pullers are in it for the NFTs or the ETH/FWA).
- **"Did the rules change recently?"** — `recentRuleChanges` (each entry has
  a tx hash to cite).

## Going deeper: direct chain access

Everything below lets you verify or extend the snapshot on-chain. Use your
own RPC endpoint for heavy work (log scans, per-listing walks).

**Contracts (Ethereum mainnet, chainId 1):**

- Core pool `FWA`: `0xB276F62DB0ce8CA2Ca5bc522695bE604521eAc1c` (deployed at block 25546793)
- FWA token, rewards module, VRF service: live addresses in `contracts` — the
  core exposes `token()`, `rewards()`, `vrfService()` getters.
- **Full verified source + ABI** (Sourcify; Etherscan v1 API is dead):
  `https://sourcify.dev/server/v2/contract/1/<address>?fields=sources,abi`
- Humans can poke it at `https://abi.ninja/0xB276F62DB0ce8CA2Ca5bc522695bE604521eAc1c/1`

**Useful view selectors on the core** (call with `eth_call`, 32-byte-word args):

```
activeListingCount() 0x4681a7c6      acquisitionFee() 0x38f5f005
totalWeight() 0x96c82e57             weightedBackingTotal() 0xd6eb0dbd
topListingId() 0xee35bc33            topListingPot() 0xba20687b
listings(uint256) 0xde74e57b         quoteAcquisitionPrice() 0x987df4cd
collectionWhitelisted(address) 0x666cd313
feeCredit(address) 0x5c584c88        pendingFees(uint256) 0xa2b93478
acquisitions(uint256) 0x41111a4a
```

On the rewards module: `emissionStart() 0x513da948`,
`EMISSION_DURATION() 0x2d9c4dd2`, `depositorRatePerSec() 0xd2b48fff`,
`purchaserDailyPot() 0xfb894e65`, `isBuying() 0x24f0aa72`.

**Key event topics (topic0) on the core:**

```
NFTListed              0x01c953cf171a8c32b553c5b7e0964bae6b2123db065615e54e8425fec3ec16cd
AcquisitionRequested   0xf23e34f4aa4a06ecddd309d9692e7b7ca45b76fd0d5f4ce4f7fbf29731d9abd6
NFTAllocated           0xaf0d8c007926747ede4270a56f69d2e872c3f0d7e1ef7bbc643b3185c50f6758
NFTKept                0xe71c2721f75bef3206b21176a6d26685852a16878249fc84d18f443f959bb8f5
DepositorBidAccepted   0x88ebc94b0ff4693b3d25995dc7c5c4e5683a8ca7de00836773ca24c8b69d78e3
ListingWithdrawn       0x155ad598d62a05a119f984c463f10d75b4fe9b0af1e0fbe0c2b2caaf8e4bdfda
ConfigSet              0x150110afd46e9924086bf85c855aae25722518b293155bf0ae689dd99a2e88cc
CollectionWhitelistSet 0x4c4950b9ef6cb1bc030a44fd8dc97dd16083b2731fb3516ed4f0b9cdffcc9527
```

**Gotchas:**

- Several knobs have **no public getter** (min backing, the kill switches,
  max pulls/tx, surcharge) — their state only exists as the latest
  `ConfigSet(key, value)` event. The snapshot already merges these; to verify
  independently, scan `ConfigSet` from the deploy block. Config keys of note:
  12 max pulls/tx, 13 surcharge, 15 crown tithe, 16 crown threshold,
  17 sell-back payout, 22 min backing, 41 pulls enabled, 42 withdraw-only,
  43 whitelist on/off, 44 sell-back-as-tokens, 62 whitelist manager.
- The whitelist has **no on-chain enumerator** — only per-address
  `collectionWhitelisted(address)` and the event history. Use the snapshot's
  list.
- Home nodes commonly cap `eth_getLogs` ranges at ~100k blocks — chunk scans.
- All ETH values in contract storage are wei; the snapshot pre-converts to
  decimal ETH strings.

## Site map

- App: https://fwaah.com (this skill: `/skill.md`, live data:
  `/livedatasnapshot.json`, discovery: `/llms.txt`)
- Official protocol docs: https://www.fwa.fun/docs (their vocabulary: the
  Crown, crown tithe)
- Dashboard source: https://github.com/clawdbotatg/fwaah — self-host it
  against your own node (`.env` → `NODE_RPC_URL`), and every path above works
  on your origin.
