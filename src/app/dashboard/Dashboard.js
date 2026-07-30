import React, { Component } from 'react';
import { Bar, Doughnut } from 'react-chartjs-2';
import PullTicker from './PullTicker';
import HighValuePulls from './HighValuePulls';
import RecentDeposits from './RecentDeposits';
import NodeStatusBar from './NodeStatusBar';
import PullPanel from './PullPanel';
import MyDeposits from './MyDeposits';
import FwaAddress from '../fwa/FwaAddress';
import {
  FWA_ADDRESS, ETHERSCAN, SELECTORS, TOPICS,
  rpcBatch, ethCall, toBig, toNum, word, wordAddr,
  fmtEth, fmtNum, shortAddr, describeLog, POLL,
} from '../fwa/fwa';

const STATS_INTERVAL_MS = POLL.stats;
const LOGS_INTERVAL_MS = POLL.logs;
const DAY_BLOCKS = 7200; // ~24h of 12s blocks

const FEED_TOPICS = [
  TOPICS.AcquisitionRequested, TOPICS.NFTAllocated, TOPICS.NFTKept, TOPICS.NFTRelisted,
  TOPICS.DepositorBidAccepted, TOPICS.DepositorBidAcceptedAsTokens,
  TOPICS.AcquisitionExpired, TOPICS.AcquisitionRefundedNoListing, TOPICS.AcquisitionRefundedSlippage,
  TOPICS.NFTListed, TOPICS.ListingStaged, TOPICS.ListingWithdrawn, TOPICS.BackingUpdated,
  TOPICS.UnsettledFinalized, TOPICS.TopListingSet, TOPICS.TopListingSettled, TOPICS.FeesPaidOut,
];

const chartFont = '#6c7293';
const gridColor = 'rgba(255,255,255,0.06)';

export class Dashboard extends Component {
  state = {
    error: null,
    lastUpdated: null,
    node: null,
    fwa: null,
    topListing: null,
    hourly: null,
    outcomes: null,
    feed: [],
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
      ];
      const calls = keys.map((k) => ethCall(SELECTORS[k]));
      calls.push(['eth_getBalance', [FWA_ADDRESS, 'latest']]);

      const res = await rpcBatch(calls);
      const fwa = {};
      keys.forEach((k, i) => { fwa[k] = toBig(res[i]); });
      const balance = toBig(res[keys.length]);

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

      this.setState({
        error: null,
        lastUpdated: new Date(),
        fwa: { ...fwa, balance },
        topListing,
      });
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
    } catch (e) {
      this.setState({ error: String(e.message || e) });
    }
  }

  render() {
    const { fwa, topListing, hourly, outcomes, feed, error, lastUpdated } = this.state;

    const backlog = fwa ? Number(fwa.lastIssuedSequence - fwa.nextSequenceToProcess + 1n) : 0;
    const invariantOk = fwa ? fwa.totalWeight === fwa.treeRootWeight : null;
    const dayCount = hourly ? hourly.buckets.reduce((a, b) => a + b.count, 0) : null;
    const dayFees = hourly ? hourly.buckets.reduce((a, b) => a + b.fees, 0) : null;

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
        <PullPanel />
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
                <h4 className="card-title"><i className="mdi mdi-crown text-warning"></i> Top Listing</h4>
                {fwa && fwa.topListingId !== 0n ? (
                  <React.Fragment>
                    <h2 className="mb-1">#{fmtNum(fwa.topListingId)}</h2>
                    <p className="mb-3 text-muted">
                      pot <span className="text-warning">{fmtEth(fwa.topListingPot)} ETH</span>
                    </p>
                    {topListing && (
                      <ul className="list-unstyled mb-0 small">
                        <li className="mb-2">backing <strong>{fmtEth(topListing.value, 2)} ETH</strong></li>
                        <li className="mb-2">depositor <FwaAddress address={topListing.depositor} size="sm" /></li>
                        <li>token{' '}
                          <a href={ETHERSCAN + '/nft/' + topListing.collection + '/' + topListing.tokenId.toString()} target="_blank" rel="noopener noreferrer">
                            {shortAddr(topListing.collection)} #{topListing.tokenId.toString()}
                          </a>
                        </li>
                      </ul>
                    )}
                  </React.Fragment>
                ) : <p className="text-muted">top spot vacant</p>}
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
                  <li className="d-flex justify-content-between py-2">
                    <span className="text-muted">Avg backing (harmonic)</span>
                    <span>{fwa && fwa.totalWeight !== 0n ? fmtEth(fwa.weightedBackingTotal / fwa.totalWeight) + ' ETH' : '—'}</span>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>

        {/* activity feed */}
        <div className="row">
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
