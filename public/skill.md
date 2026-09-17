---
name: fwaah
description: Answer questions about the FWA main pools (Fake World Assets, Ethereum mainnet — V2 is current, V1 is the still-live legacy pool) — pull price, pool stats, rules, oracle ceiling, purchase pauses, whitelist, rewards epochs, the Crown — using fwaah.com's live JSON snapshot, and go deeper on-chain with the bundled addresses, ABIs, selectors, and event topics.
---

# FWAAH! agent skill — the FWA pools, machine-readable

You are helping a user understand **FWA (Fake World Assets)**, an NFT liquidity
game on Ethereum mainnet, via **fwaah.com** ("Fake World Assets at home"), an
open-source dashboard for it. This file is self-contained: which pool, then
mechanics, then the live data feed, then everything needed to read the chain.

## Two pools are live — pick the right one

| | **V2** (default) | **V1** (legacy) |
| --- | --- | --- |
| core contract | `0x958C41181182e76F221331b2755b77D9e1426A98` | `0xB276F62DB0ce8CA2Ca5bc522695bE604521eAc1c` |
| live since | 2026-09-16 16:00 UTC (deployed from block 25944480) | 2026-07-16 (block 25546793) |
| snapshot | `https://fwaah.com/livedatasnapshot.json` | `https://fwaah.com/livedatasnapshot.json?pool=v1` |
| dashboard | `https://fwaah.com/` (bare URL is always V2) | `https://fwaah.com/?pool=v1` |
| official site | fwa.fun | v1.fwa.fun |

V2 is a **separate deployment, not an upgrade**: V1 keeps running with its own
listings, fees and rewards module; both share the FWA token
(`0xa0Df17B5aC76ABaBA36E1450E2cbCd18A620C845`) and its Uniswap v4 hook.
"Migrating" means withdrawing from V1 and depositing into V2 (two transactions,
no protocol fee — fwa.fun/migrate). Unless the user says V1, answer about V2,
and say which pool you used. `pool.id` in every snapshot tells you which you got.

## Get live data (do this first)

```
curl -s https://fwaah.com/livedatasnapshot.json            # V2
curl -s 'https://fwaah.com/livedatasnapshot.json?pool=v1'  # V1
```

One pre-decoded JSON document with the whole pool state. It is edge-cached
(~60s fresh, served stale up to 10 min while revalidating) — poll it freely,
it costs the site at most one RPC refresh per minute per pool no matter how
many agents ask. Prefer it over raw chain reads for anything it already answers.

Running a fork at home? The same path exists on your own origin (the dev
server builds it against your `NODE_RPC_URL`), e.g. `http://localhost:3000/livedatasnapshot.json`.

### Snapshot field guide

