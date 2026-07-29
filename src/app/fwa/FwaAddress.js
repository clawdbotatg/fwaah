import React, { Component } from 'react';
import makeBlockie from 'ethereum-blockies-base64';
import { ETHERSCAN, ensName, shortAddr } from './fwa';

const blockieCache = {};
function blockie(address) {
  const a = address.toLowerCase();
  if (!blockieCache[a]) blockieCache[a] = makeBlockie(a);
  return blockieCache[a];
}

// Scaffold-ETH-style <Address/>: blockie identicon + ENS name (resolved through
// the local node, batched + cached) falling back to the short hex form, linking
// to Etherscan. sizes: xs | sm | base. `noLink` renders a span (for use inside
// other anchors, e.g. the pull ticker tiles).
export class FwaAddress extends Component {
  state = { name: null };

  componentDidMount() {
    this.mounted = true;
    this.lookup();
  }

  componentDidUpdate(prevProps) {
    if (prevProps.address !== this.props.address) {
      this.setState({ name: null });
      this.lookup();
    }
  }

  componentWillUnmount() {
    this.mounted = false;
  }

  lookup() {
    const { address } = this.props;
    ensName(address).then((name) => {
      if (this.mounted && address === this.props.address && name) this.setState({ name });
    });
  }

  render() {
    const { address, size = 'sm', noLink } = this.props;
    if (!address) return <span className="text-muted">—</span>;
    const label = this.state.name || shortAddr(address);
    const cls = 'fwa-address fwa-address-' + size + (this.state.name ? ' fwa-address-ens' : '');
    const inner = (
      <React.Fragment>
        <img className="fwa-address-blockie" src={blockie(address)} alt="" />
        <span className="fwa-address-label">{label}</span>
      </React.Fragment>
    );
    if (noLink) return <span className={cls} title={address}>{inner}</span>;
    return (
      <a
        className={cls}
        href={ETHERSCAN + '/address/' + address}
        target="_blank"
        rel="noopener noreferrer"
        title={address}
        onClick={(e) => e.stopPropagation()}
      >
        {inner}
      </a>
    );
  }
}

export default FwaAddress;
