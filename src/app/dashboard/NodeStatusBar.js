import React, { Component } from 'react';
import { rpcBatch, toBig, toNum, fmtNum, fmtAge, POLL } from '../fwa/fwa';

const POLL_MS = POLL.node; // hard against a local node, gentle when hosted

// Slim always-fresh strip of node vitals pinned to the top of the dashboard.
export class NodeStatusBar extends Component {
  state = { block: null, ts: null, peers: null, syncing: null, baseFee: null, now: Date.now() };

  componentDidMount() {
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), POLL_MS);
    this.ageTimer = setInterval(() => this.setState({ now: Date.now() }), 1000);
  }

  componentWillUnmount() {
    clearInterval(this.pollTimer);
    clearInterval(this.ageTimer);
  }

  async poll() {
    try {
      const [block, peersHex, syncing] = await rpcBatch([
        ['eth_getBlockByNumber', ['latest', false]],
        ['net_peerCount', []],
        ['eth_syncing', []],
      ]);
      this.setState({
        block: toNum(block.number),
        ts: toNum(block.timestamp),
        baseFee: toBig(block.baseFeePerGas || '0x0'),
        peers: toNum(peersHex),
        syncing: syncing !== false,
        error: false,
      });
    } catch (e) {
      this.setState({ error: true });
    }
  }

  render() {
    const { block, ts, peers, syncing, baseFee, now, error } = this.state;
    const age = ts !== null ? Math.max(0, now / 1000 - ts) : null;
    return (
      <div className="card node-status-card grid-margin">
        <div className="d-flex flex-wrap align-items-center px-3 py-2">
          <span className="node-stat">
            <i className="mdi mdi-server text-info"></i>
            <span className="text-muted">node</span> 192.168.68.54
            {error && <span className="badge badge-outline-danger ml-2">unreachable</span>}
          </span>
          <span className="node-stat">
            <span className="text-muted">block</span>{' '}
            <strong key={block} className="node-block-flash">{block !== null ? fmtNum(block) : '—'}</strong>
          </span>
          <span className="node-stat">
            <span className="text-muted">age</span>{' '}
            <span className={age !== null && age > 60 ? 'text-danger' : 'text-success'}>
              {age !== null ? fmtAge(age) : '—'}
            </span>
          </span>
          <span className="node-stat">
            {syncing === null ? '—' : syncing
              ? <span className="badge badge-outline-warning">syncing</span>
              : <span className="badge badge-outline-success">synced</span>}
          </span>
          <span className="node-stat">
            <span className="text-muted">peers</span> {peers !== null ? peers : '—'}
          </span>
          <span className="node-stat">
            <span className="text-muted">base fee</span>{' '}
            {baseFee !== null ? (Number(baseFee) / 1e9).toFixed(2) + ' gwei' : '—'}
          </span>
        </div>
      </div>
    );
  }
}

export default NodeStatusBar;
