import React, { Component } from 'react';
import { Link } from 'react-router-dom';
import { FWA_ADDRESS, RPC_LABEL, onRpcLabel, abiNinjaUrl } from '../fwa/fwa';
import { injected, connectWallet, disconnectWallet, onAccountsChanged, autoReconnectAllowed } from '../fwa/wallet';
import FwaAddress from '../fwa/FwaAddress';

class Navbar extends Component {
  state = { rpcLabel: RPC_LABEL, account: null, connecting: false };

  componentDidMount() {
    this.alive = true;
    this.offLabel = onRpcLabel((rpcLabel) => this.setState({ rpcLabel }));
    this.setState({ rpcLabel: RPC_LABEL }); // in case it resolved before mount
    this.offAccounts = onAccountsChanged((accounts) => {
      if (this.alive) this.setState({ account: accounts && accounts[0] ? accounts[0] : null });
    });
    // reflect an already-authorized wallet without prompting
    const eth = injected();
    if (eth && autoReconnectAllowed()) {
      eth.request({ method: 'eth_accounts' }).then((accounts) => {
        if (this.alive && accounts && accounts[0]) this.setState({ account: accounts[0] });
      }).catch(() => { /* locked — show connect */ });
    }
  }

  componentWillUnmount() {
    this.alive = false;
    this.offLabel();
    this.offAccounts();
  }

  async connect() {
    this.setState({ connecting: true });
    try {
      await connectWallet(); // broadcast updates every panel, incl. this one
    } catch (e) { /* rejected — stay disconnected */ }
    if (this.alive) this.setState({ connecting: false });
  }

  toggleOffcanvas() {
    document.querySelector('.sidebar-offcanvas').classList.toggle('active');
  }

  render() {
    const { account, connecting } = this.state;
    return (
      <nav className="navbar p-0 fixed-top d-flex flex-row">
        <div className="navbar-brand-wrapper d-flex d-lg-none align-items-center justify-content-center">
          <Link className="navbar-brand brand-logo-mini" to="/">
            <img className="fwaah-house-mini" src={require('../../assets/images/fwaah-house.png')} alt="FWAAH!" />
          </Link>
        </div>
        <div className="navbar-menu-wrapper flex-grow d-flex align-items-stretch">
          <button className="navbar-toggler align-self-center" type="button" onClick={() => document.body.classList.toggle('sidebar-icon-only')}>
            <span className="mdi mdi-menu"></span>
          </button>
          <ul className="navbar-nav w-100">
            <li className="nav-item w-100 d-none d-lg-flex align-items-center">
              <span className="nav-link text-muted d-flex align-items-center">
                fwaah.com · core&nbsp;<FwaAddress address={FWA_ADDRESS} size="sm" />
              </span>
            </li>
          </ul>
          <ul className="navbar-nav navbar-nav-right align-items-center">
            <li className="nav-item d-none d-lg-block">
              <a className="nav-link" href={abiNinjaUrl(FWA_ADDRESS)} target="_blank" rel="noopener noreferrer" title="poke the contract on abi.ninja">
                <i className="mdi mdi-magnify"></i>
              </a>
            </li>
            <li className="nav-item d-none d-lg-block">
              <span className="nav-link text-muted">
                <i className="mdi mdi-server text-success"></i> {this.state.rpcLabel}
              </span>
            </li>
            <li className="nav-item navbar-wallet">
              {account ? (
                <span className="navbar-wallet-chip">
                  <FwaAddress address={account} size="sm" />
                  <button
                    type="button"
                    className="navbar-wallet-disconnect"
                    title="disconnect wallet"
                    onClick={() => disconnectWallet()}
                  >
                    <i className="mdi mdi-close"></i>
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="btn btn-warning btn-connect"
                  disabled={connecting || !injected()}
                  title={injected() ? 'connect your wallet to pull, deposit and withdraw' : 'no injected wallet found'}
                  onClick={() => this.connect()}
                >
                  <i className="mdi mdi-wallet"></i> {connecting ? 'connecting…' : 'CONNECT'}
                </button>
              )}
            </li>
          </ul>
          <button className="navbar-toggler navbar-toggler-right d-lg-none align-self-center" type="button" onClick={this.toggleOffcanvas}>
            <span className="mdi mdi-format-line-spacing"></span>
          </button>
        </div>
      </nav>
    );
  }
}

export default Navbar;
