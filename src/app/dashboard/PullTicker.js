import React, { Component } from 'react';
import {
  FWA_ADDRESS, ETHERSCAN, SELECTORS, TOPICS,
  rpcBatch, ethCall, toNum, word,
  fmtEth, fmtAge, topicAddr, topicNum,
  fetchListingArt, openSeaUrl, POLL,
} from '../fwa/fwa';
import FwaAddress from '../fwa/FwaAddress';

const POLL_MS = POLL.ticker; // incremental log poll
const SEED_BLOCKS = 400;   // ~80 min of history to fill the strip on load
const MAX_ITEMS = 60;      // three wrapped rows worth of tiles

const TICKER_TOPICS = [
  TOPICS.AcquisitionRequested, TOPICS.NFTAllocated,
  TOPICS.AcquisitionExpired, TOPICS.AcquisitionRefundedNoListing, TOPICS.AcquisitionRefundedSlippage,
  // settlement choices — they arrive after the win, so the incremental poll
  // catches them and paints the tile's outcome border
  TOPICS.NFTKept, TOPICS.NFTRelisted, TOPICS.DepositorBidAccepted, TOPICS.DepositorBidAcceptedAsTokens,
];

// listingId -> outcome, from the settlement events (kept = red, eth = green, fwa = pink)
const OUTCOME_LABEL = { kept: 'kept the NFT', eth: 'took the ETH', fwa: 'took FWA tokens' };

// Live strip of pool pulls: newest on the far left, sliding right as they age.
export class PullTicker extends Component {
  state = { items: [], pending: null, rollsPerHour: null, now: Date.now() };

  feeByRequest = {}; // requestId topic -> fee wei (from AcquisitionRequested)
  rollTimes = [];    // approx unix ms of recent rolls, for the per-hour rate
  lastBlock = 0;

  componentDidMount() {
    this.alive = true;
    this.seed();
    this.pollTimer = setInterval(() => this.poll(), POLL_MS);
    this.ageTimer = setInterval(() => this.setState({ now: Date.now() }), 1000);
  }

  componentWillUnmount() {
    this.alive = false;
    clearInterval(this.pollTimer);
    clearInterval(this.ageTimer);
  }

  async seed() {
    try {
      const [latestHex] = await rpcBatch([['eth_blockNumber', []]]);
      const latest = toNum(latestHex);
      const [logs, pendingHex] = await rpcBatch([
        ['eth_getLogs', [{
          address: FWA_ADDRESS,
          fromBlock: '0x' + Math.max(latest - SEED_BLOCKS, 0).toString(16),
          toBlock: '0x' + latest.toString(16),
          topics: [TICKER_TOPICS],
        }]],
        ethCall(SELECTORS.pendingAcquisitionCount),
      ]);
      this.lastBlock = latest;
      this.ingest(logs, latest, toNum(pendingHex));
    } catch (e) { /* leave the strip empty; the next poll retries */ }
  }

  async poll() {
    try {
      const [latestHex] = await rpcBatch([['eth_blockNumber', []]]);
      const latest = toNum(latestHex);
      if (latest <= this.lastBlock) return;
      const [logs, pendingHex] = await rpcBatch([
        ['eth_getLogs', [{
          address: FWA_ADDRESS,
          fromBlock: '0x' + (this.lastBlock + 1).toString(16),
          toBlock: '0x' + latest.toString(16),
          topics: [TICKER_TOPICS],
        }]],
        ethCall(SELECTORS.pendingAcquisitionCount),
      ]);
      this.lastBlock = latest;
      this.ingest(logs, latest, toNum(pendingHex));
    } catch (e) { /* transient RPC hiccup — retry on next tick */ }
  }

  ingest(logs, latest, pending) {
    if (!this.alive) return;
    const nowMs = Date.now();
    const fresh = [];
    const outcomes = {};

    logs.forEach((log) => {
      const bn = toNum(log.blockNumber);
      const tsMs = nowMs - (latest - bn) * 12000; // approx: 12s blocks
      const t = log.topics;
      switch (t[0]) {
        case TOPICS.NFTKept:
        case TOPICS.NFTRelisted: // relist = they took the NFT and re-deposited it
          outcomes[topicNum(t[1])] = 'kept';
          return;
        case TOPICS.DepositorBidAccepted:
          outcomes[topicNum(t[1])] = 'eth';
          return;
        case TOPICS.DepositorBidAcceptedAsTokens:
          outcomes[topicNum(t[1])] = 'fwa';
          return;
        case TOPICS.AcquisitionRequested:
          this.feeByRequest[t[1]] = word(log.data, 0);
          this.rollTimes.push(tsMs);
          return;
        case TOPICS.NFTAllocated:
          fresh.push({
            key: log.transactionHash + log.logIndex,
            kind: 'win',
            listingId: topicNum(t[2]),
            purchaser: topicAddr(t[3]),
            backing: word(log.data, 1),
            fee: this.feeByRequest[t[1]],
            tx: log.transactionHash,
            bn, tsMs,
          });
          return;
        case TOPICS.AcquisitionExpired:
        case TOPICS.AcquisitionRefundedNoListing:
        case TOPICS.AcquisitionRefundedSlippage:
          fresh.push({
            key: log.transactionHash + log.logIndex,
            kind: 'refund',
            purchaser: t[0] === TOPICS.AcquisitionExpired ? topicAddr(t[3]) : topicAddr(t[2]),
            backing: word(log.data, 0),
            tx: log.transactionHash,
            bn, tsMs,
          });
          return;
        default:
          return;
      }
    });

    // prune the roll-rate window and the fee join map
    const cutoff = nowMs - 3600 * 1000;
    this.rollTimes = this.rollTimes.filter((ts) => ts >= cutoff);
    const feeKeys = Object.keys(this.feeByRequest);
    if (feeKeys.length > 500) {
      feeKeys.slice(0, feeKeys.length - 500).forEach((k) => delete this.feeByRequest[k]);
    }

    // newest first: fresh logs arrive oldest→newest, so reverse before prepending
    fresh.reverse();
    this.setState((prev) => ({
      items: fresh.concat(prev.items)
        .map((it) => (it.kind === 'win' && outcomes[it.listingId] ? { ...it, outcome: outcomes[it.listingId] } : it))
        .slice(0, MAX_ITEMS),
      pending,
      rollsPerHour: this.rollTimes.length,
    }));

    this.resolveArt(fresh.filter((it) => it.kind === 'win').slice(0, MAX_ITEMS));
  }

