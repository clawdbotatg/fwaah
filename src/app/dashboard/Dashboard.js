import React, { Component } from 'react';
import { Bar, Doughnut } from 'react-chartjs-2';
import PullTicker from './PullTicker';
import HighValuePulls from './HighValuePulls';
import RecentDeposits from './RecentDeposits';
import NodeStatusBar from './NodeStatusBar';
import PullPanel from './PullPanel';
import MyDeposits from './MyDeposits';
import DepositPanel from './DepositPanel';
import LiveFeed from './LiveFeed';
import FwaAddress from '../fwa/FwaAddress';
import {
  FWA_ADDRESS, ETHERSCAN, SELECTORS, TOPICS, FEED_TOPICS, ADMIN_TOPICS,
  KNOB_SNAPSHOT, WHITELIST_SNAPSHOT, ORACLE_EXEMPT_SNAPSHOT,
  POOL, POOLS, OTHER_POOL, IS_V2, poolUrl, blackoutState, applyConfigSet, CROWN_COMMITMENT_S,
  FWA_TOKEN, PUNKS_721, INITIAL_FWA_SUPPLY, TRANSFER_TOPIC, ZERO_TOPIC, PUNK_LISTER, LISTER_SELECTORS, LISTER_TOPICS,
  rpcBatch, rpcBatchSafe, ethCall, ethCallTo, toBig, toNum, word, wordAddr, topicNum, topicAddr,
  fmtEth, fmtNum, fmtAge, shortAddr, describeLog, openSeaUrl, abiNinjaUrl,
  fetchListingArt, POLL,
} from '../fwa/fwa';

const STATS_INTERVAL_MS = POLL.stats;
const LOGS_INTERVAL_MS = POLL.logs;
const DAY_BLOCKS = 7200; // ~24h of 12s blocks

const ADMIN_SCAN_BLOCKS = 50400; // ~7d
const ADMIN_CHUNK = 7200;
const ADMIN_MAX_CHUNKS = 60; // deepest overlay scan (~60d) before pools.json must be regenerated
const ZERO_ADDR = /^0x0{40}$/;
const fmtWindow = (s) => (s % 86400 === 0 ? s / 86400 + 'd' : s % 3600 === 0 ? s / 3600 + 'h' : Math.round(s / 60) + 'm');
const fmtUtc = (ms) => new Date(ms).toISOString().slice(11, 16) + ' UTC';



const chartFont = '#6c7293';
const gridColor = 'rgba(255,255,255,0.06)';

export class Dashboard extends Component {
  state = {
    error: null,
    lastUpdated: null,
    node: null,
    fwa: null,
    topListing: null,
    topArt: null,
    emission: null, // V1 rewards module (fixed 15-day emission)
    rewardsV2: null, // V2 rewards module (buyback-fed epochs)
    hourly: null,
    outcomes: null,
    feed: [],
    knobs: KNOB_SNAPSHOT,
    whitelist: WHITELIST_SNAPSHOT,
    oracleExempt: ORACLE_EXEMPT_SNAPSHOT,
    adminFeed: [],
    blackout: blackoutState(),
    sinks: null, // { burn, punks } — where protocol fees end up: FWA burned, punks bought
  };

  componentDidMount() {
    this.refreshStats();
    this.refreshLogs();
    this.refreshSinks();
    this.statsTimer = setInterval(() => this.refreshStats(), STATS_INTERVAL_MS);
    this.logsTimer = setInterval(() => { this.refreshLogs(); this.refreshSinks(); }, LOGS_INTERVAL_MS);
    // the V2 purchase blackout is wall-clock: keep its countdown honest
    if (IS_V2) this.tickTimer = setInterval(() => this.setState({ blackout: blackoutState() }), 5000);
  }

  componentWillUnmount() {
    clearInterval(this.statsTimer);
    clearInterval(this.logsTimer);
    clearInterval(this.tickTimer);
  }

  async refreshStats() {
    try {
      const keys = [
        'activeListingCount', 'acquisitionFee', 'totalWeight', 'weightedBackingTotal',
        'pendingAcquisitionCount', 'unsettledAcquisitionCount', 'unfulfilledVrfCount',
        'lastIssuedSequence', 'nextSequenceToProcess', 'topListingId', 'topListingPot',
        'accruedOwnerFees', 'acquisitionEscrowTotal', 'acquisitionRefundCreditTotal',
        'nextListingId',
        // rules-of-the-game knobs with public getters — always live
        'settlementDiscountBps', 'settlementWindow', 'finalizeWindow',
        'ownerAcquisitionFeeBps', 'ownerSettlementFeeBps',
        'topListingShareBps', 'topThresholdBps', 'retainedToProtocol',
        'selectionSlippageBps', 'selectionTimeoutBlocks',
        // per-pool extras: V2 grew an oracle ceiling, a second cashout rate,
        // crown tenure and a purchase blackout; V1 exposes its tree root
        ...(IS_V2
          ? ['topListingSince', 'tokenSettlementDiscountBps', 'oracleCeilingPremiumBps', 'maxOracleAge', 'minOracleChallengePeriod', 'isPurchaseBlackout']
          : ['treeRootWeight']),
      ];
      const addrKeys = ['owner', 'payoutAddress', 'token', 'rewards', ...(IS_V2 ? ['floorOracle', 'fwairLaunchRegistry'] : ['vrfService'])];
      const calls = keys.map((k) => ethCall(SELECTORS[k]))
        .concat(addrKeys.map((k) => ethCall(SELECTORS[k])));
      calls.push(['eth_getBalance', [FWA_ADDRESS, 'latest']]);

      const res = await rpcBatch(calls);
      const fwa = {};
      keys.forEach((k, i) => { fwa[k] = toBig(res[i]); });
      addrKeys.forEach((k, i) => { fwa[k] = wordAddr(res[keys.length + i], 0); });
      const balance = toBig(res[keys.length + addrKeys.length]);

      let topListing = null;
      if (fwa.topListingId !== 0n) {
        const [raw] = await rpcBatch([ethCall(SELECTORS.listings, [fwa.topListingId])]);
        topListing = {
          collection: wordAddr(raw, 0),
          depositor: wordAddr(raw, 1),
          tokenId: word(raw, 3),
          value: word(raw, 5),
        };
      }

      // rewards module (zero address = not wired). V1: a fixed 15-day emission
      // with per-second/per-day rates. V2: no schedule at all — FWA arrives
      // whenever the token's buyback route fires, then splits by √backing
      // (depositors) and per-24h-epoch pull shares (purchasers).
      let emission = null;
      let rewardsV2 = null;
      if (fwa.rewards && !ZERO_ADDR.test(fwa.rewards) && IS_V2) {
        try {
          const [startH, epochH, supplyH, buyingH, allowH, sqrtH, builderH, buybackH, rwBalH] = await rpcBatch([
            ethCallTo(fwa.rewards, SELECTORS.epochStart),
            ethCallTo(fwa.rewards, SELECTORS.currentEpoch),
            ethCallTo(fwa.token, SELECTORS.totalSupply),
            ethCallTo(fwa.rewards, SELECTORS.isBuying),
            ethCallTo(fwa.rewards, SELECTORS.tokenBuyAllowanceTotal),
            ethCallTo(fwa.rewards, SELECTORS.sqrtBackingTotal),
            ethCallTo(fwa.rewards, SELECTORS.builderRewardBps),
            ethCallTo(fwa.rewards, SELECTORS.buyback),
            ethCallTo(fwa.token, SELECTORS.balanceOf, [fwa.rewards]),
          ]);
          const epoch = toBig(epochH);
          const buyback = wordAddr(buybackH, 0);
          const hasBuyback = !ZERO_ADDR.test(buyback);
          const calls = [
            ethCallTo(fwa.rewards, SELECTORS.purchaserEpochPot, [epoch]),
            ethCallTo(fwa.rewards, SELECTORS.acquisitionsInEpoch, [epoch]),
            ethCallTo(fwa.rewards, SELECTORS.pendingAcquisitionsInEpoch, [epoch]),
          ];
          if (epoch > 0n) {
            calls.push(
              ethCallTo(fwa.rewards, SELECTORS.purchaserEpochPot, [epoch - 1n]),
              ethCallTo(fwa.rewards, SELECTORS.acquisitionsInEpoch, [epoch - 1n]),
            );
          }
          if (hasBuyback) {
            calls.push(
              ethCallTo(buyback, SELECTORS.maxEthPerBuy), ethCallTo(buyback, SELECTORS.callerRewardBps),
              ethCallTo(buyback, SELECTORS.routeDepositorBps), ethCallTo(buyback, SELECTORS.routePurchaserBps),
              ethCallTo(buyback, SELECTORS.routeBurnBps), ethCallTo(buyback, SELECTORS.paused),
              ethCallTo(buyback, SELECTORS.lastBuybackBlock), ['eth_getBalance', [buyback, 'latest']],
            );
          }
          const r = await rpcBatchSafe(calls);
          let i = 0;
          const pot = toBig(r[i++]);
          const pulls = toBig(r[i++]);
          const pending = toBig(r[i++]);
          const prev = epoch > 0n ? { pot: toBig(r[i++]), pulls: toBig(r[i++]) } : null;
          let bb = null;
          if (hasBuyback) {
            bb = {
              address: buyback,
              maxEthPerBuy: toBig(r[i++]), callerRewardBps: toBig(r[i++]),
              depositorBps: toBig(r[i++]), purchaserBps: toBig(r[i++]), burnBps: toBig(r[i++]),
              paused: toBig(r[i++]) === 1n, lastBlock: toNum(r[i++]), balance: toBig(r[i++]),
            };
          }
          rewardsV2 = {
            start: toNum(startH), epoch: Number(epoch), supply: toBig(supplyH),
            buysOpen: toBig(buyingH) === 1n, allowance: toBig(allowH),
            sqrtBackingTotal: toBig(sqrtH), builderRewardBps: toBig(builderH), moduleBalance: toBig(rwBalH),
            pot, pulls, pending, prev, buyback: bb,
          };
        } catch (e) { /* module views are decoration */ }
      } else if (fwa.rewards && !ZERO_ADDR.test(fwa.rewards)) {
        try {
          const [startH, durH, rateH, potH, supplyH, buyingH, buyPoolH] = await rpcBatch([
            ethCallTo(fwa.rewards, SELECTORS.emissionStart),
            ethCallTo(fwa.rewards, SELECTORS.emissionDuration),
            ethCallTo(fwa.rewards, SELECTORS.depositorRatePerSec),
            ethCallTo(fwa.rewards, SELECTORS.purchaserDailyPot),
            ethCallTo(fwa.token, SELECTORS.totalSupply),
            ethCallTo(fwa.rewards, SELECTORS.isBuying),
            ethCallTo(fwa.rewards, SELECTORS.tokenBuyAllowanceTotal),
          ]);
          emission = {
            start: toNum(startH),
            duration: toNum(durH),
            ratePerSec: toBig(rateH),
            dailyPot: toBig(potH),
            supply: toBig(supplyH),
            buysOpen: toBig(buyingH) === 1n,
            buybackPool: toBig(buyPoolH),
          };
        } catch (e) { /* module views are decoration */ }
      }

      this.setState({
        error: null,
        lastUpdated: new Date(),
        fwa: { ...fwa, balance },
        topListing,
        emission,
        rewardsV2,
      });

      // top listing art (cached after the first hit; cheap to re-ask)
      if (fwa.topListingId !== 0n && (!this.state.topArt || this.state.topArt.id !== Number(fwa.topListingId))) {
        const id = Number(fwa.topListingId);
        const art = await fetchListingArt([id]);
        if (art[id] && art[id].img) this.setState({ topArt: { id, img: art[id].img } });
      }
    } catch (e) {
      this.setState({ error: String(e.message || e) });
    }
  }

