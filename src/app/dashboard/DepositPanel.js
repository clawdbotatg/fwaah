import React, { Component } from 'react';
import {
  FWA_ADDRESS, SELECTORS, WHITELIST_SNAPSHOT, KNOB_SNAPSHOT,
  rpcBatchSafe, ethCall, ethCallTo, encodeData, word, wordAddr,
  fmtEth,
} from '../fwa/fwa';
import { injected, onAccountsChanged, autoReconnectAllowed, sendTx, waitForReceipt } from '../fwa/wallet';

// Deposit an NFT into the pool: pick a whitelisted collection, paste the
// tokenId, choose the ETH backing. Ownership/whitelist/approval are verified
// with three cheap eth_calls before any transaction; the flow is approve →
// listNFT (backing rides as msg.value). Browsing "your NFTs" would need an
// indexer — manual entry doesn't.
export class DepositPanel extends Component {
  state = {
    account: null,
    collection: WHITELIST_SNAPSHOT[0][0],
    tokenId: '',
    backing: '',
    busy: null,
    error: null,
    done: null,
  };

  componentDidMount() {
    this.alive = true;
    this.offAccounts = onAccountsChanged((accounts) => {
      if (this.alive) this.setState({ account: accounts && accounts[0] ? accounts[0] : null, error: null, done: null });
    });
    const eth = injected();
    if (eth && autoReconnectAllowed()) {
      eth.request({ method: 'eth_accounts' }).then((accounts) => {
        if (this.alive && accounts && accounts[0]) this.setState({ account: accounts[0] });
      }).catch(() => { /* locked */ });
    }
  }

  componentWillUnmount() {
    this.alive = false;
    this.offAccounts();
  }

  async deposit() {
    const { account, collection, tokenId, backing } = this.state;
    if (!account || this.state.busy) return;
    let id;
    let backingWei;
    try {
      id = BigInt(tokenId.trim());
      backingWei = BigInt(Math.round(parseFloat(backing) * 1e6)) * 10n ** 12n;
    } catch (e) {
      this.setState({ error: 'tokenId and backing must be numbers' });
      return;
    }
    if (backingWei < KNOB_SNAPSHOT.minBacking) {
      this.setState({ error: 'backing below the ' + fmtEth(KNOB_SNAPSHOT.minBacking) + ' ETH minimum' });
      return;
    }
    try {
      this.setState({ busy: 'checking', error: null, done: null });
      const [ownerRaw, approvedRaw, allRaw, wlRaw] = await rpcBatchSafe([
        ethCallTo(collection, SELECTORS.ownerOf, [id]),
        ethCallTo(collection, SELECTORS.getApproved, [id]),
        ethCallTo(collection, SELECTORS.isApprovedForAll, [account, FWA_ADDRESS]),
        ethCall(SELECTORS.collectionWhitelisted, [collection]),
      ]);
      if (!ownerRaw) throw new Error("that tokenId doesn't exist in this collection");
      if (wordAddr(ownerRaw, 0).toLowerCase() !== account.toLowerCase()) {
        throw new Error("you don't own that token");
      }
      if (!wlRaw || word(wlRaw, 0) !== 1n) {
        throw new Error('collection is not whitelisted for deposits');
      }
      const approved = (approvedRaw && wordAddr(approvedRaw, 0).toLowerCase() === FWA_ADDRESS.toLowerCase())
        || (allRaw && word(allRaw, 0) === 1n);
      if (!approved) {
        this.setState({ busy: 'approving' });
        const hash = await sendTx({
          from: account,
          to: collection,
          data: encodeData(SELECTORS.approve, [FWA_ADDRESS, id]),
        });
        const receipt = await waitForReceipt(hash);
        if (receipt.status === '0x0') throw new Error('approval reverted');
      }
      this.setState({ busy: 'depositing' });
      const hash = await sendTx({
        from: account,
        to: FWA_ADDRESS,
        data: encodeData(SELECTORS.listNFT, [collection, id]),
        value: backingWei,
      });
      const receipt = await waitForReceipt(hash);
      if (receipt.status === '0x0') throw new Error('deposit reverted');
      if (!this.alive) return;
      this.setState({ busy: null, done: '#' + id.toString() + ' is in the pool — it will appear in YOUR DEPOSITS shortly', tokenId: '', backing: '' });
    } catch (e) {
      if (!this.alive) return;
      const msg = e && e.code === 4001 ? 'rejected in wallet' : String((e && e.message) || e);
      this.setState({ busy: null, error: msg });
    }
  }

  render() {
    const { account, collection, tokenId, backing, busy, error, done } = this.state;
    return (
      <div className="card deposit-card grid-margin">
        <div className="card-body py-3">
          <div className="d-flex flex-wrap align-items-end deposit-row">
            <div className="deposit-title mr-3">
              <div className="pull-ticker-live"><i className="mdi mdi-tray-arrow-down"></i> DEPOSIT AN NFT</div>
              <div className="text-muted small">back it with ETH · earn a share of every pull fee</div>
            </div>
            {account ? (
              <React.Fragment>
                <div className="form-group mb-0 mr-2">
                  <label className="small text-muted mb-1">collection</label>
                  <select
                    className="form-control form-control-sm deposit-select"
                    value={collection}
                    onChange={(e) => this.setState({ collection: e.target.value, error: null, done: null })}
                  >
                    {WHITELIST_SNAPSHOT.map(([addr, name]) => <option key={addr} value={addr}>{name}</option>)}
                  </select>
                </div>
                <div className="form-group mb-0 mr-2">
                  <label className="small text-muted mb-1">tokenId</label>
                  <input
                    className="form-control form-control-sm deposit-input"
                    placeholder="e.g. 202"
                    value={tokenId}
                    onChange={(e) => this.setState({ tokenId: e.target.value, error: null, done: null })}
                  />
                </div>
                <div className="form-group mb-0 mr-2">
                  <label className="small text-muted mb-1">backing (min {fmtEth(KNOB_SNAPSHOT.minBacking)} ETH)</label>
                  <input
                    className="form-control form-control-sm deposit-input"
                    placeholder="0.05"
                    value={backing}
                    onChange={(e) => this.setState({ backing: e.target.value, error: null, done: null })}
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-sm btn-warning deposit-btn"
                  disabled={!!busy || !tokenId.trim() || !backing.trim()}
                  onClick={() => this.deposit()}
                >
                  {busy ? busy + '…' : 'DEPOSIT'}
                </button>
              </React.Fragment>
            ) : <span className="text-muted small">connect your wallet (top right) to deposit</span>}
          </div>
          {error && <div className="small text-danger mt-2">{error}</div>}
          {done && <div className="small text-success mt-2">{done}</div>}
          {account && (
            <p className="text-muted small mb-0 mt-2">
              your backing escrows an irrevocable standing bid to buy the NFT back if it's pulled — lighter backing
              gets pulled more often; withdrawing anytime returns NFT + backing
            </p>
          )}
        </div>
      </div>
    );
  }
}

export default DepositPanel;
