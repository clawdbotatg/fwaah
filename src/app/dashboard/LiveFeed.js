import React, { Component } from 'react';
import {
  FWA_ADDRESS, ETHERSCAN, FEED_TOPICS,
  rpcBatch, toNum, describeLog, fmtAge, HOSTED,
} from '../fwa/fwa';
import FwaAddress from '../fwa/FwaAddress';

const WINDOW_BLOCKS = 20; // ~4 min — "what just happened"
const MAX_SHOWN = 7;
const MAX_KEPT = 30;

// This strip is the app's heartbeat, so it polls at block cadence even hosted.
// That stays cheap at any audience size: eth_blockNumber is one shared edge
// URL (6s TTL), and the getLogs URL only changes when the block does — so all
// viewers collapse to ~one upstream call per block. At home, hammer away.
const LIVE_POLL_MS = HOSTED ? 12000 : 4000;

// Chat-style strip of the last few blocks of protocol activity, pinned to the
// top of the dashboard so the app feels alive without scrolling. New events
// slide in on every ticker poll; the button jumps to the full 24h table.
export class LiveFeed extends Component {
  state = { items: [], now: Date.now() };

  componentDidMount() {
    this.alive = true;
    this.seen = new Set();
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), LIVE_POLL_MS);
    this.ageTimer = setInterval(() => this.setState({ now: Date.now() }), 1000);
  }

  componentWillUnmount() {
    this.alive = false;
    clearInterval(this.pollTimer);
    clearInterval(this.ageTimer);
  }

  async poll() {
    try {
      const [latestHex] = await rpcBatch([['eth_blockNumber', []]]);
      const latest = toNum(latestHex);
      const [logs] = await rpcBatch([['eth_getLogs', [{
        address: FWA_ADDRESS,
        fromBlock: '0x' + Math.max(latest - WINDOW_BLOCKS + 1, 0).toString(16),
        toBlock: '0x' + latest.toString(16),
        topics: [FEED_TOPICS],
      }]]]);
      if (!this.alive) return;
      const fresh = [];
      for (const log of logs) {
        const key = log.transactionHash + log.logIndex;
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        fresh.push({
          key,
          tx: log.transactionHash,
          bn: toNum(log.blockNumber),
          li: toNum(log.logIndex),
          tsMs: Date.now() - (latest - toNum(log.blockNumber)) * 12000,
          ...describeLog(log),
        });
      }
      // bound the dedupe set by evicting the OLDEST keys (Set keeps insertion
      // order) — it must stay bigger than a window's worth of logs, or evicted
      // logs re-ingest every poll and old items flash back above new ones
      if (this.seen.size > 2000) {
        const iter = this.seen.values();
        for (let i = 0; i < 800; i++) this.seen.delete(iter.next().value);
      }
      if (!fresh.length) return;
      this.setState((prev) => ({
        // chain order, not arrival order: a re-ingested straggler can never
        // jump the queue
        items: [...fresh, ...prev.items]
          .sort((a, b) => (b.bn - a.bn) || (b.li - a.li))
          .slice(0, MAX_KEPT),
      }));
    } catch (e) { /* transient — next poll */ }
  }

  render() {
    const { items, now } = this.state;
    if (!items.length) return null;
    return (
      <div className="card live-feed-card grid-margin">
        <div className="card-body py-2">
          <div className="d-flex align-items-center justify-content-between">
            <span className="live-feed-title"><span className="live-dot"></span> HAPPENING NOW</span>
            <button
              type="button"
              className="btn btn-link p-0 live-feed-more"
              onClick={() => {
                const el = document.getElementById('recent-activity');
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
            >
              see more activity <i className="mdi mdi-arrow-down"></i>
            </button>
          </div>
          <ul className="list-unstyled mb-0 mt-1">
            {items.slice(0, MAX_SHOWN).map((it) => (
              <li key={it.key} className="live-feed-item">
                <span className={'badge badge-outline-' + it.badge}>{it.name}</span>
                <span className="live-feed-parts">
                  {it.parts.map((p, i) => (typeof p === 'string'
                    ? <span key={i}>{p}</span>
                    : <FwaAddress key={i} address={p.addr} size="xs" />))}
                </span>
                <a
                  className="live-feed-age text-muted"
                  href={ETHERSCAN + '/tx/' + it.tx}
                  target="_blank" rel="noopener noreferrer"
                >
                  {fmtAge(Math.max(0, (now - it.tsMs) / 1000))} ago
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }
}

export default LiveFeed;