  async refreshLogs() {
    try {
      const [latestHex] = await rpcBatch([['eth_blockNumber', []]]);
      const latest = toNum(latestHex);
      // the node caps eth_getLogs at 20k results, so slice the 24h window into chunks
      const CHUNKS = 8;
      const chunkSize = Math.ceil(DAY_BLOCKS / CHUNKS);
      const start = Math.max(latest - DAY_BLOCKS, 0);
      const ranges = [];
      for (let from = start; from <= latest; from += chunkSize) {
        ranges.push([from, Math.min(from + chunkSize - 1, latest)]);
      }
      const chunks = await rpcBatch(ranges.map(([from, to]) => [
        'eth_getLogs',
        [{
          address: FWA_ADDRESS,
          fromBlock: '0x' + from.toString(16),
          toBlock: '0x' + to.toString(16),
          topics: [FEED_TOPICS],
        }],
      ]));
      const logs = [].concat(...chunks);

      // hourly buckets for acquisitions + fee volume (12s block-time mapping)
      const buckets = Array.from({ length: 24 }, () => ({ count: 0, fees: 0 }));
      const nowMs = Date.now();
      const outcomes = { Allocated: 0, Kept: 0, 'Bid accepted': 0, Relisted: 0, 'Refund/expired': 0 };

      logs.forEach((log) => {
        const bn = toNum(log.blockNumber);
        const t0 = log.topics[0];
        if (t0 === TOPICS.AcquisitionRequested) {
          const ageHours = ((latest - bn) * 12) / 3600;
          const bucket = 23 - Math.min(Math.floor(ageHours), 23);
          buckets[bucket].count += 1;
          buckets[bucket].fees += Number(word(log.data, 0)) / 1e18;
        } else if (t0 === TOPICS.NFTAllocated) outcomes.Allocated += 1;
        else if (t0 === TOPICS.NFTKept) outcomes.Kept += 1;
        else if (t0 === TOPICS.DepositorBidAccepted || t0 === TOPICS.DepositorBidAcceptedAsTokens) outcomes['Bid accepted'] += 1;
        else if (t0 === TOPICS.NFTRelisted) outcomes.Relisted += 1;
        else if (t0 === TOPICS.AcquisitionExpired || t0 === TOPICS.AcquisitionRefundedNoListing || t0 === TOPICS.AcquisitionRefundedSlippage) outcomes['Refund/expired'] += 1;
      });

      const labels = buckets.map((_, i) => {
        const d = new Date(nowMs - (23 - i) * 3600 * 1000);
        return d.getHours().toString().padStart(2, '0') + ':00';
      });

      const feed = logs.slice(-40).reverse().map((log) => ({
        key: log.transactionHash + log.logIndex,
        block: toNum(log.blockNumber),
        tx: log.transactionHash,
        ...describeLog(log),
      }));

      this.setState({ hourly: { labels, buckets }, outcomes, feed });

      // 7d admin scan: knob turns, whitelist edits, ownership moves. Rare
      // events, so the chunked calls return almost nothing; a failed scan
      // just leaves the verified snapshot in place.
      this.refreshAdmin(latest).catch(() => {});
    } catch (e) {
      this.setState({ error: String(e.message || e) });
    }
  }

