import React, { Component } from 'react';
import {
  FWA_ADDRESS, ETHERSCAN, TOPICS,
  rpcBatch, toNum, word,
  fmtEth, fmtAge, topicAddr, topicNum,
  fetchListingArt, POLL,
} from '../fwa/fwa';
import FwaAddress from '../fwa/FwaAddress';

const POLL_MS = POLL.highValue;
const WINDOW_HOURS = 6;
const WINDOW_BLOCKS = WINDOW_HOURS * 300; // 12s blocks
const MAX_TILES = 16;

// Biggest wins of the last few hours, sorted by backing value (not time).
export class HighValuePulls extends Component {
  state = { items: [], now: Date.now() };

  componentDidMount() {
    this.alive = true;
    this.refresh();
    this.pollTimer = setInterval(() => this.refresh(), POLL_MS);
    this.ageTimer = setInterval(() => this.setState({ now: Date.now() }), 5000);
  }

  componentWillUnmount() {
    this.alive = false;
    clearInterval(this.pollTimer);
    clearInterval(this.ageTimer);
  }

  async refresh() {
    try {
      const [latestHex] = await rpcBatch([['eth_blockNumber', []]]);
      const latest = toNum(latestHex);
      // two range chunks keep each call safely under the node's 20k log cap
      const start = Math.max(latest - WINDOW_BLOCKS, 0);
      const mid = start + Math.floor(WINDOW_BLOCKS / 2);
      const chunks = await rpcBatch([
        ['eth_getLogs', [{ address: FWA_ADDRESS, fromBlock: '0x' + start.toString(16), toBlock: '0x' + mid.toString(16), topics: [[TOPICS.NFTAllocated]] }]],
        ['eth_getLogs', [{ address: FWA_ADDRESS, fromBlock: '0x' + (mid + 1).toString(16), toBlock: '0x' + latest.toString(16), topics: [[TOPICS.NFTAllocated]] }]],
      ]);
      const nowMs = Date.now();
      const wins = [].concat(...chunks).map((log) => {
        const bn = toNum(log.blockNumber);
        return {
          key: log.transactionHash + log.logIndex,
          listingId: topicNum(log.topics[2]),
          purchaser: topicAddr(log.topics[3]),
          backing: word(log.data, 1),
          tx: log.transactionHash,
          tsMs: nowMs - (latest - bn) * 12000,
        };
      });

      wins.sort((a, b) => (a.backing === b.backing ? 0 : a.backing > b.backing ? -1 : 1));
      const top = wins.slice(0, MAX_TILES);
      if (!this.alive) return;
      this.setState({ items: top });

      const art = await fetchListingArt(top.map((it) => it.listingId));
      if (!this.alive) return;
      this.setState((prev) => ({
        items: prev.items.map((it) => (art[it.listingId] ? { ...it, img: art[it.listingId].img } : it)),
      }));
    } catch (e) { /* retry on the next poll */ }
  }

  render() {
    const { items, now } = this.state;
    return (
      <div className="card pull-ticker-card hv-card grid-margin">
        <div className="d-flex align-items-stretch">
          <div className="pull-ticker-head">
            <div className="pull-ticker-live hv-title"><i className="mdi mdi-diamond-stone"></i> HIGH VALUE</div>
            <div className="pull-ticker-sub text-muted">top pulls · last {WINDOW_HOURS}h</div>
          </div>
          <div className="pull-ticker-strip">
            {items.length === 0
              ? <span className="text-muted pl-3">scanning for big pulls…</span>
              : items.map((it) => (
                <a
                  key={it.key}
                  className="pull-ticker-item hv-item"
                  href={ETHERSCAN + '/tx/' + it.tx}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={'listing #' + it.listingId + ' — backing ' + fmtEth(it.backing) + ' ETH'}
                >
                  {it.img
                    ? <img className="pull-ticker-art hv-art" src={it.img} alt="" onError={(e) => { e.target.outerHTML = '<div class="pull-ticker-art hv-art pull-ticker-art-placeholder"><i class="mdi mdi-trophy text-warning"></i></div>'; }} />
                    : (
                      <div className="pull-ticker-art hv-art pull-ticker-art-placeholder">
                        <i className="mdi mdi-trophy text-warning"></i>
                      </div>
                    )}
                  <span className="hv-eth text-success">{fmtEth(it.backing, 3)} ETH</span>
                  <FwaAddress address={it.purchaser} size="xs" noLink />
                  <span className="pull-ticker-age">{fmtAge(Math.max(0, (now - it.tsMs) / 1000))} ago</span>
                </a>
              ))}
          </div>
        </div>
      </div>
    );
  }
}

export default HighValuePulls;