| section | what's in it |
| --- | --- |
| `block`, `generatedAt` | mainnet block + wall time the snapshot was built at |
| `pool` | `id` (`v2`/`v1`), label, a note on how the pools relate, official site/docs, `otherPoolSnapshot` URL |
| `contracts` | core / token / rewards / VRF addresses (+ V2: floor oracle, fee buyback, purchase notifier, FWAIR launch manager, punk lister), owner, payout, whitelist manager, deploy block, Sourcify source+ABI URLs |
| `poolStats` | active listing count, pool ETH balance, **current pull price** (`pullPriceEth` = pool fee + VRF fee), pending/unsettled pulls, escrow, accrued owner fees |
| `crown` | the top-backed listing: which NFT, its backing, its pot; V2 adds `heldSince`, `commitmentEndsAt`, `commitmentServed` (the 12h / 1% early-exit rule) |
| `activity24h` | last-24h totals: pull count, total pull fees in ETH, deposits, withdrawals (V2: `oracleKicks`, `crownEarlyExitFees`), and a `pullOutcomes` tally (kept / sold back for ETH / for FWA / relisted / defaulted / refunded) |
| `recentPulls` | last 15 pulls, newest first: which NFT (collection name + tokenId), backing, winner, **outcome** — "kept the NFT", "sold back for X ETH", "pending — winner choosing", … — plus tx hash and approx time |
| `topPulls24h` | the 5 highest-backing NFTs pulled in the last 24h, same shape |
| `recentDeposits` | last 10 NFTs listed into the pool: collection, tokenId, backing, depositor |
| `recentKicks` (V2) | listings removed during a purchase pause for sitting above their oracle ceiling: who kicked, backing vs cap |
| `recentRuleChanges` | latest owner knob turns, whitelist edits and (V2) oracle exemptions, human-labeled, with tx hashes — check here before assuming a rule is stable |
| `rules` | every owner-tunable knob, live: surcharge, ETH sell-back payout (+ V2 `sellBackAsFwaBudgetBps`), owner cuts, crown tithe/threshold, windows, min backing, max pulls/tx, kill switches (`pullsEnabled`, `withdrawOnlyMode`); V2 adds `oracleCeiling` {premium, max quote age, min challenge period} and `crownCommitment` |
| `purchaseBlackout` (V2) | `active`, `secondsToChange`, `changesAt` — the daily 11:45–12:00 / 23:45–00:00 UTC pauses on NEW purchases |
| `rewards` (V2) | epoch number/start/end, this epoch's puller pot + pull count + FWA per pull, previous epoch, Σ√backing depositor weight, FWA held by the module, ETH queued for FWA buys, builder share, the protocol-fee buyback's params (`protocolFeeBuyback`) |
| `emission` (V1) | the fixed 15-day emission: start/end ISO timestamps, `secondsRemaining`, `ended` (it ended 2026-08-04), FWA/day rates, supply, buyback pool ETH. `null` on V2 |
| `fwaBurn` | **FWA burn rate** (token-level, same on both pools): `burned24hFwa`, `burns24h`, `burned7dFwa`, `avgPerDay7dFwa`, `totalSupplyFwa`, `burnedToDateFwa` vs the 1B `initialSupplyFwa`, `burnedToDatePctOfInitial`, `pace24hPctOfSupply`, `burned7dBySource` (token buyback route vs V2 protocol-fee buyback) |
| `punks` | `inPool` = CryptoPunks the pool custodies now; V2 adds `lister` — the Punk lister strategy: `punksBoughtOnMarket` (+ ETH), `punksDepositedByOwner` (+ backing), `recentPunks`, positions opened/listed/exited, `capital` (spendable / locked / per-buy capacity / who funded it), `backingDecay`, `marketBuysEnabled`, `paused` |
| `whitelist` | `enabled` flag + the full list of collections allowed to deposit, `{address, name}`; V2 adds `oracleExempt` per collection and as a list |

## How the game works (mechanics — both pools unless marked V2)

- **Deposit:** anyone lists a whitelisted NFT with ETH backing (≥
  `rules.minDepositBackingEth`). The NFT sits in the pool; the backing is the
  depositor's standing bid.
  **V2:** backing is also **capped**: unless the collection is oracle-exempt,
  the pool needs a fresh quote from the **CollectionFloorOracle** and
  `backing ≤ ask × (1 + rules.oracleCeiling.premiumBps/10000)` (10% → a 1 ETH
  ask allows 1.1 ETH). No valid quote = no deposits for that collection.
  Quotes come from a permissionless challenge: someone escrows an NFT at an
  ask + ETH for a bid at 90% of it; if nobody takes either side for the
  challenge period (6h), the quote is recorded. The oracle owner can also set
  quotes by hand.
- **Pull:** anyone pays the pull fee (`poolStats.pullPriceEth`) for a *random*
  NFT. Selection weight is **inverse to backing** (`weight = 1e36 / backing`)
  — cheap listings get pulled more often. The fee is the harmonic-mean expected
  value of the pool × (1 + `rules.pullSurchargeBps`/10000), plus a VRF service
  fee. Randomness is Chainlink VRF v2.5; requests resolve strictly in order
  over a few blocks (`pendingPulls` → allocated). **V2:** `acquire` names a
  **purchaser** separate from the payer, so contracts can buy for users; new
  purchases are refused during the two daily **blackout windows** (see
  `purchaseBlackout`) — everything else keeps working.