  // Fee sinks. Burn: every FWA buyback (the token's own route and V2's
  // protocol-fee buyback) burns a slice — burns are ERC-20 Transfers to 0x0,
  // so one topic-filtered scan on the token counts every source. Punks: how
  // many CryptoPunks the pool custodies, and (V2) what the Punk lister has
  // bought, deposited and listed — read from its own events since launch.
  async refreshSinks() {
    try {
      const [latestHex] = await rpcBatch([['eth_blockNumber', []]]);
      const latest = toNum(latestHex);
      const burnRange = (from, to) => ['eth_getLogs', [{
        address: FWA_TOKEN, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16),
        topics: [TRANSFER_TOPIC, null, ZERO_TOPIC],
      }]];
      // exactly 7 day-sized chunks ending at `latest`, so the last one IS the newest 24h
      const weekRanges = [];
      for (let from = Math.max(latest - 7 * DAY_BLOCKS + 1, 0); from <= latest; from += DAY_BLOCKS) {
        weekRanges.push([from, Math.min(from + DAY_BLOCKS - 1, latest)]);
      }
      const calls = [
        ethCallTo(FWA_TOKEN, SELECTORS.totalSupply),
        ethCallTo(PUNKS_721, SELECTORS.balanceOf, [FWA_ADDRESS]),
        ...weekRanges.map(([a, b]) => burnRange(a, b)),
      ];
      const listerStart = calls.length;
      if (PUNK_LISTER) {
        const lk = ['lockedCapital', 'spendableCapital', 'purchaseCapacity', 'publicMarketPurchasesEnabled', 'nextPositionId', 'paused', 'configuration'];
        calls.push(...lk.map((k) => ethCallTo(PUNK_LISTER, LISTER_SELECTORS[k])));
        calls.push(['eth_getBalance', [PUNK_LISTER, 'latest']]);
        // lister events since the V2 start block, chunked under a home node's ~100k-block getLogs cap
        for (let from = POOL.deployBlock; from <= latest; from += 90000) {
          calls.push(['eth_getLogs', [{ address: PUNK_LISTER, fromBlock: '0x' + from.toString(16), toBlock: '0x' + Math.min(from + 89999, latest).toString(16) }]]);
        }
      }
      const res = await rpcBatchSafe(calls);
      const supply = toBig(res[0]);
      const punksInPool = res[1] ? Number(word(res[1], 0)) : null;
      const dayLogs = res[listerStart - 1] || []; // the last range is the newest ~24h
      const weekLogs = [].concat(...weekRanges.map((_, i) => res[2 + i] || []));
      const sum = (logs) => logs.reduce((acc, l) => acc + word(l.data, 0), 0n);
      const bySource = {};
      weekLogs.forEach((l) => { const a = topicAddr(l.topics[1]).toLowerCase(); bySource[a] = (bySource[a] || 0n) + word(l.data, 0); });
      const burn = {
        day: sum(dayLogs), dayCount: dayLogs.length,
        week: sum(weekLogs), weekCount: weekLogs.length, weekDays: weekRanges.length,
        supply, burnedToDate: INITIAL_FWA_SUPPLY - supply, bySource,
      };
      let lister = null;
      if (PUNK_LISTER) {
        let i = listerStart;
        const g = () => res[i++];
        const [lockedH, spendH, capH, enabledH, nextH, pausedH, cfgH, balH] = [g(), g(), g(), g(), g(), g(), g(), g()];
        const logs = [].concat(...res.slice(i).map((x) => x || []));
        const count = (t) => logs.filter((l) => l.topics[0] === t).length;
        const bought = logs.filter((l) => l.topics[0] === LISTER_TOPICS.PunkPurchased);
        const deposited = logs.filter((l) => l.topics[0] === LISTER_TOPICS.WrappedPunkDeposited);
        const inflow = {};
        logs.filter((l) => l.topics[0] === LISTER_TOPICS.CapitalLocked).forEach((l) => { const a = topicAddr(l.topics[1]).toLowerCase(); inflow[a] = (inflow[a] || 0n) + word(l.data, 0); });
        lister = {
          locked: toBig(lockedH), spendable: toBig(spendH), capacity: toBig(capH), balance: toBig(balH),
          marketBuysEnabled: toBig(enabledH) === 1n, paused: toBig(pausedH) === 1n,
          positions: nextH ? Number(word(nextH, 0)) - 1 : null,
          exited: count(LISTER_TOPICS.PositionExited), listed: count(LISTER_TOPICS.PositionListed),
          bought: bought.length, boughtEth: sum(bought),
          deposited: deposited.length, depositedBacking: deposited.reduce((acc, l) => acc + word(l.data, 1), 0n),
          reductions: count(LISTER_TOPICS.BackingReduced),
          inflow,
          decayIntervalS: cfgH ? Number(word(cfgH, 0)) : null, decayAmount: cfgH ? word(cfgH, 1) : null, minBacking: cfgH ? word(cfgH, 2) : null,
        };
      }
      this.setState({ sinks: { burn, punks: { inPool: punksInPool, lister } } });
    } catch (e) { /* the card just shows its placeholder until the next poll */ }
  }

  async refreshAdmin(latest) {
    const ranges = [];
    // 7d back, or all the way to the baked snapshot when that is older, so the
    // knob/whitelist overlay is complete however stale pools.json gets (a 17-day
    // gap once hid a min-backing cut); capped at ~60d — past that, regenerate
    const start = Math.max(Math.min(latest - ADMIN_SCAN_BLOCKS, POOL.snapshotBlock + 1), latest - ADMIN_CHUNK * ADMIN_MAX_CHUNKS, 0);
    for (let from = start; from <= latest; from += ADMIN_CHUNK) {
      ranges.push([from, Math.min(from + ADMIN_CHUNK - 1, latest)]);
    }
    const chunks = await rpcBatch(ranges.map(([from, to]) => [
      'eth_getLogs',
      [{
        address: FWA_ADDRESS,
        fromBlock: '0x' + from.toString(16),
        toBlock: '0x' + to.toString(16),
        topics: [ADMIN_TOPICS],
      }],
    ]));
    const logs = [].concat(...chunks);

    // overlay the snapshot with anything the scan saw, oldest → newest
    const knobs = { ...KNOB_SNAPSHOT };
    const wl = new Map(WHITELIST_SNAPSHOT);
    const exempt = new Set(ORACLE_EXEMPT_SNAPSHOT);
    logs.forEach((log) => {
      if (log.topics[0] === TOPICS.ConfigSet) {
        applyConfigSet(knobs, topicNum(log.topics[1]), word(log.data, 0));
      } else if (log.topics[0] === TOPICS.CollectionWhitelistSet) {
        const addr = wordAddr(log.topics[1], 0);
        if (word(log.data, 0) === 0n) wl.delete(addr);
        else if (!wl.has(addr)) wl.set(addr, shortAddr(addr));
      } else if (log.topics[0] === TOPICS.OracleExemptionSet) {
        const addr = wordAddr(log.topics[1], 0);
        if (word(log.data, 0) === 0n) exempt.delete(addr);
        else exempt.add(addr);
      }
    });

    const adminFeed = logs.slice(-8).reverse().map((log) => ({
      key: log.transactionHash + log.logIndex,
      block: toNum(log.blockNumber),
      tx: log.transactionHash,
      ageS: (latest - toNum(log.blockNumber)) * 12,
      ...describeLog(log),
    }));

    this.setState({ knobs, whitelist: [...wl.entries()], oracleExempt: [...exempt], adminFeed });
  }

  render() {
    const { fwa, topListing, topArt, emission, rewardsV2, hourly, outcomes, feed, error, lastUpdated, knobs, whitelist, oracleExempt, adminFeed, blackout, sinks } = this.state;
    const exemptSet = new Set(oracleExempt.map((a) => a.toLowerCase()));
    // fee sinks
    const burn = sinks && sinks.burn;
    const fwaM = (wei) => fmtNum(Math.round(Number(wei) / 1e18));
    const burnPct = (part, whole) => (whole > 0n ? (Number(part * 1000000n / whole) / 10000).toFixed(part * 100n < whole ? 3 : 2) + '%' : '—');
    const burnSourceName = (a) => {
      if (a === FWA_TOKEN.toLowerCase()) return 'FWA token buyback route';
      if (a === POOLS.v2.contracts.buyback.toLowerCase()) return 'V2 protocol-fee buyback';
      if (fwa && a === fwa.rewards.toLowerCase()) return 'rewards module';
      return shortAddr(a);
    };
    const lister = sinks && sinks.punks.lister;

    // emission countdown (rendered fresh each stats poll — minute precision is plenty)
    const nowS = Date.now() / 1000;
    const emEnd = emission && emission.start ? emission.start + emission.duration : null;
    const emLeftS = emEnd !== null ? Math.max(0, emEnd - nowS) : null;
    const emPct = emission && emission.start && emEnd
      ? Math.min(100, Math.round((nowS - emission.start) / emission.duration * 100)) : null;
    const fmtDh = (s) => (s >= 86400 ? Math.floor(s / 86400) + 'd ' : '') + Math.floor((s % 86400) / 3600) + 'h';

    const backlog = fwa ? Number(fwa.lastIssuedSequence - fwa.nextSequenceToProcess + 1n) : 0;
    const invariantOk = fwa && !IS_V2 ? fwa.totalWeight === fwa.treeRootWeight : null;
    // V2 crown commitment: 12h of uninterrupted tenure before a free exit
    const crownHeldS = fwa && IS_V2 && fwa.topListingSince ? Math.max(0, nowS - Number(fwa.topListingSince)) : null;
    const crownLockLeftS = crownHeldS !== null ? Math.max(0, CROWN_COMMITMENT_S - crownHeldS) : null;
    // V2 rewards: FWA per pull in the running epoch (pot so far ÷ pulls so far)
    const fwaPerPull = rewardsV2 && rewardsV2.pulls > 0n ? Number(rewardsV2.pot / rewardsV2.pulls) / 1e18 : null;
    const prevFwaPerPull = rewardsV2 && rewardsV2.prev && rewardsV2.prev.pulls > 0n ? Number(rewardsV2.prev.pot / rewardsV2.prev.pulls) / 1e18 : null;
    const epochEndsS = rewardsV2 && rewardsV2.start ? rewardsV2.start + (rewardsV2.epoch + 1) * 86400 : null;
    const dayCount = hourly ? hourly.buckets.reduce((a, b) => a + b.count, 0) : null;
    const dayFees = hourly ? hourly.buckets.reduce((a, b) => a + b.fees, 0) : null;

    // pull EV = harmonic-mean backing; the fee is EV + the owner's surcharge
    const ev = fwa && fwa.totalWeight !== 0n ? fwa.weightedBackingTotal / fwa.totalWeight : null;
    const surchargePct = knobs.pullSurchargeBps ? Number(knobs.pullSurchargeBps) / 100
      : ev && ev !== 0n ? Math.round(Number(fwa.acquisitionFee * 10000n / ev - 10000n) / 10) / 10 : null;
    // fees split equally per active listing, after the owner + top-pot cuts
    const depositorShare = fwa ? 1 - Number(fwa.ownerAcquisitionFeeBps + fwa.topListingShareBps) / 10000 : 1;
    const perListing24h = dayFees !== null && fwa && fwa.activeListingCount !== 0n
      ? dayFees * depositorShare / Number(fwa.activeListingCount) : null;
    // pot inflow ≈ topListingShareBps of the 24h fee volume
    const potPerDay = dayFees !== null && fwa ? dayFees * Number(fwa.topListingShareBps) / 10000 : null;
    const seizeBar = fwa && topListing ? topListing.value * (10000n + fwa.topThresholdBps) / 10000n : null;

    const barData = hourly && {
      labels: hourly.labels,
      datasets: [
        {
          label: 'Acquisitions',
          data: hourly.buckets.map((b) => b.count),
          backgroundColor: '#0090e7',
          yAxisID: 'count',
          barPercentage: 0.6,
        },
        {
          label: 'Fees (ETH)',
          type: 'line',
          data: hourly.buckets.map((b) => Number(b.fees.toFixed(3))),
          borderColor: '#00d25b',
          backgroundColor: 'rgba(0,210,91,0.1)',
          fill: false,
          pointRadius: 2,
          yAxisID: 'fees',
        },
      ],
    };

    const barOptions = {
      responsive: true,
      maintainAspectRatio: false,
      legend: { labels: { fontColor: chartFont } },
      scales: {
        xAxes: [{ gridLines: { color: gridColor }, ticks: { fontColor: chartFont, maxTicksLimit: 12 } }],
        yAxes: [
          { id: 'count', position: 'left', gridLines: { color: gridColor }, ticks: { fontColor: chartFont, beginAtZero: true } },
          { id: 'fees', position: 'right', gridLines: { display: false }, ticks: { fontColor: '#00d25b', beginAtZero: true } },
        ],
      },
      tooltips: { mode: 'index', intersect: false },
    };

    const doughnutData = outcomes && {
      labels: Object.keys(outcomes),
      datasets: [{
        data: Object.values(outcomes),
        backgroundColor: ['#0090e7', '#00d25b', '#ffab00', '#8f5fe8', '#fc424a'],
        borderColor: '#191c24',
      }],
    };

    const doughnutOptions = {
      responsive: true,
      maintainAspectRatio: false,
      legend: { position: 'right', labels: { fontColor: chartFont, boxWidth: 12 } },
    };

    return (
      <div>
        <NodeStatusBar />
        <LiveFeed />
        <PullPanel />
        <DepositPanel />
        <MyDeposits />
        <PullTicker />
        <HighValuePulls />
        <RecentDeposits />
        <div className="page-header">
          <h3 className="page-title">
            <span className="page-title-icon bg-gradient-primary text-white mr-2">
              <i className="mdi mdi-cube-outline"></i>
            </span>
            FWA Protocol
            <span className={'badge ml-2 align-middle ' + (IS_V2 ? 'badge-primary' : 'badge-secondary')} title={POOL.title}>{POOL.label}</span>
            <a className="small ml-2 align-middle pool-switch" href={poolUrl(OTHER_POOL.id)} title={'this page is watching the ' + POOL.label + ' pool — switch to ' + OTHER_POOL.label}>
              switch to {OTHER_POOL.label} <i className="mdi mdi-swap-horizontal"></i>
            </a>
          </h3>
          <nav aria-label="breadcrumb">
            <span className="text-muted d-block">
              {error
                ? <span className="text-danger"><i className="mdi mdi-alert-circle"></i> {error}</span>
                : lastUpdated
                  ? <><i className="mdi mdi-refresh"></i> updated {lastUpdated.toLocaleTimeString()}</>
                  : 'loading…'}
            </span>
          </nav>
        </div>

        {/* main protocol stats */}
        <div className="row">
          <div className="col-xl-3 col-sm-6 grid-margin stretch-card">
            <div className="card">
              <div className="card-body">
                <div className="d-flex justify-content-between align-items-start">
                  <div>
                    <p className="text-muted mb-2">Pool Balance</p>
                    <h3 className="mb-0">{fwa ? fmtEth(fwa.balance, 2) : '—'} <small className="text-muted">ETH</small></h3>
                  </div>
                  <i className="mdi mdi-ethereum text-primary icon-lg"></i>
                </div>
                <p className="text-muted mb-0 mt-3 small">escrow {fwa ? fmtEth(fwa.acquisitionEscrowTotal, 2) : '—'} · refunds {fwa ? fmtEth(fwa.acquisitionRefundCreditTotal, 2) : '—'}</p>
              </div>
            </div>
          </div>
          <div className="col-xl-3 col-sm-6 grid-margin stretch-card">
            <div className="card">
              <div className="card-body">
                <div className="d-flex justify-content-between align-items-start">
                  <div>
                    <p className="text-muted mb-2">Acquisition Fee</p>
                    <h3 className="mb-0">{fwa ? fmtEth(fwa.acquisitionFee) : '—'} <small className="text-muted">ETH</small></h3>
                  </div>
                  <i className="mdi mdi-dice-multiple text-success icon-lg"></i>
                </div>
                <p className="text-muted mb-0 mt-3 small">
                  {blackout.active
                    ? <span className="text-warning"><i className="mdi mdi-pause-circle"></i> purchases paused until {fmtUtc(Date.now() + blackout.secondsToChange * 1000)} · {fmtAge(blackout.secondsToChange)} left</span>
                    : <React.Fragment>{dayCount !== null ? fmtNum(dayCount) + ' acquisitions / 24h' : '…'}{dayFees !== null ? ' · ' + dayFees.toFixed(2) + ' ETH fees' : ''}{IS_V2 && blackout.secondsToChange < 1800 ? <span className="text-warning"> · pause in {fmtAge(blackout.secondsToChange)}</span> : null}</React.Fragment>}
                </p>
              </div>
            </div>
          </div>
          <div className="col-xl-3 col-sm-6 grid-margin stretch-card">
            <div className="card">
              <div className="card-body">
                <div className="d-flex justify-content-between align-items-start">
                  <div>
                    <p className="text-muted mb-2">Active Listings</p>
                    <h3 className="mb-0">{fwa ? fmtNum(fwa.activeListingCount) : '—'}</h3>
                  </div>
                  <i className="mdi mdi-image-multiple text-warning icon-lg"></i>
                </div>
                <p className="text-muted mb-0 mt-3 small">{fwa ? fmtNum(fwa.nextListingId - 1n) + ' listings ever created' : '…'}</p>
              </div>
            </div>
          </div>
          <div className="col-xl-3 col-sm-6 grid-margin stretch-card">
            <div className="card">
              <div className="card-body">
                <div className="d-flex justify-content-between align-items-start">
                  <div>
                    <p className="text-muted mb-2">Sequencer</p>
                    <h3 className="mb-0">{fwa ? fmtNum(backlog) : '—'} <small className="text-muted">in flight</small></h3>
                  </div>
                  <i className={'mdi mdi-swap-vertical icon-lg ' + (backlog > 50 ? 'text-danger' : 'text-info')}></i>
                </div>
                <p className="text-muted mb-0 mt-3 small">{fwa ? 'seq ' + fmtNum(fwa.nextSequenceToProcess) + ' / ' + fmtNum(fwa.lastIssuedSequence) + ' · ' + fmtNum(fwa.pendingAcquisitionCount) + ' await VRF' : '…'}</p>
              </div>
            </div>
          </div>
        </div>

        {/* charts */}
        <div className="row">
          <div className="col-lg-8 grid-margin stretch-card">
            <div className="card">
              <div className="card-body">
                <h4 className="card-title mb-1">Acquisitions — last 24h</h4>
                <p className="text-muted small">hourly count and ETH fee volume</p>
                <div style={{ height: 280 }}>
                  {barData ? <Bar data={barData} options={barOptions} /> : <p className="text-muted">loading…</p>}
                </div>
              </div>
            </div>
          </div>
          <div className="col-lg-4 grid-margin stretch-card">
            <div className="card">
              <div className="card-body">
                <h4 className="card-title mb-1">Outcomes — last 24h</h4>
                <p className="text-muted small">allocations &amp; settlement choices</p>
                <div style={{ height: 280 }}>
                  {doughnutData ? <Doughnut data={doughnutData} options={doughnutOptions} /> : <p className="text-muted">loading…</p>}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* top listing + protocol health */}
        <div className="row">
          <div className="col-md-6 grid-margin stretch-card">
            <div className="card">
              <div className="card-body">
                <h4 className="card-title"><i className="mdi mdi-crown text-warning"></i> Top Listing — the Crown</h4>
                {fwa && fwa.topListingId !== 0n ? (
                  <div className="d-flex">
                    {topArt && topListing && (
                      <a
                        href={openSeaUrl(topListing.collection, topListing.tokenId.toString())}
                        target="_blank" rel="noopener noreferrer" className="mr-3"
                        title="view on OpenSea"
                      >
                        <img src={topArt.img} alt="" className="top-listing-art" loading="lazy" />
                      </a>
                    )}
                    <div>
                      <h2 className="mb-1">#{fmtNum(fwa.topListingId)}</h2>
                      <p className="mb-3 text-muted">
                        pot <span className="text-warning">{fmtEth(fwa.topListingPot)} ETH</span>
                        {potPerDay !== null && potPerDay > 0 && <span> · growing ≈ {potPerDay.toFixed(2)} ETH/day</span>}
                      </p>
                      {topListing && (
                        <ul className="list-unstyled mb-0 small">
                          <li className="mb-2">backing <strong>{fmtEth(topListing.value, 2)} ETH</strong></li>
                          <li className="mb-2">depositor <FwaAddress address={topListing.depositor} size="sm" /></li>
                          {crownHeldS !== null && (
                            <li className="mb-2" title="V2 crown commitment: withdrawing or shrinking the crown within 12h of taking it costs 1% of its full backing; being pulled, out-bid or oracle-kicked is free">
                              held {fmtAge(crownHeldS)}
                              {crownLockLeftS > 0
                                ? <span className="text-warning"> · early exit costs 1% for {fmtAge(crownLockLeftS)} more</span>
                                : <span className="text-success"> · commitment served, free to leave</span>}
                            </li>
                          )}
                          <li className="mb-2">token{' '}
                            <a href={ETHERSCAN + '/nft/' + topListing.collection + '/' + topListing.tokenId.toString()} target="_blank" rel="noopener noreferrer">
                              {shortAddr(topListing.collection)} #{topListing.tokenId.toString()}
                            </a>
                          </li>
                          {seizeBar !== null && (
                            <li className="text-muted">
                              the crown tithes {(Number(fwa.topListingShareBps) / 100)}% of every pull · seize it with ≥ {fmtEth(seizeBar, 2)} ETH backing
                            </li>
                          )}
                        </ul>
                      )}
                    </div>
                  </div>
                ) : <p className="text-muted">top spot vacant — the next deposit (or claimTopSpot) takes it</p>}
              </div>
            </div>
          </div>
          <div className="col-md-6 grid-margin stretch-card">
            <div className="card">
              <div className="card-body">
                <h4 className="card-title"><i className="mdi mdi-shield-check text-success"></i> Protocol Health</h4>
                <ul className="list-unstyled mb-0 small">
                  {IS_V2 ? (
                    <li className="d-flex justify-content-between py-2 border-bottom" title="V2 refuses NEW purchases daily 11:45–12:00 and 23:45–00:00 UTC (fixed in the contract). Settlement, exits and callbacks keep running; over-ceiling listings can be kicked only inside these windows.">
                      <span className="text-muted">Purchase window</span>
                      {blackout.active
                        ? <span className="badge badge-outline-warning">PAUSED · {fmtAge(blackout.secondsToChange)} left</span>
                        : <span className="badge badge-outline-success">open · next pause in {fmtAge(blackout.secondsToChange)}</span>}
                    </li>
                  ) : (
                    <li className="d-flex justify-content-between py-2 border-bottom">
                      <span className="text-muted">Tree invariant</span>
                      {invariantOk === null ? '—' : invariantOk
                        ? <span className="badge badge-outline-success">OK</span>
                        : <span className="badge badge-outline-danger">BROKEN</span>}
                    </li>
                  )}
                  <li className="d-flex justify-content-between py-2 border-bottom">
                    <span className="text-muted">Unsettled acquisitions</span><span>{fwa ? fmtNum(fwa.unsettledAcquisitionCount) : '—'}</span>
                  </li>
                  <li className="d-flex justify-content-between py-2 border-bottom">
                    <span className="text-muted">Unfulfilled VRF</span><span>{fwa ? fmtNum(fwa.unfulfilledVrfCount) : '—'}</span>
                  </li>
                  <li className="d-flex justify-content-between py-2 border-bottom">
                    <span className="text-muted">Accrued owner fees</span><span>{fwa ? fmtEth(fwa.accruedOwnerFees) + ' ETH' : '—'}</span>
                  </li>
                  <li className="d-flex justify-content-between py-2 border-bottom">
                    <span className="text-muted">Pull EV (harmonic avg backing)</span>
                    <span>{ev !== null ? fmtEth(ev) + ' ETH' : '—'}</span>
                  </li>
                  <li className="d-flex justify-content-between py-2">
                    <span className="text-muted">Fee income / listing (24h)</span>
                    <span>{perListing24h !== null ? perListing24h.toFixed(5) + ' ETH' : '—'}</span>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>

        {/* rules of the game + allowed collections */}
        <div className="row">
          <div className="col-lg-7 grid-margin stretch-card">
            <div className="card">
              <div className="card-body">
                <h4 className="card-title"><i className="mdi mdi-tune text-info"></i> Rules of the Game</h4>
                <p className="text-muted small mb-3">the owner-tunable knobs, read live from the contract</p>
                <div className="row small">
                  <div className="col-sm-6">
                    <ul className="list-unstyled mb-0">
                      <li className="d-flex justify-content-between py-1" title="pulls cost the pool's expected value (harmonic mean of backings) plus this surcharge — the markup splits dynamically between depositor fees and the puller's FWA allowance">
                        <span className="text-muted">pull fee</span>
                        <span>EV {surchargePct !== null ? '+ ' + surchargePct + '%' : ''}</span>
                      </li>
                      <li className="d-flex justify-content-between py-1" title="the protocol's share of every pull fee">
                        <span className="text-muted">owner cut of pulls</span>
                        <span>{fwa ? (Number(fwa.ownerAcquisitionFeeBps) / 100) + '%' : '—'}</span>
                      </li>
                      <li className="d-flex justify-content-between py-1" title="what a winner receives in ETH accepting the depositor's standing bid instead of keeping the NFT — read at settlement time, not locked at allocation">
                        <span className="text-muted">ETH sell-back payout</span>
                        <span>{fwa ? (Number(fwa.settlementDiscountBps) / 100) + '% of backing' : '—'}</span>
                      </li>
                      {IS_V2 && (
                        <li className="d-flex justify-content-between py-1" title="V2: taking the bid as FWA spends this share of the backing buying FWA on the shared market — separate from the ETH rate, adjustable 80–95%">
                          <span className="text-muted">FWA sell-back budget</span>
                          <span>{fwa ? (Number(fwa.tokenSettlementDiscountBps) / 100) + '% of backing' : '—'}</span>
                        </li>
                      )}
                      <li className="d-flex justify-content-between py-1" title="the protocol's slice of the backing when a winner keeps (or relists) the NFT and the backing returns to the depositor — FWAIR launch listings pay none">
                        <span className="text-muted">owner cut of kept NFTs</span>
                        <span>{fwa ? (Number(fwa.ownerSettlementFeeBps) / 100) + '%' : '—'}</span>
                      </li>
                      <li className="d-flex justify-content-between py-1" title="the unpaid remainder of the backing on a sell-back — ON means the protocol keeps it, OFF returns it to depositors">
                        <span className="text-muted">retained slice goes to</span>
                        <span>{fwa ? (fwa.retainedToProtocol !== 0n ? 'protocol' : 'depositor') : '—'}</span>
                      </li>
                      <li className="d-flex justify-content-between py-1" title="floor ETH commitment per deposited NFT">
                        <span className="text-muted">min deposit backing</span>
                        <span>{fmtEth(knobs.minBacking)} ETH</span>
                      </li>
                      {IS_V2 && (
                        <li className="d-flex justify-content-between py-1" title="V2: backing may not exceed the collection's oracle ask plus this premium (ask +10% → a 1 ETH floor allows 1.1 ETH). Listings later found above the ceiling can be kicked during a purchase pause. Oracle-exempt collections and FWAIR launch listings skip it.">
                          <span className="text-muted">max backing (oracle ceiling)</span>
                          <span>{fwa ? 'ask +' + (Number(fwa.oracleCeilingPremiumBps) / 100) + '%' : '—'}</span>
                        </li>
                      )}
                      <li className="d-flex justify-content-between py-1" title="fee drift tolerance between a pull request and its settlement — drift beyond it converts the pull into a refund credit">
                        <span className="text-muted">settlement slippage</span>
                        <span>{fwa ? '±' + (Number(fwa.selectionSlippageBps) / 100) + '%' : '—'}</span>
                      </li>
                    </ul>
                  </div>
                  <div className="col-sm-6">
                    <ul className="list-unstyled mb-0">
                      <li className="d-flex justify-content-between py-1" title="the crown tithe: share of every pull fee that accrues to the top-backed listing's pot">
                        <span className="text-muted">crown tithe (share of pulls)</span>
                        <span>{fwa ? (Number(fwa.topListingShareBps) / 100) + '%' : '—'}</span>
                      </li>
                      <li className="d-flex justify-content-between py-1" title="a challenger must exceed the crown's backing by this much to seize it">
                        <span className="text-muted">crown takeover threshold</span>
                        <span>{fwa ? '+' + (Number(fwa.topThresholdBps) / 100) + '%' : '—'}</span>
                      </li>
                      <li className="d-flex justify-content-between py-1" title="the winner's exclusive period to keep the NFT or take the sell-back before the depositor can reclaim">
                        <span className="text-muted">winner's exclusive window</span>
                        <span>{fwa ? fmtWindow(Number(fwa.settlementWindow)) : '—'}</span>
                      </li>
                      <li className="d-flex justify-content-between py-1" title="after this, anyone may finalize an abandoned position (NFT to the winner, backing less fee to the depositor)">
                        <span className="text-muted">hard finalize deadline</span>
                        <span>{fwa ? fmtWindow(Number(fwa.finalizeWindow)) : '—'}</span>
                      </li>
                      {IS_V2 && (
                        <React.Fragment>
                          <li className="d-flex justify-content-between py-1" title="V2: an oracle quote older than this is rejected for deposits/repricing; quotes from a challenge shorter than the minimum period are rejected too">
                            <span className="text-muted">oracle quote max age / min challenge</span>
                            <span>{fwa ? fmtWindow(Number(fwa.maxOracleAge)) + ' / ' + fmtWindow(Number(fwa.minOracleChallengePeriod)) : '—'}</span>
                          </li>
                          <li className="d-flex justify-content-between py-1" title="fixed in the contract (FWAV2CrownPolicy): leaving or shrinking the crown within 12h of taking it costs 1% of its full backing">
                            <span className="text-muted">crown commitment</span>
                            <span>12h · 1% early exit</span>
                          </li>
                          <li className="d-flex justify-content-between py-1" title="fixed in the contract: no new purchases in these two daily windows; everything else keeps working and over-ceiling listings can be kicked">
                            <span className="text-muted">purchase pauses (UTC)</span>
                            <span>11:45–12:00 · 23:45–00:00</span>
                          </li>
                        </React.Fragment>
                      )}
                      <li className="d-flex justify-content-between py-1" title="blocks the VRF randomness has to land before a pull request can expire into a refund">
                        <span className="text-muted">selection timeout</span>
                        <span>{fwa ? Number(fwa.selectionTimeoutBlocks) + ' blocks' : '—'}</span>
                      </li>
                      <li className="d-flex justify-content-between py-1" title="batch pulls per transaction cap">
                        <span className="text-muted">max pulls per tx</span>
                        <span>{knobs.maxPullsPerTx.toString()}</span>
                      </li>
                      <li className="d-flex justify-content-between py-1">
                        <span className="text-muted">owner / payout</span>
                        <span>
                          {fwa ? <React.Fragment><FwaAddress address={fwa.owner} size="xs" /> · <FwaAddress address={fwa.payoutAddress} size="xs" /></React.Fragment> : '—'}
                        </span>
                      </li>
                    </ul>
                  </div>
                </div>
                <div className="mt-2 mb-3">
                  <span className={'badge mr-2 badge-outline-' + (knobs.pullsEnabled ? 'success' : 'danger')}>pulls {knobs.pullsEnabled ? 'ON' : 'OFF'}</span>
                  <span className={'badge mr-2 badge-outline-' + (knobs.withdrawOnly ? 'danger' : 'success')}>{knobs.withdrawOnly ? 'WITHDRAW-ONLY' : 'deposits open'}</span>
                  <span className={'badge mr-2 badge-outline-' + (knobs.whitelistEnabled ? 'warning' : 'secondary')}>whitelist {knobs.whitelistEnabled ? 'ON' : 'OFF'}</span>
                  <span className={'badge badge-outline-' + (knobs.sellBackAsTokens ? 'success' : 'secondary')}>FWA-token sell-back {knobs.sellBackAsTokens ? 'ON' : 'OFF'}</span>
                </div>
                <p className="text-muted small mb-1">rule changes — last 7d</p>
                {adminFeed.length === 0
                  ? <p className="text-muted small mb-0">none seen</p>
                  : (
                    <ul className="list-unstyled mb-0 small">
                      {adminFeed.map((row) => (
                        <li key={row.key} className="py-1">
                          <a href={ETHERSCAN + '/tx/' + row.tx} target="_blank" rel="noopener noreferrer" className="text-muted mr-2">
                            {fmtAge(row.ageS)} ago
                          </a>
                          <span className={'badge badge-outline-' + row.badge + ' mr-2'}>{row.name}</span>
                          {row.parts.map((p, i) => (typeof p === 'string'
                            ? <span key={i}>{p}</span>
                            : <FwaAddress key={i} address={p.addr} size="xs" />))}
                        </li>
                      ))}
                    </ul>
                  )}
              </div>
            </div>
          </div>
          <div className="col-lg-5 grid-margin stretch-card">
            <div className="card">
              <div className="card-body">
                <h4 className="card-title"><i className="mdi mdi-playlist-check text-success"></i> Allowed Collections</h4>
                <p className="text-muted small mb-2">
                  {whitelist.length} collections can be deposited
                  {knobs.whitelistEnabled ? '' : ' (whitelist currently OFF — anything goes)'}
                </p>
                <div className="wl-scroll">
                  <ul className="list-unstyled mb-0 small">
                    {whitelist.map(([addr, name]) => (
                      <li key={addr} className="py-1 border-bottom d-flex justify-content-between">
                        <span>
                          <a href={abiNinjaUrl(addr)} target="_blank" rel="noopener noreferrer">{name}</a>
                          {exemptSet.has(addr.toLowerCase()) && <span className="badge badge-outline-info ml-2" title="oracle-exempt: no floor quote needed, no ceiling, never drift-kicked — fees and min backing still apply">no ceiling</span>}
                        </span>
                        <span className="text-muted">{shortAddr(addr)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                {IS_V2 && (
                  <p className="text-muted small mb-0 mt-2">
                    V2 also needs a valid floor-oracle quote per collection: backing ≤ ask {fwa ? '+' + (Number(fwa.oracleCeilingPremiumBps) / 100) + '%' : ''} — the deposit panel shows each collection's ceiling. Being listed here doesn't mean a quote exists.
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* token emission + contracts & keys */}
        <div className="row">
          <div className="col-lg-7 grid-margin stretch-card">
            <div className="card">
              <div className="card-body">
                {IS_V2 && (
                  <React.Fragment>
                    <h4 className="card-title"><i className="mdi mdi-fire text-danger"></i> FWA Rewards</h4>
                    {rewardsV2 && rewardsV2.start ? (
                      <React.Fragment>
                        <p className="text-muted small mb-2">
                          no fixed emission in V2 — FWA lands whenever the token's buyback route fires, then splits: depositors by √backing, pullers per 24h epoch
                        </p>
                        <ul className="list-unstyled mb-0 small">
                          <li className="d-flex justify-content-between py-1" title="epochs are 24h from the moment purchases were first enabled, not UTC days; pausing purchases doesn't pause them">
                            <span className="text-muted">epoch</span>
                            <span>#{rewardsV2.epoch} · started {new Date(rewardsV2.start * 1000).toLocaleString()}{epochEndsS ? ' · rolls in ' + fmtAge(Math.max(0, epochEndsS - nowS)) : ''}</span>
                          </li>
                          <li className="d-flex justify-content-between py-1" title="every successful pull in the epoch earns one equal share of its pot; refunded pulls earn nothing; claim once the epoch closes and every pull in it has resolved">
                            <span className="text-muted">this epoch's puller pot</span>
                            <span>{fmtNum(Math.round(Number(rewardsV2.pot) / 1e18))} FWA / {fmtNum(rewardsV2.pulls)} pulls{fwaPerPull !== null ? ' → ≈ ' + fmtNum(Math.round(fwaPerPull)) + ' FWA per pull' : ''}{rewardsV2.pending > 0n ? ' · ' + fmtNum(rewardsV2.pending) + ' pending' : ''}</span>
                          </li>
                          {rewardsV2.prev && (
                            <li className="d-flex justify-content-between py-1">
                              <span className="text-muted">last epoch</span>
                              <span>{fmtNum(Math.round(Number(rewardsV2.prev.pot) / 1e18))} FWA / {fmtNum(rewardsV2.prev.pulls)} pulls{prevFwaPerPull !== null ? ' → ≈ ' + fmtNum(Math.round(prevFwaPerPull)) + ' FWA per pull' : ''}</span>
                            </li>
                          )}
                          <li className="d-flex justify-content-between py-1" title="depositor FWA is split by the square root of each active listing's backing — a 4 ETH listing weighs twice a 1 ETH one (ETH fees, by contrast, split equally)">
                            <span className="text-muted">depositor weight pool (Σ√backing)</span>
                            <span>{fmtNum(Math.round(Number(rewardsV2.sqrtBackingTotal) / 1e9))} · claim via YOUR DEPOSITS</span>
                          </li>
                          <li className="d-flex justify-content-between py-1" title="FWA sitting in the rewards module: unclaimed depositor accruals + open epoch pots">
                            <span className="text-muted">FWA held for rewards</span>
                            <span>{fmtNum(Math.round(Number(rewardsV2.moduleBalance) / 1e18))} FWA</span>
                          </li>
                          <li className="d-flex justify-content-between py-1" title="part of every pull's surcharge is reserved as an ETH budget the puller (or the app that routed the pull) spends buying FWA — claimAccruedTokens on the rewards module">
                            <span className="text-muted">ETH queued for FWA buys</span>
                            <span>{fmtEth(rewardsV2.allowance)} ETH</span>
                          </li>
                          <li className="d-flex justify-content-between py-1" title="apps that route pulls through their own contract earn this share of the protocol's cut as an FWA-buy allowance — no cost to the puller or depositor">
                            <span className="text-muted">builder share of protocol fees</span>
                            <span>{Number(rewardsV2.builderRewardBps) / 100}%</span>
                          </li>
                          {rewardsV2.buyback && (
                            <li className="d-flex justify-content-between py-1" title="main-pool protocol fees flow to FWAV2Buyback; anyone can call buyback() to swap the ETH for FWA, which is routed depositors / pullers / burn — the caller keeps a tip">
                              <span className="text-muted">protocol-fee buyback</span>
                              <span>
                                {fmtEth(rewardsV2.buyback.balance)} ETH waiting · ≤{fmtEth(rewardsV2.buyback.maxEthPerBuy, 1)} ETH/call · split {Number(rewardsV2.buyback.depositorBps) / 100}/{Number(rewardsV2.buyback.purchaserBps) / 100}/{Number(rewardsV2.buyback.burnBps) / 100}% · tip {Number(rewardsV2.buyback.callerRewardBps) / 100}%
                                {rewardsV2.buyback.paused ? <span className="text-danger"> · PAUSED</span> : ''}
                              </span>
                            </li>
                          )}
                        </ul>
                        <p className="text-muted small mb-0 mt-2">
                          depositors: claim FWA from YOUR DEPOSITS · pullers: claimEpochTokens once an epoch closes · <a href="https://www.fwa.fun/docs/fwa-rewards" target="_blank" rel="noopener noreferrer">docs</a>
                        </p>
                      </React.Fragment>
                    ) : <p className="text-muted">rewards module unreachable (or epochs not started)</p>}
                  </React.Fragment>
                )}
                {!IS_V2 && <h4 className="card-title"><i className="mdi mdi-fire text-danger"></i> FWA Token Emission</h4>}
                {!IS_V2 && (emission && emission.start ? (
                  <React.Fragment>
                    <div className="d-flex justify-content-between small mb-1">
                      <span className="text-muted">
                        started {new Date(emission.start * 1000).toLocaleDateString()}
                      </span>
                      <span className={emLeftS === 0 ? 'text-muted' : emLeftS < 3 * 86400 ? 'text-danger' : 'text-warning'}>
                        {emLeftS === 0
                          ? 'emission ended ' + new Date(emEnd * 1000).toLocaleDateString()
                          : <strong>ends in {fmtDh(emLeftS)} — {new Date(emEnd * 1000).toLocaleString()}</strong>}
                      </span>
                    </div>
                    <div className="progress pull-progress mb-3" style={{ height: 8, maxWidth: 'none' }}>
                      <div className={'progress-bar ' + (emLeftS < 3 * 86400 ? 'bg-danger' : 'bg-warning')} style={{ width: emPct + '%' }}></div>
                    </div>
                    <ul className="list-unstyled mb-0 small">
                      <li className="d-flex justify-content-between py-1">
                        <span className="text-muted">depositor emissions</span>
                        <span>{fmtNum(Math.round(Number(emission.ratePerSec) / 1e18 * 86400))} FWA / day — weighted by √backing</span>
                      </li>
                      <li className="d-flex justify-content-between py-1">
                        <span className="text-muted">puller rewards pot</span>
                        <span>{fmtNum(Math.round(Number(emission.dailyPot) / 1e18))} FWA / day — split across the day's pulls</span>
                      </li>
                      <li className="d-flex justify-content-between py-1">
                        <span className="text-muted">token supply</span>
                        <span>{fmtNum(Math.round(Number(emission.supply) / 1e18))} FWA</span>
                      </li>
                      <li className="d-flex justify-content-between py-1" title="whether external addresses may buy FWA on the pool yet — sells are always open">
                        <span className="text-muted">external FWA buys</span>
                        <span>{emission.buysOpen ? <span className="text-success">open</span> : <span className="text-warning">gated — sells only</span>}</span>
                      </li>
                      <li className="d-flex justify-content-between py-1" title="ETH waiting to be swapped into FWA buybacks (split between depositors, purchasers and burn)">
                        <span className="text-muted">ETH queued for buybacks</span>
                        <span>{fmtEth(emission.buybackPool)} ETH</span>
                      </li>
                    </ul>
                    <p className="text-muted small mb-0 mt-2">
                      while emission runs, depositing and pulling both earn FWA on top of the ETH game
                    </p>
                  </React.Fragment>
                ) : <p className="text-muted">emission not started (or rewards module unreachable)</p>)}
              </div>
            </div>
          </div>
          <div className="col-lg-5 grid-margin stretch-card">
            <div className="card">
              <div className="card-body">
                <h4 className="card-title"><i className="mdi mdi-key-variant text-warning"></i> Contracts &amp; Keys</h4>
                <ul className="list-unstyled mb-0 small">
                  <li className="d-flex justify-content-between py-1 border-bottom">
                    <span className="text-muted">owner</span>
                    <span>{fwa ? <FwaAddress address={fwa.owner} size="xs" /> : '—'}</span>
                  </li>
                  <li className="d-flex justify-content-between py-1 border-bottom">
                    <span className="text-muted">fee payout</span>
                    <span>{fwa ? <FwaAddress address={fwa.payoutAddress} size="xs" /> : '—'}</span>
                  </li>
                  <li className="d-flex justify-content-between py-1 border-bottom">
                    <span className="text-muted">whitelist manager</span>
                    <span>{knobs.whitelistManager && !/^0x0{40}$/.test(knobs.whitelistManager)
                      ? <FwaAddress address={knobs.whitelistManager} size="xs" /> : 'revoked'}</span>
                  </li>
                  <li className="d-flex justify-content-between py-1 border-bottom">
                    <span className="text-muted">FWA pool</span>
                    <a href={abiNinjaUrl(FWA_ADDRESS, ['quoteAcquisitionPrice', 'acquire_0', 'listings', 'listNFT'])} target="_blank" rel="noopener noreferrer">{shortAddr(FWA_ADDRESS)}</a>
                  </li>
                  <li className="d-flex justify-content-between py-1 border-bottom">
                    <span className="text-muted">FWA token</span>
                    {fwa ? <a href={abiNinjaUrl(fwa.token, ['balanceOf', 'totalSupply'])} target="_blank" rel="noopener noreferrer">{shortAddr(fwa.token)}</a> : '—'}
                  </li>
                  <li className="d-flex justify-content-between py-1 border-bottom">
                    <span className="text-muted">rewards module</span>
                    {fwa ? <a href={abiNinjaUrl(fwa.rewards, IS_V2 ? ['currentEpoch', 'pendingDepositorTokens', 'tokenCredit', 'tokenBuyAllowance'] : ['emissionStart', 'pendingDepositorTokens', 'tokenCredit'])} target="_blank" rel="noopener noreferrer">{shortAddr(fwa.rewards)}</a> : '—'}
                  </li>
                  {IS_V2 ? (
                    <React.Fragment>
                      <li className="d-flex justify-content-between py-1 border-bottom" title="CollectionFloorOracle — anyone can propose a collection floor by escrowing an NFT at an ask + ETH for a bid at 90% of it; if nobody takes either side for the challenge period, the quote is recorded and caps that collection's backing">
                        <span className="text-muted">floor oracle</span>
                        {fwa ? <a href={abiNinjaUrl(fwa.floorOracle, ['getFloorRange', 'getChallenge', 'challengePeriod'])} target="_blank" rel="noopener noreferrer">{shortAddr(fwa.floorOracle)}</a> : '—'}
                      </li>
                      <li className="d-flex justify-content-between py-1 border-bottom">
                        <span className="text-muted">fee buyback</span>
                        <a href={abiNinjaUrl(rewardsV2 && rewardsV2.buyback ? rewardsV2.buyback.address : POOL.contracts.buyback, ['buyback', 'maxEthPerBuy', 'lastBuybackBlock'])} target="_blank" rel="noopener noreferrer">{shortAddr(rewardsV2 && rewardsV2.buyback ? rewardsV2.buyback.address : POOL.contracts.buyback)}</a>
                      </li>
                      <li className="d-flex justify-content-between py-1 border-bottom">
                        <span className="text-muted">VRF service</span>
                        <a href={abiNinjaUrl(POOL.contracts.vrfService, ['requestFee', 'subscriptionNativeBalance'])} target="_blank" rel="noopener noreferrer">{shortAddr(POOL.contracts.vrfService)}</a>
                      </li>
                      <li className="d-flex justify-content-between py-1 border-bottom" title="FWAIR launch registry — recognised launch listings skip the oracle ceiling and the kept-NFT fee">
                        <span className="text-muted">FWAIR launch manager</span>
                        {fwa && !ZERO_ADDR.test(fwa.fwairLaunchRegistry) ? <a href={abiNinjaUrl(fwa.fwairLaunchRegistry)} target="_blank" rel="noopener noreferrer">{shortAddr(fwa.fwairLaunchRegistry)}</a> : 'disabled'}
                      </li>
                      <li className="d-flex justify-content-between py-1" title="collections implementing IFWAPurchaseCallback get told (via this notifier) when one of their tokens settles">
                        <span className="text-muted">purchase notifier</span>
                        <a href={abiNinjaUrl(POOL.contracts.purchaseNotifier)} target="_blank" rel="noopener noreferrer">{shortAddr(POOL.contracts.purchaseNotifier)}</a>
                      </li>
                    </React.Fragment>
                  ) : (
                    <li className="d-flex justify-content-between py-1">
                      <span className="text-muted">VRF service</span>
                      {fwa ? <a href={abiNinjaUrl(fwa.vrfService)} target="_blank" rel="noopener noreferrer">{shortAddr(fwa.vrfService)}</a> : '—'}
                    </li>
                  )}
                </ul>
                <p className="text-muted small mb-0 mt-2">
                  one EOA owner — no timelock or multisig; every knob on this page is theirs to turn ·{' '}
                  <a href={POOL.docs} target="_blank" rel="noopener noreferrer">official {POOL.label} docs</a>
                  {' · '}<a href={poolUrl(OTHER_POOL.id)}>watch {OTHER_POOL.label} instead</a>
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* where the fees go: FWA burn + punks */}
        <div className="row">
          <div className="col-lg-5 grid-margin stretch-card">
            <div className="card">
              <div className="card-body">
                <h4 className="card-title"><i className="mdi mdi-fire text-danger"></i> FWA Burn</h4>
                <p className="text-muted small mb-2">every buyback burns a slice — all burns are FWA transfers to 0x0, counted here from the token itself (shared by both pools)</p>
                {burn ? (
                  <React.Fragment>
                    <h3 className="mb-0">{fwaM(burn.day)} <small className="text-muted">FWA burned / 24h</small></h3>
                    <p className="text-muted small mb-3">{fmtNum(burn.dayCount)} burns · {burnPct(burn.day, burn.supply)} of supply per day at this pace</p>
                    <ul className="list-unstyled mb-0 small">
                      <li className="d-flex justify-content-between py-1">
                        <span className="text-muted">last {burn.weekDays}d</span>
                        <span>{fwaM(burn.week)} FWA · avg {fwaM(burn.week / BigInt(burn.weekDays))} / day</span>
                      </li>
                      <li className="d-flex justify-content-between py-1">
                        <span className="text-muted">total supply now</span>
                        <span>{fwaM(burn.supply)} FWA</span>
                      </li>
                      <li className="d-flex justify-content-between py-1" title="1,000,000,000 FWA were minted at deploy; nothing mints again, so supply only falls">
                        <span className="text-muted">burned to date</span>
                        <span>{fwaM(burn.burnedToDate)} FWA · {burnPct(burn.burnedToDate, INITIAL_FWA_SUPPLY)} of the 1B minted</span>
                      </li>
                      {Object.entries(burn.bySource).sort((a, b) => (b[1] > a[1] ? 1 : -1)).map(([a, v]) => (
                        <li key={a} className="d-flex justify-content-between py-1">
                          <span className="text-muted">{burn.weekDays}d via {burnSourceName(a)}</span>
                          <span>{fwaM(v)} FWA</span>
                        </li>
                      ))}
                    </ul>
                  </React.Fragment>
                ) : <p className="text-muted">scanning burns…</p>}
              </div>
            </div>
          </div>
          <div className="col-lg-7 grid-margin stretch-card">
            <div className="card">
              <div className="card-body">
                <h4 className="card-title"><i className="mdi mdi-emoticon-cool-outline text-info"></i> Punks</h4>
                <p className="text-muted small mb-2">
                  CryptoPunks in the {POOL.label} pool{IS_V2 ? ', and the Punk lister — a protocol strategy that buys punks with 20% of FWA trading fees (plus its own listing earnings) and lists them in the pool' : ''}
                </p>
                {sinks ? (
                  <React.Fragment>
                    <h3 className="mb-0">{sinks.punks.inPool === null ? '—' : fmtNum(sinks.punks.inPool)} <small className="text-muted">punks in the pool</small></h3>
                    <p className="text-muted small mb-3">held by the pool contract right now — active, staged and won-but-unsettled</p>
                    {lister ? (
                      <ul className="list-unstyled mb-0 small">
                        <li className="d-flex justify-content-between py-1" title="purchaseAndList(punkId): the lister buys a punk on the CryptoPunks market and lists it — only when public market purchases are switched on">
                          <span className="text-muted">punks bought on the market</span>
                          <span>{fmtNum(lister.bought)}{lister.bought ? ' · ' + fmtEth(lister.boughtEth, 2) + ' ETH' : ''} · market buys {lister.marketBuysEnabled ? <span className="text-success">ON</span> : <span className="text-warning">OFF</span>}</span>
                        </li>
                        <li className="d-flex justify-content-between py-1" title="wrapped punks handed to the lister by the owner and listed with its capital as backing">
                          <span className="text-muted">punks deposited by the owner</span>
                          <span>{fmtNum(lister.deposited)}{lister.deposited ? ' · ' + fmtEth(lister.depositedBacking, 2) + ' ETH backing' : ''}</span>
                        </li>
                        <li className="d-flex justify-content-between py-1">
                          <span className="text-muted">positions</span>
                          <span>{lister.positions === null ? '—' : fmtNum(lister.positions)} opened · {fmtNum(lister.listed)} listed · {fmtNum(lister.exited)} exited</span>
                        </li>
                        <li className="d-flex justify-content-between py-1" title="ETH the lister can spend on the next punk (spendable) vs. what sits behind its live listings (locked); purchase capacity caps one buy">
                          <span className="text-muted">capital</span>
                          <span>{fmtEth(lister.spendable, 2)} ETH spendable · {fmtEth(lister.locked, 2)} ETH locked · ≤{fmtEth(lister.capacity, 2)} ETH per buy{lister.paused ? <span className="text-danger"> · PAUSED</span> : ''}</span>
                        </li>
                        {lister.decayIntervalS && (
                          <li className="d-flex justify-content-between py-1" title="the lister walks each punk's backing down on a schedule so it eventually gets pulled; reduceBacking() is public">
                            <span className="text-muted">backing decay</span>
                            <span>−{fmtEth(lister.decayAmount, 2)} ETH every {fmtAge(lister.decayIntervalS)} toward a {fmtEth(lister.minBacking, 2)} ETH floor · {fmtNum(lister.reductions)} cuts so far</span>
                          </li>
                        )}
                        {Object.keys(lister.inflow).length > 0 && (
                          <li className="d-flex justify-content-between py-1" title="CapitalLocked events: who has funded the lister since launch">
                            <span className="text-muted">funded by</span>
                            <span>
                              {Object.entries(lister.inflow).sort((a, b) => (b[1] > a[1] ? 1 : -1)).map(([a, v], i) => (
                                <span key={a}>{i ? ' · ' : ''}{a === FWA_ADDRESS.toLowerCase() ? 'pool earnings' : a === (fwa ? fwa.owner.toLowerCase() : '') ? 'owner' : <FwaAddress address={a} size="xs" />} {fmtEth(v, 2)}</span>
                              ))}
                              {' ETH'}
                            </span>
                          </li>
                        )}
                        <li className="py-1 text-muted">
                          <a href={abiNinjaUrl(PUNK_LISTER, ['positions', 'spendableCapital', 'purchaseCapacity'])} target="_blank" rel="noopener noreferrer">Punk lister contract</a>
                          {' · '}<a href="https://www.fwa.fun/punks" target="_blank" rel="noopener noreferrer">fwa.fun/punks</a>
                        </li>
                      </ul>
                    ) : (IS_V2 ? <p className="text-muted small mb-0">lister unreachable</p> : <p className="text-muted small mb-0">the Punk lister strategy only runs on V2 — <a href={poolUrl('v2')}>switch</a></p>)}
                  </React.Fragment>
                ) : <p className="text-muted">counting punks…</p>}
              </div>
            </div>
          </div>
        </div>

        {/* activity feed */}
        <div className="row" id="recent-activity">
          <div className="col-12 grid-margin stretch-card">
            <div className="card">
              <div className="card-body">
                <h4 className="card-title">Recent Activity</h4>
                <div className="table-responsive">
                  <table className="table table-hover">
                    <thead>
                      <tr>
                        <th>Block</th>
                        <th>Event</th>
                        <th>Detail</th>
                        <th>Tx</th>
                      </tr>
                    </thead>
                    <tbody>
                      {feed.length === 0 && (
                        <tr><td colSpan="4" className="text-muted">loading…</td></tr>
                      )}
                      {feed.map((row) => (
                        <tr key={row.key}>
                          <td className="text-muted">{fmtNum(row.block)}</td>
                          <td><span className={'badge badge-outline-' + row.badge}>{row.name}</span></td>
                          <td>
                            {row.parts.map((p, i) => (typeof p === 'string'
                              ? <span key={i}>{p}</span>
                              : <FwaAddress key={i} address={p.addr} size="xs" />))}
                          </td>
                          <td>
                            <a href={ETHERSCAN + '/tx/' + row.tx} target="_blank" rel="noopener noreferrer">
                              <i className="mdi mdi-open-in-new"></i>
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
}

export default Dashboard;
