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
  KNOB_SNAPSHOT, WHITELIST_SNAPSHOT,
  rpcBatch, ethCall, ethCallTo, toBig, toNum, word, wordAddr, topicNum,
  fmtEth, fmtNum, fmtAge, shortAddr, describeLog, openSeaUrl, abiNinjaUrl,
  fetchListingArt, POLL,
} from '../fwa/fwa';

const STATS_INTERVAL_MS = POLL.stats;
const LOGS_INTERVAL_MS = POLL.logs;
const DAY_BLOCKS = 7200; // ~24h of 12s blocks

const ADMIN_SCAN_BLOCKS = 50400; // ~7d
const ADMIN_CHUNK = 7200;



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
    emission: null,
    hourly: null,
    outcomes: null,
    feed: [],
    knobs: KNOB_SNAPSHOT,
    whitelist: WHITELIST_SNAPSHOT,
    adminFeed: [],
  };

  componentDidMount() {
    this.refreshStats();
    this.refreshLogs();
    this.statsTimer = setInterval(() => this.refreshStats(), STATS_INTERVAL_MS);
    this.logsTimer = setInterval(() => this.refreshLogs(), LOGS_INTERVAL_MS);
  }

  componentWillUnmount() {
    clearInterval(this.statsTimer);
    clearInterval(this.logsTimer);
  }

  async refreshStats() {
    try {
      const keys = [
        'activeListingCount', 'acquisitionFee', 'totalWeight', 'weightedBackingTotal',
        'pendingAcquisitionCount', 'unsettledAcquisitionCount', 'unfulfilledVrfCount',
        'lastIssuedSequence', 'nextSequenceToProcess', 'topListingId', 'topListingPot',
        'accruedOwnerFees', 'acquisitionEscrowTotal', 'acquisitionRefundCreditTotal',
        'nextListingId', 'treeRootWeight',
        // rules-of-the-game knobs with public getters — always live
        'settlementDiscountBps', 'settlementWindow', 'finalizeWindow',
        'ownerAcquisitionFeeBps', 'ownerSettlementFeeBps',
        'topListingShareBps', 'topThresholdBps', 'retainedToProtocol',
        'selectionSlippageBps', 'selectionTimeoutBlocks',
      ];
      const addrKeys = ['owner', 'payoutAddress', 'token', 'rewards', 'vrfService'];
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

      // FWAToken emission schedule from the rewards module (zero address = not wired)
      let emission = null;
      if (fwa.rewards && !/^0x0{40}$/.test(fwa.rewards)) {
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

  async refreshAdmin(latest) {
    const ranges = [];
    const start = Math.max(latest - ADMIN_SCAN_BLOCKS, 0);
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
    logs.forEach((log) => {
      if (log.topics[0] === TOPICS.ConfigSet) {
        const key = topicNum(log.topics[1]);
        const value = word(log.data, 0);
        if (key === 22) knobs.minBacking = value;
        else if (key === 41) knobs.pullsEnabled = value !== 0n;
        else if (key === 42) knobs.withdrawOnly = value !== 0n;
        else if (key === 43) knobs.whitelistEnabled = value !== 0n;
        else if (key === 44) knobs.sellBackAsTokens = value !== 0n;
        else if (key === 12) knobs.maxPullsPerTx = value;
        else if (key === 62) knobs.whitelistManager = wordAddr(log.data, 0);
      } else if (log.topics[0] === TOPICS.CollectionWhitelistSet) {
        const addr = wordAddr(log.topics[1], 0);
        if (word(log.data, 0) === 0n) wl.delete(addr);
        else if (!wl.has(addr)) wl.set(addr, shortAddr(addr));
      }
    });

    const adminFeed = logs.slice(-8).reverse().map((log) => ({
      key: log.transactionHash + log.logIndex,
      block: toNum(log.blockNumber),
      tx: log.transactionHash,
      ageS: (latest - toNum(log.blockNumber)) * 12,
      ...describeLog(log),
    }));

    this.setState({ knobs, whitelist: [...wl.entries()], adminFeed });
  }

  render() {
    const { fwa, topListing, topArt, emission, hourly, outcomes, feed, error, lastUpdated, knobs, whitelist, adminFeed } = this.state;

    // emission countdown (rendered fresh each stats poll — minute precision is plenty)
    const nowS = Date.now() / 1000;
    const emEnd = emission && emission.start ? emission.start + emission.duration : null;
    const emLeftS = emEnd !== null ? Math.max(0, emEnd - nowS) : null;
    const emPct = emission && emission.start && emEnd
      ? Math.min(100, Math.round((nowS - emission.start) / emission.duration * 100)) : null;
    const fmtDh = (s) => (s >= 86400 ? Math.floor(s / 86400) + 'd ' : '') + Math.floor((s % 86400) / 3600) + 'h';

    const backlog = fwa ? Number(fwa.lastIssuedSequence - fwa.nextSequenceToProcess + 1n) : 0;
    const invariantOk = fwa ? fwa.totalWeight === fwa.treeRootWeight : null;
    const dayCount = hourly ? hourly.buckets.reduce((a, b) => a + b.count, 0) : null;
    const dayFees = hourly ? hourly.buckets.reduce((a, b) => a + b.fees, 0) : null;

    // pull EV = harmonic-mean backing; the fee is EV + the owner's surcharge
    const ev = fwa && fwa.totalWeight !== 0n ? fwa.weightedBackingTotal / fwa.totalWeight : null;
    const surchargePct = ev && ev !== 0n ? Math.round(Number(fwa.acquisitionFee * 10000n / ev - 10000n) / 100) : null;
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
                <p className="text-muted mb-0 mt-3 small">{dayCount !== null ? fmtNum(dayCount) + ' acquisitions / 24h' : '…'}{dayFees !== null ? ' · ' + dayFees.toFixed(2) + ' ETH fees' : ''}</p>
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
                  <li className="d-flex justify-content-between py-2 border-bottom">
                    <span className="text-muted">Tree invariant</span>
                    {invariantOk === null ? '—' : invariantOk
                      ? <span className="badge badge-outline-success">OK</span>
                      : <span className="badge badge-outline-danger">BROKEN</span>}
                  </li>
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
                      <li className="d-flex justify-content-between py-1" title="what a winner receives accepting the depositor's standing bid instead of keeping the NFT">
                        <span className="text-muted">sell-back payout</span>
                        <span>{fwa ? (Number(fwa.settlementDiscountBps) / 100) + '% of backing' : '—'}</span>
                      </li>
                      <li className="d-flex justify-content-between py-1" title="the protocol's slice when a winner keeps the NFT and the backing returns to the depositor">
                        <span className="text-muted">owner cut of sell-backs</span>
                        <span>{fwa ? (Number(fwa.ownerSettlementFeeBps) / 100) + '%' : '—'}</span>
                      </li>
                      <li className="d-flex justify-content-between py-1" title="the unpaid remainder of the backing on a sell-back — ON means the protocol keeps it, OFF returns it to depositors">
                        <span className="text-muted">retained slice goes to</span>
                        <span>{fwa ? (fwa.retainedToProtocol !== 0n ? 'protocol' : 'depositor') : '—'}</span>
                      </li>
                      <li className="d-flex justify-content-between py-1" title="floor ETH commitment per deposited NFT — raised from 0.01 at launch">
                        <span className="text-muted">min deposit backing</span>
                        <span>{fmtEth(knobs.minBacking)} ETH</span>
                      </li>
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
                        <span>{fwa ? Number(fwa.settlementWindow) / 3600 + 'h' : '—'}</span>
                      </li>
                      <li className="d-flex justify-content-between py-1" title="after this, anyone may finalize an abandoned position">
                        <span className="text-muted">hard finalize deadline</span>
                        <span>{fwa ? Number(fwa.finalizeWindow) / 86400 + 'd' : '—'}</span>
                      </li>
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
                        <a href={abiNinjaUrl(addr)} target="_blank" rel="noopener noreferrer">{name}</a>
                        <span className="text-muted">{shortAddr(addr)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* token emission + contracts & keys */}
        <div className="row">
          <div className="col-lg-7 grid-margin stretch-card">
            <div className="card">
              <div className="card-body">
                <h4 className="card-title"><i className="mdi mdi-fire text-danger"></i> FWA Token Emission</h4>
                {emission && emission.start ? (
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
                ) : <p className="text-muted">emission not started (or rewards module unreachable)</p>}
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
                    {fwa ? <a href={abiNinjaUrl(fwa.rewards, ['emissionStart', 'pendingDepositorTokens', 'tokenCredit'])} target="_blank" rel="noopener noreferrer">{shortAddr(fwa.rewards)}</a> : '—'}
                  </li>
                  <li className="d-flex justify-content-between py-1">
                    <span className="text-muted">VRF service</span>
                    {fwa ? <a href={abiNinjaUrl(fwa.vrfService)} target="_blank" rel="noopener noreferrer">{shortAddr(fwa.vrfService)}</a> : '—'}
                  </li>
                </ul>
                <p className="text-muted small mb-0 mt-2">
                  one EOA owner — no timelock or multisig; every knob on this page is theirs to turn
                </p>
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