- **Winner's choice:** after an NFT is allocated, the winner has
  `rules.winnerSettlementWindowSeconds` (currently 1h on both pools) to
  **keep the NFT** (depositor gets backing minus the owner's cut), **keep and
  relist** it with new backing, **take the bid in ETH**
  (`rules.sellBackPayoutBps` of backing — 90%), or **take it as FWA** (V2:
  spends `rules.sellBackAsFwaBudgetBps` — 92.5% — of the backing buying FWA;
  V1 uses the ETH rate). Rates are read at settlement, not locked at
  allocation. After the window the depositor may resolve it; after
  `rules.finalizeWindowSeconds` anyone can finalize the default (NFT to
  winner, backing to depositor).
- **Fees:** each pull's fee, after the owner's cut and the crown tithe, is
  split **equally across active listings** (not by weight) — depositors earn
  ETH while they wait (`claimListingFees` → `withdrawEarnings`). Part of the
  surcharge is reserved as an FWA-buy allowance for the puller.
- **The Crown:** the top-backed listing earns `rules.crownTitheBps` of every
  pull into its pot (`crown.potEth`), paid out when it leaves or is overtaken.
  Taking the crown requires backing ≥ holder's × (1 + `crownTakeoverThresholdBps`).
  **V2:** withdrawing or *lowering* the crown within **12h** of taking it costs
  **1% of its full backing** (`crown.commitmentServed` says whether that has
  passed). Being pulled, out-bid, or oracle-kicked is free.
- **V2 oracle kicks:** during a blackout window, when no pull is unresolved,
  anyone can `kickListing` a non-exempt listing whose backing is above its
  current oracle ceiling. The depositor gets NFT + full backing back, no fee.
  `recentKicks` lists them.
- **Whitelist:** when `whitelist.enabled` is true, only listed collections can
  be deposited. Pulling is never gated. V2's whitelist is curated through a
  separate authority contract; a FWAIR launch manager can admit exactly its
  own launch collection.
- **Rewards (V2):** no fixed emission. The FWA token's buyback route (and the
  pool's own protocol-fee buyback, `rewards.protocolFeeBuyback`) swap ETH for
  FWA and send it to the rewards module, which splits it: depositors by
  **√backing** (a 4 ETH listing weighs 2× a 1 ETH one) and pullers by
  **24h epochs** (one share per successful pull; claim once the epoch closes
  and every pull in it resolved). Apps that route pulls through their own
  contract earn `rewards.builderRewardBps` of protocol fees as an FWA-buy
  allowance — no cost to puller or depositor.
- **Emission (V1):** a fixed 15-day window (ended 2026-08-04) streamed FWA to
  depositors (√backing) and a daily puller pot. Its core ETH game continues.
- **Burn:** every FWA buyback burns a slice (20% on the token's own route and
  on V2's protocol-fee buyback), as ERC-20 transfers to 0x0. 1,000,000,000 FWA
  were minted at deploy and nothing mints again, so supply only falls —
  `fwaBurn` has the 24h/7d pace and the running total.
- **Punk lister (V2):** a protocol strategy contract (`FWAPunkListerV2`)
  funded by 20% of FWA trading fees, its own listing earnings and owner
  top-ups. It buys CryptoPunks on the punk market (`purchaseAndList`, only
  while `marketBuysEnabled`) or lists owner-deposited ones, and walks their
  backing down on a schedule (`backingDecay`) so they eventually get pulled.
  `punks.lister` is its scorecard; `punks.inPool` counts every punk the pool
  holds, whoever listed it.

### Answering common questions

- **"Which pool?"** — default to V2; `pool.id` confirms. If the user holds V1
  listings, fetch `?pool=v1` too and say so.
- **"Is collection X allowed / can I deposit it?"** — match X against
  `whitelist.collections[].name` (and address). In the list → whitelisted.
  **V2:** also check `oracleExempt`; if not exempt, a deposit still needs a
  fresh floor quote and a backing under the ceiling — the dashboard's deposit
  panel shows the live cap, or read `getFloorRange(collection)` on
  `contracts.floorOracle`. If `whitelist.enabled` is false, everything is allowed.
- **"Can I buy right now?"** — V2: `purchaseBlackout.active`; if true, say
  when it reopens (`changesAt`). Also `rules.pullsEnabled` / `withdrawOnlyMode`.
- **"What does a pull cost / what's in the pool?"** — `poolStats`.
- **"Who holds the Crown / can I leave it for free?"** — `crown` (V2:
  `commitmentServed`, `commitmentEndsAt`).
- **"What FWA do pullers earn?"** — V2: `rewards.currentEpochFwaPerPull` (so
  far this epoch) and `previousEpoch.fwaPerPull`. V1: emission ended.
- **"What's the FWA burn rate?"** — `fwaBurn.burned24hFwa` and
  `avgPerDay7dFwa`; `pace24hPctOfSupply` for the rate as a share of supply;
  `burnedToDateFwa` for the running total. Cite `burned7dBySource` when asked
  where burns come from.
- **"How many punks has the protocol bought / are in the pool?"** —
  `punks.inPool` for the pool; `punks.lister.punksBoughtOnMarket` (+
  `punksDepositedByOwner`) for the lister, with `recentPunks` for the list
  and `capital` for what it can still spend. Say whether `marketBuysEnabled`
  is on — if not, every lister punk so far was owner-deposited.
- **"What's been pulled lately / any big pulls?"** — `recentPulls`, `topPulls24h`.
- **"How active is the pool / do winners keep or sell?"** — `activity24h`.
- **"Did the rules change recently?"** — `recentRuleChanges` (tx hashes to cite).
- **"Should I migrate from V1?"** — describe, don't decide: V2 adds the oracle
  ceiling (caps how much backing a listing may carry), purchase pauses, the
  crown commitment, separate ETH/FWA cashout rates, and live rewards; V1 has
  no ceiling and its emission is over. Compare each pool's `poolStats`
  (listing count, pull price, fee volume) from both snapshots.

## Going deeper: direct chain access

Everything below lets you verify or extend the snapshot on-chain. Use your
own RPC endpoint for heavy work (log scans, per-listing walks).

**Contracts (Ethereum mainnet, chainId 1):**

- V2 core `FWAV2`: `0x958C41181182e76F221331b2755b77D9e1426A98` (start block 25944480)
  - `FWAV2Rewards` `0xA54b44C7a894AA19C49734A753D01f9B8C5f6516` · `FWAV2Buyback` `0xaba91665cdf921F0f6B33A099337336B324c9793`
  - `CollectionFloorOracle` `0xaA4D9009a4664604b57644bF13e447E9036727DC` · `FWAVRFService` `0xCACBd874e24B533935176154E990Bf710F56693A`
  - `FWAWhitelistAuthorityV2` `0x0ad3128429242007D58952c65546BA99b9b70146` · `FWAPurchaseNotifier` `0x612dF3a344990F8E53499ec1bC79Be63cFa496D0`
  - `FWAIRLaunchManagerV2` `0x716486a7bD6B4d7409fC4F8B52f0B23D2BcFac72` · `FWAPunkListerV2` `0xb924048A35160B077A85954A049d5CAc29F23ad1`
- V1 core `FWA`: `0xB276F62DB0ce8CA2Ca5bc522695bE604521eAc1c` (deployed at block 25546793)
  - `FWARewards` `0x6a1a1C0CfB3D3C538e13D36d608a5bcaa992fc78` · `FWAVRFService` `0xa084c33Fb7a467307452898b8D58165ebd2E5D9f`
- Shared: `FWAToken` `0xa0Df17B5aC76ABaBA36E1450E2cbCd18A620C845`, hook `0x2C67ebA8A50AF0dB5Fba55F725247a75CbDA6444`
- **Full verified source + ABI** (Sourcify; Etherscan v1 API is dead):
  `https://sourcify.dev/server/v2/contract/1/<address>?fields=sources,abi`
  (V2 buyback / VRF service / whitelist authority / notifier are verified on
  Blockscout instead: `https://eth.blockscout.com/api/v2/smart-contracts/<address>`)
- Humans can poke it at `https://abi.ninja/<address>/1`

**Useful view selectors on the core** (identical on V1 and V2 unless tagged;
call with `eth_call`, 32-byte-word args):

```
activeListingCount() 0x4681a7c6      acquisitionFee() 0x38f5f005
quoteAcquisitionPrice() 0x987df4cd   -> (fee, vrf, total)
totalWeight() 0x96c82e57             weightedBackingTotal() 0xd6eb0dbd
topListingId() 0xee35bc33            topListingPot() 0xba20687b
topListingSince() 0x9360191e (V2)    isPurchaseBlackout() 0x4d5fe14c (V2)
listings(uint256) 0xde74e57b         -> (collection, depositor, purchaser, tokenId, weight, value, feeShare, feeDebt, slot, allocatedAt, status)
collectionWhitelisted(address) 0x666cd313
canDeposit(address) 0x4bf0d331 (V2)  oracleExemptCollections(address) 0xcd9ba024 (V2)
floorOracle() 0x29dd24c7 (V2)        oracleCeilingPremiumBps() 0xedfd4c45 (V2)
settlementDiscountBps() 0xfb2dd096   tokenSettlementDiscountBps() 0x97d69193 (V2)
feeCredit(address) 0x5c584c88        pendingFees(uint256) 0xa2b93478
acquisitions(uint256) 0x41111a4a     acquisitionRefundCredit(address) 0x39ea5e12
```

On the floor oracle (V2): `getFloorRange(address) 0xd72e40e3 -> (bid, ask, observedAt, periodUsed)`.
On `FWAV2Rewards`: `currentEpoch() 0x76671808`, `purchaserEpochPot(uint256) 0x641a875d`,
`acquisitionsInEpoch(uint256) 0x68a9b6ff`, `pendingDepositorTokens(uint256) 0x6e077f61`,
`tokenCredit(address) 0xad1ee407`, `builderRewardBps() 0x6c1f08a9`.
On V1's `FWARewards`: `emissionStart() 0x513da948`, `EMISSION_DURATION() 0x2d9c4dd2`.

**Writes** (the user's wallet signs; never send from an agent without asking):

```
V2 acquire(address purchaser, uint256 count, uint256 maxAcquisitionFee, uint256 minWeightedValue, uint256 maxNegativeSlippageBps) 0xf6cb8511  payable: count × quoteAcquisitionPrice().total
V1 acquire(uint256 maxAcquisitionFee, uint256 minWeightedValue) 0x548b0de9
listNFT(address,uint256) 0x3c61c7aa payable (backing = msg.value)   updateBacking(uint256,uint256) 0xc622bfcf
withdrawListing(uint256) 0xaec6e273   claimListingFees(uint256[]) 0xb840cf36   withdrawEarnings() 0xb73c6ce9
keepNFT(uint256) 0x49cfb710   acceptDepositorBid(uint256) 0x35390e96   acceptBidAsTokens(uint256,uint256) 0x20bd63ba
kickListing(uint256) 0x61e02d6e (V2, blackout only)   claimTopSpot(uint256) 0x0986a5a1
```

**Key event topics (topic0) on the core — same hashes on both pools:**

```
NFTListed              0x01c953cf171a8c32b553c5b7e0964bae6b2123db065615e54e8425fec3ec16cd
AcquisitionRequested   0xf23e34f4aa4a06ecddd309d9692e7b7ca45b76fd0d5f4ce4f7fbf29731d9abd6
NFTAllocated           0xaf0d8c007926747ede4270a56f69d2e872c3f0d7e1ef7bbc643b3185c50f6758
NFTKept                0xe71c2721f75bef3206b21176a6d26685852a16878249fc84d18f443f959bb8f5
DepositorBidAccepted   0x88ebc94b0ff4693b3d25995dc7c5c4e5683a8ca7de00836773ca24c8b69d78e3
ListingWithdrawn       0x155ad598d62a05a119f984c463f10d75b4fe9b0af1e0fbe0c2b2caaf8e4bdfda
ConfigSet              0x150110afd46e9924086bf85c855aae25722518b293155bf0ae689dd99a2e88cc
CollectionWhitelistSet 0x4c4950b9ef6cb1bc030a44fd8dc97dd16083b2731fb3516ed4f0b9cdffcc9527
ListingKicked (V2)     0x25d3112a6d76bf15c75a68a5afe2ea559e7ef701e0328cfa7697f0c6fd6e96c5
EarlyCrownExitFee (V2) 0x54481df24baf8652d2c08c9a9de5626c914c23180818e523d3c2a72ac46686d2
OracleExemptionSet (V2) 0xb2d0f6071086c8df6da3b5d215d8a0e198bd0fbaef5a4bd99df860f827fd5933
```

**Gotchas:**

- Several knobs have **no public getter** (min backing, the kill switches,
  max pulls/tx, surcharge) — their state only exists as the latest
  `ConfigSet(key, value)` event. The snapshot already merges these; to verify
  independently, scan `ConfigSet` from the deploy block. Config keys (same
  numbering on both pools): 12 max pulls/tx, 13 surcharge, 15 crown tithe,
  16 crown threshold, 17 ETH sell-back payout, 20 settlement window,
  21 finalize window, 22 min backing, 23 protocol fees → buyback,
  26 max oracle age (V2), 27 min challenge period (V2), 28 oracle premium (V2),
  29 FWA sell-back budget (V2), 41 pulls enabled, 42 withdraw-only,
  43 whitelist on/off, 44 sell-back-as-FWA, 62 whitelist manager,
  64 floor oracle (V2), 65 FWAIR registry (V2).
- The whitelist has **no on-chain enumerator** — only per-address
  `collectionWhitelisted(address)` and the event history. Use the snapshot's list.
- V2's `payoutFees()` is called by a bot nearly every block — ignore the
  stream of 0-ETH `FeesPaidOut` events when reading V2 logs.
- Home nodes commonly cap `eth_getLogs` ranges at ~100k blocks — chunk scans.
- All ETH values in contract storage are wei; the snapshot pre-converts to
  decimal ETH strings.

## Site map

- App: https://fwaah.com (V2) · https://fwaah.com/?pool=v1 (V1); this skill:
  `/skill.md`, live data: `/livedatasnapshot.json[?pool=v1]`, discovery: `/llms.txt`
- Official protocol docs: https://www.fwa.fun/docs (V2 explained:
  https://www.fwa.fun/v2 · deployments: /docs/v2-deployments · V1: /docs/v1)
- Dashboard source: https://github.com/clawdbotatg/fwaah — self-host it
  against your own node (`.env` → `NODE_RPC_URL`), and every path above works
  on your origin.
