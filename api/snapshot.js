// GET /livedatasnapshot.json (rewritten here, see vercel.json) — one JSON
// document with an FWA main pool's live state, built for LLM agents. The agent
// skill at /skill.md tells an agent to curl this instead of speaking raw
// JSON-RPC; everything is pre-decoded and labeled.
//
// Two pools are live: V2 (default) and the legacy V1 — `?pool=v1` switches.
// They are separate deployments sharing only the FWA token.
//
// Edge-cached (s-maxage=60, SWR 600) so any number of agents polling it cost
// at most one upstream refresh a minute per pool. No hotlink guard: unlike
// /api/rpc and /api/meta this endpoint exists to be fetched from anywhere, and
// the cache bounds the damage.
//
// Upstream: RPC_UPSTREAM (Vercel env) in prod; NODE_RPC_URL (.env) via the
// setupProxy dev twin, so forks at home serve their own snapshot too.

const {
  POOLS, poolFromReq, SELECTORS, TOPICS, CONFIG_LABELS, applyConfigSet,
  FWA_TOKEN, PUNKS_721, INITIAL_FWA_SUPPLY, TRANSFER_TOPIC, ZERO_TOPIC, LISTER_SELECTORS, LISTER_TOPICS,
  toBig, toNum, word, wordAddr, decodeString, fmtEth,
} = require('./_fwa');

const DAY_BLOCKS = 7200; // ~24h at 12s blocks
const ZERO = /^0x0{40}$/;

// V2 purchase blackout: block.timestamp % 12h >= 11h45m (fixed in the contract)
const BLACKOUT_PERIOD_S = 12 * 3600;
const BLACKOUT_START_S = 11 * 3600 + 45 * 60;
const CROWN_COMMITMENT_S = 12 * 3600;

function rpcBody(calls) {
  return calls.map((c, i) => ({ jsonrpc: '2.0', id: i + 1, method: c[0], params: c[1] }));
}

async function rpc(upstream, calls, safe = false) {
  const res = await fetch(upstream, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rpcBody(calls)),
  });
  if (!res.ok) throw new Error('upstream rpc HTTP ' + res.status);
  const json = await res.json();
  const byId = {};
  (Array.isArray(json) ? json : [json]).forEach((r) => { byId[r.id] = r; });
  return calls.map((c, i) => {
    const r = byId[i + 1];
    if (!r || r.error) {
      if (safe) return null;
      throw new Error((r && r.error && r.error.message) || 'rpc error on ' + c[0]);
    }
    return r.result;
  });
}

function call(to, selector, argWords = []) {
  const data = selector + argWords.map((w) => BigInt(w).toString(16).padStart(64, '0')).join('');
  return ['eth_call', [{ to, data }, 'latest']];
}

const sourcify = (addr) => `https://sourcify.dev/server/v2/contract/1/${addr}?fields=sources,abi`;
const iso = (s) => new Date(s * 1000).toISOString();

