import React, { Component } from 'react';
import { rpcBatch, toBig, toNum, fmtNum, fmtAge, POLL, HOSTED, RPC_LABEL, onRpcLabel } from '../fwa/fwa';

const POLL_MS = POLL.node; // hard against a local node, gentle when hosted

// Slim always-fresh strip of chain vitals pinned to the top of the dashboard.
// At home it shows the full node picture (peers, sync). Hosted, it shows only
// what a remote RPC can answer — and if the RPC isn't set up, a friendly hint
// instead of anyone's LAN address.
export class NodeStatusBar extends Component {
  state = { block: null, ts: null, peers: null, syncing: null, baseFee: null, now: Date.now(), error: false, rpcLabel: RPC_LABEL };

  componentDidMount() {
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), POLL_MS);
    this.ageTimer = setInterval(() => this.setState({ now: Date.now() }), 1000);
    this.offLabel = onRpcLabel((rpcLabel) => this.setState({ rpcLabel }));
    this.setState({ rpcLabel: RPC_LABEL }); // in case it resolved before mount
  }

  componentWillUnmount() {
    clearInterval(this.pollTimer);
    clearInterval(this.ageTimer);
    this.offLabel();
  }

  async poll() {
    try {
      const calls = [['eth_getBlockByNumber', ['latest', false]]];
      if (!HOSTED) {
        calls.push(['net_peerCount', []]);
        calls.push(['eth_syncing', []]);
      }
      const res = await rpcBatch(calls);
      const block = res[0];
      this.setState({
        block: toNum(block.number),
        ts: toNum(block.timestamp),
        baseFee: toBig(block.baseFeePerGas || '0x0'),
        peers: HOSTED ? null : toNum(res[1]),
        syncing: HOSTED ? false : res[2] !== false,
        error: false,
      });
    } catch (e) {
      this.setState({ error: true });
    }
  }

  render() {
    const { block, ts, peers, syncing, baseFee, now, error } = this.state;
    const age = ts !== null ? Math.max(0, now / 1000 - ts) : null;

    if (error && block === null) {
      return (
        <div className="card node-status-card grid-margin">
          <div className="d-flex flex-wrap align-items-center px-3 py-2">
            <span className="node-stat">
              <i className="mdi mdi-server-off text-warning"></i>
              {HOSTED
                ? <span className="text-muted"> no RPC configured — set <code>RPC_UPSTREAM</code> in the Vercel env, or point this page at your own node with <code>?rpc=&lt;url&gt;</code></span>
                : <span className="text-muted"> can't reach your node — check the RPC in <code>setupProxy.js</code> or start with <code>NODE_RPC_URL=&lt;url&gt; npm start</code></span>}
            </span>
          </div>
        </div>
      );
    }

    return (
      <div className="card node-status-card grid-margin">
        <div className="d-flex flex-wrap align-items-center px-3 py-2">
          <span className="node-stat">
            <i className="mdi mdi-server text-info"></i>
            <span className="text-muted">{this.state.rpcLabel}</span>
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
          {!HOSTED && (
            <span className="node-stat">
              {syncing === null ? '—' : syncing
                ? <span className="badge badge-outline-warning">syncing</span>
                : <span className="badge badge-outline-success">synced</span>}
            </span>
          )}
          {!HOSTED && (
            <span className="node-stat">
              <span className="text-muted">peers</span> {peers !== null ? peers : '—'}
            </span>
          )}
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