  // Best-effort NFT art via the shared cached resolver.
  async resolveArt(wins) {
    if (wins.length === 0) return;
    try {
      const art = await fetchListingArt(wins.map((it) => it.listingId));
      if (!this.alive) return;
      this.setState((prev) => ({
        items: prev.items.map((it) => (it.kind === 'win' && art[it.listingId]
          ? { ...it, img: art[it.listingId].img, collection: art[it.listingId].collection, tokenId: art[it.listingId].tokenId }
          : it)),
      }));
    } catch (e) { /* art is decoration — never break the ticker over it */ }
  }

  // a failed art load clears the item's img in STATE so React swaps in the
  // placeholder itself — mutating the DOM under React (the old outerHTML
  // trick) crashes the next unmount with removeChild-not-a-child
  artFailed(key) {
    if (!this.alive) return;
    this.setState((prev) => ({
      items: prev.items.map((it) => (it.key === key ? { ...it, img: null } : it)),
    }));
  }

  renderItem(it) {
    const age = fmtAge(Math.max(0, (this.state.now - it.tsMs) / 1000));
    const isWin = it.kind === 'win';
    const os = isWin ? openSeaUrl(it.collection, it.tokenId) : null;
    // border color = the puller's decision; grey until they choose
    const outcomeCls = isWin ? ' outcome-' + (it.outcome || 'none') : '';
    return (
      <div key={it.key} className="pull-tilewrap">
        <a
          className={'pull-ticker-item pull-ticker-item-' + it.kind}
          href={ETHERSCAN + '/tx/' + it.tx}
          target="_blank"
          rel="noopener noreferrer"
          title={(isWin ? 'won listing #' + it.listingId + ' — backing ' + fmtEth(it.backing) + ' ETH' : 'acquisition refunded')
            + (it.outcome ? ' — ' + OUTCOME_LABEL[it.outcome] : isWin ? ' — undecided' : '')}
        >
          {isWin && it.img
            ? <img className={'pull-ticker-art' + outcomeCls} src={it.img} alt="" onError={() => this.artFailed(it.key)} />
            : (
              <div className={'pull-ticker-art pull-ticker-art-placeholder' + outcomeCls}>
                <i className={isWin ? 'mdi mdi-trophy text-warning' : 'mdi mdi-undo-variant text-danger'}></i>
              </div>
            )}
          <FwaAddress address={it.purchaser} size="xs" noLink />
          <span className={'pull-ticker-eth ' + (isWin ? 'text-success' : 'text-danger')}>
            {isWin ? fmtEth(it.backing, 3) : '↩ ' + fmtEth(it.backing, 3)}
          </span>
          <span className="pull-ticker-age">{age}</span>
        </a>
        {os && (
          <a className="os-badge" href={os} target="_blank" rel="noopener noreferrer" title="view on OpenSea">
            <i className="mdi mdi-ship-wheel"></i>
          </a>
        )}
      </div>
    );
  }

  render() {
    const { items, pending, rollsPerHour } = this.state;
    return (
      <div className="card pull-ticker-card grid-margin">
        <div className="d-flex align-items-stretch">
          <div className="pull-ticker-head">
            <div className="pull-ticker-live"><span className="pull-live-dot"></span> LIVE PULLS</div>
            <div className="pull-ticker-sub text-muted">
              {pending === null ? '…' : pending + ' rolling'}
              {rollsPerHour !== null ? ' · ' + rollsPerHour + '/hr' : ''}
            </div>
            <div className="outcome-legend text-muted">
              <span className="outcome-chip outcome-none"></span> undecided
              <span className="outcome-chip outcome-kept"></span> kept
              <span className="outcome-chip outcome-eth"></span> ETH
              <span className="outcome-chip outcome-fwa"></span> FWA
            </div>
          </div>
          <div className="pull-ticker-strip">
            {items.length === 0
              ? <span className="text-muted pl-3">listening for pulls…</span>
              : items.map((it) => this.renderItem(it))}
          </div>
        </div>
      </div>
    );
  }
}

export default PullTicker;
