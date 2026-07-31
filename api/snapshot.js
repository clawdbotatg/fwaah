// GET /livedatasnapshot.json (rewritten here, see vercel.json) — one JSON
// document with the FWA pool's live state, built for LLM agents. The agent
// skill at /skill.md tells an agent to curl this instead of speaking raw
// JSON-RPC; everything is pre-decoded and labeled.
//
// Edge-cached (s-maxage=60, SWR 600) so any number of agents polling it cost
// at most one upstream refresh a minute. No hotlink guard: unlike /api/rpc
// and /api/meta this endpoint exists to be fetched from anywhere, and the
// cache bounds the damage.
//
// Upstream: RPC_UPSTREAM (Vercel env) in prod; NODE_RPC_URL (.env) via the
// setupProxy dev twin, so forks at home serve their own snapshot too.

const {
  FWA_ADDRESS, DEPLOY_BLOCK, SNAPSHOT_BLOCK, SELECTORS, TOPICS, CONFIG_LABELS,
  KNOB_SNAPSHOT, WHITELIST_SNAPSHOT,
  toBig, toNum, word, wordAddr, decodeString, fmtEth,
} = require('./_fwa');

const DAY_BLOCKS = 7200; // ~24h at 12s blocks

const ZERO = /^0x0{40}$/;

function rpcBody(calls) {
  return calls.map((c, i) => ({ jsonrpc: '2.0', id: i + 1, method: c[0], params: c[1] }));
}

async function rpc(upstream, calls) {
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
    if (!r || r.error) throw new Error((r && r.error && r.error.message) || 'rpc error on ' + c[0]);
    return r.result;
  });
}

function call(to, selector, argWords = []) {
  const data = selector + argWords.map((w) => BigInt(w).toString(16).padStart(64, '0')).join('');
  return ['eth_call', [{ to, data }, 'latest']];
}

const sourcify = (addr) => `https://sourcify.dev/server/v2/contract/1/${addr}?fields=sources,abi`;

