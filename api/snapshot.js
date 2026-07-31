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
  FWA_ADDRESS, DEPLOY_BLOCK, SNAPSHOT_BLOCK, SELECTORS, TOPICS,
  KNOB_SNAPSHOT, WHITELIST_SNAPSHOT,
  toBig, toNum, word, wordAddr, decodeString, fmtEth,
} = require('./_fwa');

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
    const adminLogs = [].concat(...r2.slice(i2));

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