module.exports = async (req, res) => {
  const upstream = process.env.RPC_UPSTREAM || process.env.NODE_RPC_URL;
  if (!upstream) {
    res.status(500).json({ error: 'no RPC upstream configured (RPC_UPSTREAM / NODE_RPC_URL)' });
    return;
  }
  const pool = poolFromReq(req);
  const isV2 = pool.id === 'v2';
  const FWA_ADDRESS = pool.address;
  const other = isV2 ? POOLS.v1 : POOLS.v2;

  try {
    // ---- batch 1: block, pool balance, every core view with a getter ----
    const numKeys = [
      'activeListingCount', 'acquisitionFee', 'totalWeight', 'weightedBackingTotal',
      'pendingAcquisitionCount', 'unsettledAcquisitionCount', 'topListingId', 'topListingPot',
      'nextListingId', 'accruedOwnerFees', 'acquisitionEscrowTotal', 'acquisitionRefundCreditTotal',
      'finalizeWindow', 'ownerAcquisitionFeeBps', 'ownerSettlementFeeBps', 'topListingShareBps',
      'topThresholdBps', 'retainedToProtocol', 'selectionSlippageBps', 'selectionTimeoutBlocks',
      'settlementDiscountBps', 'settlementWindow',
      ...(isV2 ? ['topListingSince', 'tokenSettlementDiscountBps', 'oracleCeilingPremiumBps', 'maxOracleAge', 'minOracleChallengePeriod', 'isPurchaseBlackout', 'vrfServiceFee'] : []),
    ];
    const addrKeys = ['owner', 'payoutAddress', 'token', 'rewards', ...(isV2 ? ['floorOracle', 'fwairLaunchRegistry'] : ['vrfService'])];
    const r1 = await rpc(upstream, [
      ['eth_blockNumber', []],
      ['eth_getBalance', [FWA_ADDRESS, 'latest']],
      ...numKeys.map((k) => call(FWA_ADDRESS, SELECTORS[k])),
      ...addrKeys.map((k) => call(FWA_ADDRESS, SELECTORS[k])),
    ]);
    const latest = toNum(r1[0]);
    const balance = toBig(r1[1]);
    const v = {};
    numKeys.forEach((k, i) => { v[k] = toBig(r1[2 + i]); });
    addrKeys.forEach((k, i) => { v[k] = wordAddr(r1[2 + numKeys.length + i], 0); });

    // ---- batch 2: crown listing, rewards module, admin-event overlay, 24h feed ----
    const calls2 = [];
    const hasTop = v.topListingId !== 0n;
    if (hasTop) calls2.push(call(FWA_ADDRESS, SELECTORS.listings, [v.topListingId]));
    const hasRewards = v.rewards && !ZERO.test(v.rewards);
    if (hasRewards && isV2) {
      calls2.push(
        call(v.rewards, SELECTORS.epochStart),
        call(v.rewards, SELECTORS.currentEpoch),
        call(v.token, SELECTORS.totalSupply),
        call(v.rewards, SELECTORS.tokenBuyAllowanceTotal),
        call(v.rewards, SELECTORS.sqrtBackingTotal),
        call(v.rewards, SELECTORS.builderRewardBps),
        call(v.rewards, SELECTORS.buyback),
        call(v.token, SELECTORS.balanceOf, [v.rewards]),
      );
    } else if (hasRewards) {
      calls2.push(
        call(v.rewards, SELECTORS.emissionStart),
        call(v.rewards, SELECTORS.emissionDuration),
        call(v.rewards, SELECTORS.depositorRatePerSec),
        call(v.rewards, SELECTORS.purchaserDailyPot),
        call(v.token, SELECTORS.totalSupply),
        call(v.rewards, SELECTORS.isBuying),
        call(v.rewards, SELECTORS.tokenBuyAllowanceTotal),
      );
    }
    const rewardsCallCount = hasRewards ? (isV2 ? 8 : 7) : 0;
    // admin events since the baked snapshot block, chunked under the 100k-block
    // getLogs cap a home node enforces (rare events — each chunk is tiny)
    const CHUNK = 90000;
    const ranges = [];
    for (let from = pool.snapshotBlock + 1; from <= latest; from += CHUNK) {
      ranges.push([from, Math.min(from + CHUNK - 1, latest)]);
    }
    const adminTopics = [TOPICS.ConfigSet, TOPICS.CollectionWhitelistSet, ...(isV2 ? [TOPICS.OracleExemptionSet] : [])];
    calls2.push(...ranges.map(([from, to]) => ['eth_getLogs', [{
      address: FWA_ADDRESS,
      fromBlock: '0x' + from.toString(16),
      toBlock: '0x' + to.toString(16),
      topics: [adminTopics],
    }]]));

    // 24h activity feed, chunked so a home node's ~20k-results getLogs cap holds
    const FEED_TOPICS = [
      TOPICS.AcquisitionRequested, TOPICS.NFTAllocated, TOPICS.NFTKept, TOPICS.NFTRelisted,
      TOPICS.DepositorBidAccepted, TOPICS.DepositorBidAcceptedAsTokens,
      TOPICS.AcquisitionExpired, TOPICS.AcquisitionRefundedNoListing, TOPICS.AcquisitionRefundedSlippage,
      TOPICS.NFTListed, TOPICS.ListingWithdrawn, TOPICS.UnsettledFinalized,
      ...(isV2 ? [TOPICS.ListingKicked, TOPICS.EarlyCrownExitFee] : []),
    ];
    const feedStart = Math.max(latest - DAY_BLOCKS, 0);
    const feedRanges = [];
    for (let from = feedStart; from <= latest; from += 1800) {
      feedRanges.push([from, Math.min(from + 1799, latest)]);
    }
    const feedRangeStart = calls2.length;
    calls2.push(...feedRanges.map(([from, to]) => ['eth_getLogs', [{
      address: FWA_ADDRESS,
      fromBlock: '0x' + from.toString(16),
      toBlock: '0x' + to.toString(16),
      topics: [[...FEED_TOPICS]],
    }]]));

    const r2 = await rpc(upstream, calls2);
    let i2 = 0;
    let top = null;
    if (hasTop) {
      const raw = r2[i2++];
      top = {
        collection: wordAddr(raw, 0),
        depositor: wordAddr(raw, 1),
        tokenId: word(raw, 3).toString(),
        backingWei: word(raw, 5),
      };
    }
    let emission = null; // V1
    let rw = null; // V2
    if (hasRewards && isV2) {
      const [startH, epochH, supplyH, allowH, sqrtH, builderH, buybackH, balH] = r2.slice(i2, i2 + 8);
      rw = {
        start: toNum(startH), epoch: toBig(epochH), supply: toBig(supplyH), allowance: toBig(allowH),
        sqrtBackingTotal: toBig(sqrtH), builderRewardBps: toBig(builderH), buyback: wordAddr(buybackH, 0), moduleBalance: toBig(balH),
      };
    } else if (hasRewards) {
      const [startH, durH, rateH, potH, supplyH, buyingH, buyPoolH] = r2.slice(i2, i2 + 7);
      emission = {
        start: toNum(startH), duration: toNum(durH),
        ratePerSec: toBig(rateH), dailyPot: toBig(potH), supply: toBig(supplyH),
        buysOpen: toBig(buyingH) === 1n, buybackPool: toBig(buyPoolH),
      };
    }
    i2 += rewardsCallCount;
    const adminLogs = [].concat(...r2.slice(i2, feedRangeStart));
    const feedLogs = [].concat(...r2.slice(feedRangeStart));

    // overlay the baked knob/whitelist/exemption snapshot with anything that changed since
    const knobs = { ...pool.knobs };
    const wl = new Map(pool.whitelist);
    const exempt = new Set(pool.oracleExempt);
    adminLogs.forEach((log) => {
      if (log.topics[0] === TOPICS.ConfigSet) {
        applyConfigSet(knobs, Number(BigInt(log.topics[1])), word(log.data, 0));
      } else if (log.topics[0] === TOPICS.CollectionWhitelistSet) {
        const addr = wordAddr(log.topics[1], 0);
        if (word(log.data, 0) === 0n) wl.delete(addr);
        else if (!wl.has(addr)) wl.set(addr, null); // name resolved below
      } else if (log.topics[0] === TOPICS.OracleExemptionSet) {
        const addr = wordAddr(log.topics[1], 0);
        if (word(log.data, 0) === 0n) exempt.delete(addr);
        else exempt.add(addr);
      }
    });

    // ---- batch 3: name() for the crown collection + any new whitelist entries,
    //      plus the V2 epoch pot / buyback params (need currentEpoch from batch 2) ----
    const unnamed = [...wl.entries()].filter(([, name]) => !name).map(([addr]) => addr);
    const nameTargets = [...unnamed];
    if (top && !nameTargets.includes(top.collection)) nameTargets.push(top.collection);
    const calls3 = nameTargets.map((a) => call(a, SELECTORS.name));
    const hasBuyback = rw && !ZERO.test(rw.buyback);
    if (rw) {
      calls3.push(
        call(v.rewards, SELECTORS.purchaserEpochPot, [rw.epoch]),
        call(v.rewards, SELECTORS.acquisitionsInEpoch, [rw.epoch]),
        call(v.rewards, SELECTORS.pendingAcquisitionsInEpoch, [rw.epoch]),
      );
      if (rw.epoch > 0n) {
        calls3.push(
          call(v.rewards, SELECTORS.purchaserEpochPot, [rw.epoch - 1n]),
          call(v.rewards, SELECTORS.acquisitionsInEpoch, [rw.epoch - 1n]),
        );
      }
      if (hasBuyback) {
        calls3.push(
          call(rw.buyback, SELECTORS.maxEthPerBuy), call(rw.buyback, SELECTORS.callerRewardBps),
          call(rw.buyback, SELECTORS.routeDepositorBps), call(rw.buyback, SELECTORS.routePurchaserBps),
          call(rw.buyback, SELECTORS.routeBurnBps), call(rw.buyback, SELECTORS.paused),
          call(rw.buyback, SELECTORS.lastBuybackBlock), ['eth_getBalance', [rw.buyback, 'latest']],
        );
      }
    }
    const r3 = calls3.length ? await rpc(upstream, calls3, true) : [];
    nameTargets.forEach((a, i) => {
      const name = r3[i] ? decodeString(r3[i]) : null;
      if (wl.has(a) && !wl.get(a)) wl.set(a, name || a);
      if (top && top.collection === a) top.collectionName = wl.get(a) || name || a;
    });
    if (top && !top.collectionName) top.collectionName = wl.get(top.collection) || top.collection;
    let epochNow = null;
    let epochPrev = null;
    let buyback = null;
    if (rw) {
      let j = nameTargets.length;
      epochNow = { pot: toBig(r3[j++]), pulls: toBig(r3[j++]), pending: toBig(r3[j++]) };
      if (rw.epoch > 0n) epochPrev = { pot: toBig(r3[j++]), pulls: toBig(r3[j++]) };
      if (hasBuyback) {
        buyback = {
          address: rw.buyback,
          maxEthPerBuy: toBig(r3[j++]), callerRewardBps: toBig(r3[j++]),
          depositorBps: toBig(r3[j++]), purchaserBps: toBig(r3[j++]), burnBps: toBig(r3[j++]),
          paused: toBig(r3[j++]) === 1n, lastBuybackBlock: toNum(r3[j++]), balance: toBig(r3[j++]),
        };
      }
    }

    const nowS = Math.floor(Date.now() / 1000);
    const emEnd = emission && emission.start ? emission.start + emission.duration : null;
    const T = TOPICS;
    const topicNum = (t) => Number(BigInt(t));
    const topicAddr = (t) => '0x' + t.slice(26);
    const blockMeta = (log) => {
      const bn = toNum(log.blockNumber);
      const ageSeconds = (latest - bn) * 12;
      return { block: bn, ageSeconds, approxTime: new Date((nowS - ageSeconds) * 1000).toISOString(), txHash: log.transactionHash };
    };

    // ---- 24h activity: totals, outcome tally, per-pull + per-deposit detail ----
    const tally = { pulls: 0, pullFeesWei: 0n, deposits: 0, withdrawals: 0, kicked: 0, crownExitFees: 0 };
    const outcomes = { allocated: 0, kept: 0, soldBackForEth: 0, soldBackForFwa: 0, relisted: 0, refundedOrExpired: 0, defaulted: 0 };
    const pullsById = new Map(); // listingId -> pull record (last allocation wins)
    const depositEvents = [];
    const kickEvents = [];
    const collectionsSeen = new Map(); // listingId -> {collection, tokenId} from NFTListed
    feedLogs.forEach((log) => {
      const t0 = log.topics[0];
      if (t0 === T.AcquisitionRequested) {
        tally.pulls += 1;
        tally.pullFeesWei += word(log.data, 0);
      } else if (t0 === T.NFTAllocated) {
        outcomes.allocated += 1;
        const id = topicNum(log.topics[2]);
        pullsById.set(id, {
          ...blockMeta(log),
          listingId: id,
          winner: topicAddr(log.topics[3]),
          backingEth: fmtEth(word(log.data, 1)),
          backingWei: word(log.data, 1),
          outcome: 'pending — winner choosing',
        });
      } else if (t0 === T.NFTKept) {
        outcomes.kept += 1;
        const p = pullsById.get(topicNum(log.topics[1]));
        if (p) p.outcome = 'kept the NFT';
      } else if (t0 === T.DepositorBidAccepted) {
        outcomes.soldBackForEth += 1;
        const p = pullsById.get(topicNum(log.topics[1]));
        if (p) p.outcome = 'sold back for ' + fmtEth(word(log.data, 0)) + ' ETH';
      } else if (t0 === T.DepositorBidAcceptedAsTokens) {
        outcomes.soldBackForFwa += 1;
        const p = pullsById.get(topicNum(log.topics[1]));
        if (p) p.outcome = 'sold back for FWA tokens (' + fmtEth(word(log.data, 0)) + ' ETH worth)';
      } else if (t0 === T.NFTRelisted) {
        outcomes.relisted += 1;
        const p = pullsById.get(topicNum(log.topics[1]));
        if (p) p.outcome = 'relisted as #' + topicNum(log.topics[2]);
      } else if (t0 === T.UnsettledFinalized) {
        outcomes.defaulted += 1;
        const p = pullsById.get(topicNum(log.topics[1]));
        if (p) p.outcome = 'defaulted (never settled)';
      } else if (t0 === T.AcquisitionExpired || t0 === T.AcquisitionRefundedNoListing || t0 === T.AcquisitionRefundedSlippage) {
        outcomes.refundedOrExpired += 1;
      } else if (t0 === T.NFTListed) {
        tally.deposits += 1;
        const id = topicNum(log.topics[1]);
        const rec = {
          ...blockMeta(log),
          listingId: id,
          depositor: topicAddr(log.topics[3]),
          collection: wordAddr(log.data, 0),
          tokenId: word(log.data, 1).toString(),
          backingEth: fmtEth(word(log.data, 3)),
        };
        collectionsSeen.set(id, rec);
        depositEvents.push(rec);
      } else if (t0 === T.ListingWithdrawn) {
        tally.withdrawals += 1;
      } else if (t0 === T.ListingKicked) {
        tally.kicked += 1;
        kickEvents.push({
          ...blockMeta(log),
          listingId: topicNum(log.topics[1]),
          kickedBy: topicAddr(log.topics[2]),
          depositor: topicAddr(log.topics[3]),
          backingEth: fmtEth(word(log.data, 0)),
          oracleCapEth: fmtEth(word(log.data, 1)),
        });
      } else if (t0 === T.EarlyCrownExitFee) {
        tally.crownExitFees += 1;
      }
    });

    // collection/tokenId for pulled listings: 24h NFTListed events first,
    // then a best-effort listings() batch — but only for the ~20 pulls we
    // actually output (an active day has thousands of pulls on pre-window
    // listings; resolving them all would be a huge upstream batch)
    const allPullsChrono = [...pullsById.values()];
    const shown = new Set([
      ...allPullsChrono.slice(-15),
      ...[...allPullsChrono].sort((a, b) => (b.backingWei > a.backingWei ? 1 : -1)).slice(0, 5),
    ]);
    const needStruct = [...shown].filter((p) => !collectionsSeen.has(p.listingId));
    if (needStruct.length) {
      const rStruct = await rpc(upstream, needStruct.map((p) => call(FWA_ADDRESS, SELECTORS.listings, [BigInt(p.listingId)])));
      needStruct.forEach((p, i) => {
        const raw = rStruct[i];
        const coll = wordAddr(raw, 0);
        if (!ZERO.test(coll)) collectionsSeen.set(p.listingId, { collection: coll, tokenId: word(raw, 3).toString() });
      });
    }
    // ---- batch 4: fee sinks — FWA burns (Transfer → 0x0 on the token, all
    //      sources) over 24h/7d, punks in the pool, and (V2) the Punk lister ----
    const burnRange = (from, to) => ['eth_getLogs', [{ address: FWA_TOKEN, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics: [TRANSFER_TOPIC, null, ZERO_TOPIC] }]];
    const weekRanges = []; // exactly 7 day-sized chunks ending at `latest`; the last one is the newest 24h
    for (let from = Math.max(latest - 7 * DAY_BLOCKS + 1, 0); from <= latest; from += DAY_BLOCKS) weekRanges.push([from, Math.min(from + DAY_BLOCKS - 1, latest)]);
    const calls4 = [
      call(FWA_TOKEN, SELECTORS.totalSupply),
      call(PUNKS_721, SELECTORS.balanceOf, [FWA_ADDRESS]),
      ...weekRanges.map(([a, b]) => burnRange(a, b)),
    ];
    const listerStart = calls4.length;
    const LISTER = isV2 ? pool.contracts.punkLister : null;
    if (LISTER) {
      ['lockedCapital', 'spendableCapital', 'purchaseCapacity', 'publicMarketPurchasesEnabled', 'nextPositionId', 'paused', 'configuration']
        .forEach((k) => calls4.push(call(LISTER, LISTER_SELECTORS[k])));
      calls4.push(['eth_getBalance', [LISTER, 'latest']]);
      for (let from = pool.deployBlock; from <= latest; from += 90000) {
        calls4.push(['eth_getLogs', [{ address: LISTER, fromBlock: '0x' + from.toString(16), toBlock: '0x' + Math.min(from + 89999, latest).toString(16) }]]);
      }
    }
    const r4 = await rpc(upstream, calls4, true);
    const fwaSupply = toBig(r4[0]);
    const punksInPool = r4[1] ? Number(word(r4[1], 0)) : null;
    const weekLogs = [].concat(...weekRanges.map((_, i) => r4[2 + i] || []));
    const dayLogs = r4[listerStart - 1] || [];
    const sumData0 = (logs) => logs.reduce((acc, l) => acc + word(l.data, 0), 0n);
    const burnBySource = {};
    weekLogs.forEach((l) => { const a = topicAddr(l.topics[1]); burnBySource[a] = (burnBySource[a] || 0n) + word(l.data, 0); });
    const fwaWhole = (wei) => Math.round(Number(wei) / 1e18);
    const pct = (part, whole) => (whole > 0n ? Number(part * 1000000n / whole) / 10000 : null);
    let listerOut = null;
    if (LISTER) {
      let j = listerStart;
      const g = () => r4[j++];
      const [lockedH, spendH, capH, enabledH, nextH, pausedH, cfgH, balH] = [g(), g(), g(), g(), g(), g(), g(), g()];
      const logs = [].concat(...r4.slice(j).map((x) => x || []));
      const of = (t) => logs.filter((l) => l.topics[0] === t);
      const bought = of(LISTER_TOPICS.PunkPurchased);
      const deposited = of(LISTER_TOPICS.WrappedPunkDeposited);
      const inflow = {};
      of(LISTER_TOPICS.CapitalLocked).forEach((l) => { const a = topicAddr(l.topics[1]); inflow[a] = (inflow[a] || 0n) + word(l.data, 0); });
      listerOut = {
        note: 'FWAPunkListerV2: a protocol strategy funded by 20% of FWA trading fees (OwnerSplitterV2), its own listing earnings and owner top-ups. It buys punks on the CryptoPunks market (purchaseAndList, only while marketBuysEnabled) or lists owner-deposited ones, then decays their backing on a schedule so they eventually get pulled.',
        address: LISTER,
        marketBuysEnabled: toBig(enabledH) === 1n,
        paused: toBig(pausedH) === 1n,
        punksBoughtOnMarket: bought.length,
        punksBoughtOnMarketEth: fmtEth(sumData0(bought)),
        punksDepositedByOwner: deposited.length,
        punksDepositedByOwnerBackingEth: fmtEth(deposited.reduce((acc, l) => acc + word(l.data, 1), 0n)),
        recentPunks: [...bought, ...deposited].slice(-10).reverse().map((l) => ({
          ...blockMeta(l), punkId: Number(BigInt(l.topics[2])),
          how: l.topics[0] === LISTER_TOPICS.PunkPurchased ? 'bought on market for ' + fmtEth(word(l.data, 0)) + ' ETH' : 'deposited by owner, listed with ' + fmtEth(word(l.data, 1)) + ' ETH backing',
        })),
        positionsOpened: nextH ? Number(word(nextH, 0)) - 1 : null,
        positionsListed: of(LISTER_TOPICS.PositionListed).length,
        positionsExited: of(LISTER_TOPICS.PositionExited).length,
        backingReductions: of(LISTER_TOPICS.BackingReduced).length,
        capital: {
          spendableEth: fmtEth(toBig(spendH)), lockedEth: fmtEth(toBig(lockedH)), balanceEth: fmtEth(toBig(balH)),
          purchaseCapacityEthPerBuy: fmtEth(toBig(capH)),
          fundedBy: Object.fromEntries(Object.entries(inflow).map(([a, v]) => [a === FWA_ADDRESS.toLowerCase() ? 'pool earnings (' + a + ')' : a === pool.contracts.feeSplitter ? 'trading fees via OwnerSplitterV2 (' + a + ')' : a === v.owner.toLowerCase() ? 'owner (' + a + ')' : a, fmtEth(v)])),
        },
        backingDecay: cfgH ? { everySeconds: Number(word(cfgH, 0)), amountEth: fmtEth(word(cfgH, 1)), floorEth: fmtEth(word(cfgH, 2)) } : null,
      };
    }
    const fwaBurn = {
      note: 'every FWA buyback (the token\'s own route and V2\'s protocol-fee buyback) burns a slice; burns are ERC-20 transfers to 0x0 on the token, so this counts every source. Supply only falls — 1,000,000,000 FWA were minted at deploy.',
      burned24hFwa: fwaWhole(sumData0(dayLogs)),
      burns24h: dayLogs.length,
      burned7dFwa: fwaWhole(sumData0(weekLogs)),
      avgPerDay7dFwa: fwaWhole(sumData0(weekLogs) / BigInt(weekRanges.length)),
      totalSupplyFwa: fwaWhole(fwaSupply),
      initialSupplyFwa: 1000000000,
      burnedToDateFwa: fwaWhole(INITIAL_FWA_SUPPLY - fwaSupply),
      burnedToDatePctOfInitial: pct(INITIAL_FWA_SUPPLY - fwaSupply, INITIAL_FWA_SUPPLY),
      pace24hPctOfSupply: pct(sumData0(dayLogs), fwaSupply),
      burned7dBySource: Object.fromEntries(Object.entries(burnBySource).map(([a, v]) => [a === FWA_TOKEN.toLowerCase() ? 'FWA token buyback route (' + a + ')' : a === POOLS.v2.contracts.buyback.toLowerCase() ? 'V2 protocol-fee buyback (' + a + ')' : a, fwaWhole(v)])),
    };

    const wlName = (addr) => wl.get(addr) || null;
    const finishPull = (p) => {
      const seen = collectionsSeen.get(p.listingId);
      const { backingWei, ...rest } = p;
      return {
        ...rest,
        collection: seen ? seen.collection : null,
        collectionName: seen ? (wlName(seen.collection) || seen.collection) : null,
        tokenId: seen ? seen.tokenId : null,
      };
    };
    const recentPulls = allPullsChrono.slice(-15).reverse().map(finishPull);
    const topPulls24h = [...allPullsChrono].sort((a, b) => (b.backingWei > a.backingWei ? 1 : -1)).slice(0, 5).map(finishPull);
    const recentDeposits = depositEvents.slice(-10).reverse().map((rec) => ({
      ...rec, collectionName: wlName(rec.collection) || rec.collection,
    }));

    const recentRuleChanges = adminLogs.slice(-10).reverse().map((log) => {
      const base = blockMeta(log);
      if (log.topics[0] === T.ConfigSet) {
        const key = topicNum(log.topics[1]);
        const value = word(log.data, 0);
        return { ...base, change: (CONFIG_LABELS[key] || 'config key ' + key) + ' → ' + value.toString() };
      }
      const addr = wordAddr(log.topics[1], 0);
      if (log.topics[0] === T.OracleExemptionSet) {
        return { ...base, change: 'oracle exemption: ' + (wlName(addr) || addr) + (word(log.data, 0) === 0n ? ' revoked' : ' granted (no backing ceiling)') };
      }
      return { ...base, change: 'whitelist: ' + (wlName(addr) || addr) + (word(log.data, 0) === 0n ? ' removed' : ' allowed') };
    });

    // V2 blackout clock (wall time; the contract uses block.timestamp)
    let purchaseBlackout = null;
    if (isV2) {
      const t = nowS % BLACKOUT_PERIOD_S;
      const active = t >= BLACKOUT_START_S;
      const secondsToChange = active ? BLACKOUT_PERIOD_S - t : BLACKOUT_START_S - t;
      purchaseBlackout = {
        note: 'V2 refuses NEW purchases daily 11:45–12:00 and 23:45–00:00 UTC (fixed in the contract). Settlement, exits and VRF callbacks keep working; listings above their oracle ceiling can be kicked only inside these windows.',
        windowsUtc: ['11:45–12:00', '23:45–00:00'],
        active,
        contractSaysActive: v.isPurchaseBlackout === 1n,
        secondsToChange,
        changesAt: iso(nowS + secondsToChange),
      };
    }

    const out = {
      about: 'FWAAH! live snapshot of the FWA ' + pool.label + ' main pool (Ethereum mainnet). Field guide + how to go deeper: https://fwaah.com/skill.md',
      generatedAt: new Date().toISOString(),
      block: latest,
      chainId: 1,
      pool: {
        id: pool.id,
        label: pool.label,
        title: pool.title,
        note: isV2
          ? 'V2 (live since 2026-09-16) is a separate deployment from V1, not an upgrade. V1 keeps running with its own listings; the official site migrates by withdrawing from V1 and depositing into V2. Add ?pool=v1 to this URL for the V1 snapshot.'
          : 'V1 is the legacy main pool — still live with its own listings, fees and (ended) emission. V2 is the current pool: drop ?pool=v1 for its snapshot.',
        officialSite: pool.site,
        officialDocs: pool.docs,
        otherPoolSnapshot: 'https://fwaah.com/livedatasnapshot.json' + (isV2 ? '?pool=v1' : ''),
        otherPoolId: other.id,
      },
      contracts: {
        core: FWA_ADDRESS,
        token: v.token,
        rewards: v.rewards,
        vrfService: isV2 ? pool.contracts.vrfService : v.vrfService,
        ...(isV2 ? {
          floorOracle: v.floorOracle,
          buyback: buyback ? buyback.address : pool.contracts.buyback,
          purchaseNotifier: pool.contracts.purchaseNotifier,
          fwairLaunchManager: ZERO.test(v.fwairLaunchRegistry) ? null : v.fwairLaunchRegistry,
          punkLister: pool.contracts.punkLister,
        } : {}),
        owner: v.owner,
        payoutAddress: v.payoutAddress,
        whitelistManager: knobs.whitelistManager,
        deployBlock: pool.deployBlock,
        sourceAndAbi: {
          core: sourcify(FWA_ADDRESS),
          token: sourcify(v.token),
          rewards: sourcify(v.rewards),
          ...(isV2 ? { floorOracle: sourcify(v.floorOracle) } : {}),
        },
      },
      poolStats: {
        activeListings: Number(v.activeListingCount),
        poolEth: fmtEth(balance),
        pullPriceEth: fmtEth(v.acquisitionFee + (isV2 ? v.vrfServiceFee : 0n)),
        pullPoolFeeEth: fmtEth(v.acquisitionFee),
        ...(isV2 ? { pullVrfFeeEth: fmtEth(v.vrfServiceFee) } : {}),
        pendingPulls: Number(v.pendingAcquisitionCount),
        unsettledPulls: Number(v.unsettledAcquisitionCount),
        nextListingId: Number(v.nextListingId),
        totalWeight: v.totalWeight.toString(),
        weightedBackingTotal: v.weightedBackingTotal.toString(),
        escrowEth: fmtEth(v.acquisitionEscrowTotal),
        refundCreditEth: fmtEth(v.acquisitionRefundCreditTotal),
        accruedOwnerFeesEth: fmtEth(v.accruedOwnerFees),
      },
      crown: top ? {
        note: 'top-backed listing — earns crownTitheBps of every pull into its pot; takeover needs +crownTakeoverThresholdBps more backing'
          + (isV2 ? '. V2 crown commitment: withdrawing or shrinking it within 12h of taking it costs 1% of its full backing (being pulled, out-bid or oracle-kicked is free).' : ''),
        listingId: Number(v.topListingId),
        potEth: fmtEth(v.topListingPot),
        collection: top.collection,
        collectionName: top.collectionName,
        tokenId: top.tokenId,
        depositor: top.depositor,
        backingEth: fmtEth(top.backingWei),
        ...(isV2 && v.topListingSince ? {
          heldSince: iso(Number(v.topListingSince)),
          commitmentEndsAt: iso(Number(v.topListingSince) + CROWN_COMMITMENT_S),
          commitmentServed: nowS >= Number(v.topListingSince) + CROWN_COMMITMENT_S,
          earlyExitFeeBps: 100,
        } : {}),
      } : null,
      activity24h: {
        pulls: tally.pulls,
        pullFeesEth: fmtEth(tally.pullFeesWei),
        deposits: tally.deposits,
        withdrawals: tally.withdrawals,
        ...(isV2 ? { oracleKicks: tally.kicked, crownEarlyExitFees: tally.crownExitFees } : {}),
        pullOutcomes: outcomes,
      },
      recentPulls,
      topPulls24h,
      recentDeposits,
      ...(isV2 ? { recentKicks: kickEvents.slice(-10).reverse() } : {}),
      recentRuleChanges,
      fwaBurn,
      punks: {
        inPool: punksInPool,
        note: 'CryptoPunks (the 721 wrapper ' + PUNKS_721 + ') currently held by this pool: active, staged and won-but-unsettled listings',
        lister: listerOut,
      },
      rules: {
        pullSurchargeBps: Number(knobs.pullSurchargeBps),
        sellBackPayoutBps: Number(v.settlementDiscountBps),
        ...(isV2 ? { sellBackAsFwaBudgetBps: Number(v.tokenSettlementDiscountBps) } : {}),
        ownerCutOfPullsBps: Number(v.ownerAcquisitionFeeBps),
        ownerCutOfKeptNftsBps: Number(v.ownerSettlementFeeBps),
        crownTitheBps: Number(v.topListingShareBps),
        crownTakeoverThresholdBps: Number(v.topThresholdBps),
        retainedSliceToProtocol: v.retainedToProtocol !== 0n,
        winnerSettlementWindowSeconds: Number(v.settlementWindow),
        finalizeWindowSeconds: Number(v.finalizeWindow),
        selectionSlippageBps: Number(v.selectionSlippageBps),
        selectionTimeoutBlocks: Number(v.selectionTimeoutBlocks),
        minDepositBackingEth: fmtEth(knobs.minBacking),
        maxPullsPerTx: Number(knobs.maxPullsPerTx),
        protocolFeesToBuybackBps: Number(knobs.protocolFeeToTokenBps),
        pullsEnabled: knobs.pullsEnabled,
        withdrawOnlyMode: knobs.withdrawOnly,
        sellBackAsFwaEnabled: knobs.sellBackAsTokens,
        ...(isV2 ? {
          oracleCeiling: {
            note: 'unless the collection is oracle-exempt (see whitelist.oracleExempt) or the listing is a recognised FWAIR launch, backing must be ≤ the collection\'s floor-oracle ask × (1 + premium); a listing later above its ceiling can be kicked during a purchase blackout (full backing + NFT back to the depositor, no fee)',
            premiumBps: Number(v.oracleCeilingPremiumBps),
            maxQuoteAgeSeconds: Number(v.maxOracleAge),
            minChallengePeriodSeconds: Number(v.minOracleChallengePeriod),
          },
          crownCommitment: { seconds: CROWN_COMMITMENT_S, earlyExitFeeBps: 100, fixed: true },
        } : {}),
      },
      ...(isV2 ? { purchaseBlackout } : {}),
      // V1: a fixed 15-day emission. V2: no schedule — FWA arrives from buybacks
      // and is split by √backing (depositors) and per-24h-epoch shares (pullers).
      emission: emission && emission.start ? {
        startsAt: iso(emission.start),
        endsAt: emEnd ? iso(emEnd) : null,
        secondsRemaining: emEnd ? Math.max(0, emEnd - nowS) : null,
        ended: emEnd ? nowS >= emEnd : false,
        depositorFwaPerDay: Math.round(Number(emission.ratePerSec) / 1e18 * 86400),
        pullerFwaPerDay: Math.round(Number(emission.dailyPot) / 1e18),
        fwaTotalSupply: Math.round(Number(emission.supply) / 1e18),
        externalBuysOpen: emission.buysOpen,
        buybackPoolEth: fmtEth(emission.buybackPool),
      } : null,
      ...(rw && rw.start ? {
        rewards: {
          note: 'V2 has no fixed emission: FWA reaches the rewards module whenever the token\'s buyback route fires. Depositors split it by √backing (claimDepositorTokens / withdrawTokens); each successful pull earns one share of its 24h epoch\'s pot (claimEpochTokens once the epoch closes and every pull in it resolved). Apps routing pulls through their own contract earn builderRewardBps of protocol fees as an FWA-buy allowance.',
          epochsStartedAt: iso(rw.start),
          currentEpoch: Number(rw.epoch),
          currentEpochEndsAt: iso(rw.start + (Number(rw.epoch) + 1) * 86400),
          currentEpochPotFwa: Math.round(Number(epochNow.pot) / 1e18),
          currentEpochPulls: Number(epochNow.pulls),
          currentEpochPendingPulls: Number(epochNow.pending),
          currentEpochFwaPerPull: epochNow.pulls > 0n ? Math.round(Number(epochNow.pot / epochNow.pulls) / 1e18) : null,
          previousEpoch: epochPrev ? {
            potFwa: Math.round(Number(epochPrev.pot) / 1e18),
            pulls: Number(epochPrev.pulls),
            fwaPerPull: epochPrev.pulls > 0n ? Math.round(Number(epochPrev.pot / epochPrev.pulls) / 1e18) : null,
          } : null,
          depositorSqrtBackingTotal: rw.sqrtBackingTotal.toString(),
          fwaHeldByRewardsModule: Math.round(Number(rw.moduleBalance) / 1e18),
          ethQueuedForFwaBuys: fmtEth(rw.allowance),
          builderRewardBps: Number(rw.builderRewardBps),
          fwaTotalSupply: Math.round(Number(rw.supply) / 1e18),
          protocolFeeBuyback: buyback ? {
            address: buyback.address,
            ethWaiting: fmtEth(buyback.balance),
            maxEthPerCall: fmtEth(buyback.maxEthPerBuy),
            callerTipBps: Number(buyback.callerRewardBps),
            splitBps: { depositors: Number(buyback.depositorBps), purchasers: Number(buyback.purchaserBps), burn: Number(buyback.burnBps) },
            paused: buyback.paused,
            lastRunBlock: buyback.lastBuybackBlock,
            note: 'anyone can call buyback() on this contract to swap the waiting ETH for FWA (≤ maxEthPerCall per call, one block apart) and keep the caller tip; the FWA is routed to the rewards module per splitBps',
          } : null,
        },
      } : {}),
      whitelist: {
        enabled: knobs.whitelistEnabled,
        count: wl.size,
        collections: [...wl.entries()].map(([address, name]) => ({ address, name, ...(isV2 ? { oracleExempt: exempt.has(address) } : {}) })),
        ...(isV2 ? {
          oracleExempt: [...exempt],
          note: 'V2: being whitelisted is necessary but not sufficient — a non-exempt collection also needs a fresh floor-oracle quote, and backing must sit under its ceiling (rules.oracleCeiling)',
        } : {}),
      },
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=600');
    res.status(200).send(JSON.stringify(out, null, 2));
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: 'snapshot build failed: ' + String((e && e.message) || e) });
  }
};