module.exports = async (req, res) => {
  const upstream = process.env.RPC_UPSTREAM || process.env.NODE_RPC_URL;
  if (!upstream) {
    res.status(500).json({ error: 'no RPC upstream configured (RPC_UPSTREAM / NODE_RPC_URL)' });
    return;
  }

  try {
    // ---- batch 1: block, pool balance, every core view with a getter ----
    const numKeys = [
      'activeListingCount', 'acquisitionFee', 'totalWeight', 'weightedBackingTotal',
      'pendingAcquisitionCount', 'unsettledAcquisitionCount', 'topListingId', 'topListingPot',
      'nextListingId', 'accruedOwnerFees', 'acquisitionEscrowTotal', 'acquisitionRefundCreditTotal',
      'finalizeWindow', 'ownerAcquisitionFeeBps', 'ownerSettlementFeeBps', 'topListingShareBps',
      'topThresholdBps', 'retainedToProtocol', 'selectionSlippageBps', 'selectionTimeoutBlocks',
      'settlementDiscountBps', 'settlementWindow',
    ];
    const addrKeys = ['owner', 'payoutAddress', 'token', 'rewards', 'vrfService'];
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

    // ---- batch 2: crown listing, emission module, admin-event overlay ----
    const calls2 = [];
    const hasTop = v.topListingId !== 0n;
    if (hasTop) calls2.push(call(FWA_ADDRESS, SELECTORS.listings, [v.topListingId]));
    const hasRewards = v.rewards && !ZERO.test(v.rewards);
    if (hasRewards) {
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
    // admin events since the baked snapshot block, chunked under the 100k-block
    // getLogs cap a home node enforces (rare events — each chunk is tiny)
    const CHUNK = 90000;
    const ranges = [];
    for (let from = SNAPSHOT_BLOCK + 1; from <= latest; from += CHUNK) {
      ranges.push([from, Math.min(from + CHUNK - 1, latest)]);
    }
    calls2.push(...ranges.map(([from, to]) => ['eth_getLogs', [{
      address: FWA_ADDRESS,
      fromBlock: '0x' + from.toString(16),
      toBlock: '0x' + to.toString(16),
      topics: [[TOPICS.ConfigSet, TOPICS.CollectionWhitelistSet]],
    }]]));

    // 24h activity feed, chunked so a home node's ~20k-results getLogs cap holds
    const FEED_TOPICS = [
      TOPICS.AcquisitionRequested, TOPICS.NFTAllocated, TOPICS.NFTKept, TOPICS.NFTRelisted,
      TOPICS.DepositorBidAccepted, TOPICS.DepositorBidAcceptedAsTokens,
      TOPICS.AcquisitionExpired, TOPICS.AcquisitionRefundedNoListing, TOPICS.AcquisitionRefundedSlippage,
      TOPICS.NFTListed, TOPICS.ListingWithdrawn, TOPICS.UnsettledFinalized,
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
    let emission = null;
    if (hasRewards) {
      const [startH, durH, rateH, potH, supplyH, buyingH, buyPoolH] = r2.slice(i2, i2 + 7);
      i2 += 7;
      emission = {
        start: toNum(startH), duration: toNum(durH),
        ratePerSec: toBig(rateH), dailyPot: toBig(potH), supply: toBig(supplyH),
        buysOpen: toBig(buyingH) === 1n, buybackPool: toBig(buyPoolH),
      };
    }
    const adminLogs = [].concat(...r2.slice(i2, feedRangeStart));
    const feedLogs = [].concat(...r2.slice(feedRangeStart));

    // overlay the baked knob/whitelist snapshot with anything that changed since
    const knobs = { ...KNOB_SNAPSHOT };
    const wl = new Map(WHITELIST_SNAPSHOT);
    adminLogs.forEach((log) => {
      if (log.topics[0] === TOPICS.ConfigSet) {
        const key = Number(BigInt(log.topics[1]));
        const value = word(log.data, 0);
        if (key === 13) knobs.pullSurchargeBps = value;
        else if (key === 22) knobs.minBacking = value;
        else if (key === 41) knobs.pullsEnabled = value !== 0n;
        else if (key === 42) knobs.withdrawOnly = value !== 0n;
        else if (key === 43) knobs.whitelistEnabled = value !== 0n;
        else if (key === 44) knobs.sellBackAsTokens = value !== 0n;
        else if (key === 12) knobs.maxPullsPerTx = value;
        else if (key === 62) knobs.whitelistManager = wordAddr(log.data, 0);
      } else if (log.topics[0] === TOPICS.CollectionWhitelistSet) {
        const addr = wordAddr(log.topics[1], 0);
        if (word(log.data, 0) === 0n) wl.delete(addr);
        else if (!wl.has(addr)) wl.set(addr, null); // name resolved below
      }
    });

    // ---- batch 3: name() for the crown collection + any new whitelist entries ----
    const unnamed = [...wl.entries()].filter(([, name]) => !name).map(([addr]) => addr);
    const nameTargets = [...unnamed];
    if (top && !nameTargets.includes(top.collection)) nameTargets.push(top.collection);
    if (nameTargets.length) {
      const r3 = await rpc(upstream, nameTargets.map((a) => call(a, SELECTORS.name)));
      nameTargets.forEach((a, i) => {
        const name = decodeString(r3[i]);
        if (wl.has(a) && !wl.get(a)) wl.set(a, name || a);
        if (top && top.collection === a) top.collectionName = wl.get(a) || name || a;
      });
    } else if (top) {
      top.collectionName = wl.get(top.collection) || top.collection;
    }
    if (top && !top.collectionName) top.collectionName = wl.get(top.collection) || top.collection;

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
    const tally = { pulls: 0, pullFeesWei: 0n, deposits: 0, withdrawals: 0 };
    const outcomes = { allocated: 0, kept: 0, soldBackForEth: 0, soldBackForFwa: 0, relisted: 0, refundedOrExpired: 0, defaulted: 0 };
    const pullsById = new Map(); // listingId -> pull record (last allocation wins)
    const depositEvents = [];
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
      }
    });

    // collection/tokenId for pulled listings: 24h NFTListed events first,
    // then a best-effort listings() batch for ids deposited before the window
    const needStruct = [...pullsById.values()].filter((p) => !collectionsSeen.has(p.listingId));
    if (needStruct.length) {
      const rStruct = await rpc(upstream, needStruct.map((p) => call(FWA_ADDRESS, SELECTORS.listings, [BigInt(p.listingId)])));
      needStruct.forEach((p, i) => {
        const raw = rStruct[i];
        const coll = wordAddr(raw, 0);
        if (!ZERO.test(coll)) collectionsSeen.set(p.listingId, { collection: coll, tokenId: word(raw, 3).toString() });
      });
    }
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
    const allPulls = [...pullsById.values()];
    const recentPulls = allPulls.slice(-15).reverse().map(finishPull);
    const topPulls24h = [...allPulls].sort((a, b) => (b.backingWei > a.backingWei ? 1 : -1)).slice(0, 5).map(finishPull);
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
      return { ...base, change: 'whitelist: ' + (wlName(addr) || addr) + (word(log.data, 0) === 0n ? ' removed' : ' allowed') };
    });

    const out = {
      about: 'FWAAH! live snapshot of the FWA pool (Ethereum mainnet). Field guide + how to go deeper: https://fwaah.com/skill.md',
      generatedAt: new Date().toISOString(),
      block: latest,
      chainId: 1,
      contracts: {
        core: FWA_ADDRESS,
        token: v.token,
        rewards: v.rewards,
        vrfService: v.vrfService,
        owner: v.owner,
        payoutAddress: v.payoutAddress,
        whitelistManager: knobs.whitelistManager,
        deployBlock: DEPLOY_BLOCK,
        sourceAndAbi: {
          core: sourcify(FWA_ADDRESS),
          token: sourcify(v.token),
          rewards: sourcify(v.rewards),
        },
      },
      pool: {
        activeListings: Number(v.activeListingCount),
        poolEth: fmtEth(balance),
        pullPriceEth: fmtEth(v.acquisitionFee),
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
        note: 'top-backed listing — earns crownTitheBps of every pull into its pot; takeover needs +crownTakeoverThresholdBps more backing',
        listingId: Number(v.topListingId),
        potEth: fmtEth(v.topListingPot),
        collection: top.collection,
        collectionName: top.collectionName,
        tokenId: top.tokenId,
        depositor: top.depositor,
        backingEth: fmtEth(top.backingWei),
      } : null,
      activity24h: {
        pulls: tally.pulls,
        pullFeesEth: fmtEth(tally.pullFeesWei),
        deposits: tally.deposits,
        withdrawals: tally.withdrawals,
        pullOutcomes: outcomes,
      },
      recentPulls,
      topPulls24h,
      recentDeposits,
      recentRuleChanges,
      rules: {
        pullSurchargeBps: Number(knobs.pullSurchargeBps),
        sellBackPayoutBps: Number(v.settlementDiscountBps),
        ownerCutOfPullsBps: Number(v.ownerAcquisitionFeeBps),
        ownerCutOfSellBacksBps: Number(v.ownerSettlementFeeBps),
        crownTitheBps: Number(v.topListingShareBps),
        crownTakeoverThresholdBps: Number(v.topThresholdBps),
        retainedSliceToProtocol: v.retainedToProtocol !== 0n,
        winnerSettlementWindowSeconds: Number(v.settlementWindow),
        finalizeWindowSeconds: Number(v.finalizeWindow),
        selectionSlippageBps: Number(v.selectionSlippageBps),
        selectionTimeoutBlocks: Number(v.selectionTimeoutBlocks),
        minDepositBackingEth: fmtEth(knobs.minBacking),
        maxPullsPerTx: Number(knobs.maxPullsPerTx),
        pullsEnabled: knobs.pullsEnabled,
        withdrawOnlyMode: knobs.withdrawOnly,
      },
      emission: emission && emission.start ? {
        startsAt: new Date(emission.start * 1000).toISOString(),
        endsAt: emEnd ? new Date(emEnd * 1000).toISOString() : null,
        secondsRemaining: emEnd ? Math.max(0, emEnd - nowS) : null,
        ended: emEnd ? nowS >= emEnd : false,
        depositorFwaPerDay: Math.round(Number(emission.ratePerSec) / 1e18 * 86400),
        pullerFwaPerDay: Math.round(Number(emission.dailyPot) / 1e18),
        fwaTotalSupply: Math.round(Number(emission.supply) / 1e18),
        externalBuysOpen: emission.buysOpen,
        buybackPoolEth: fmtEth(emission.buybackPool),
      } : null,
      whitelist: {
        enabled: knobs.whitelistEnabled,
        count: wl.size,
        collections: [...wl.entries()].map(([address, name]) => ({ address, name })),
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
