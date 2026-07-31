import React, { Component } from 'react';
import { Link, withRouter } from 'react-router-dom';
import { FWA_ADDRESS, abiNinjaUrl } from '../fwa/fwa';

class Sidebar extends Component {
  render() {
    return (
      <nav className="sidebar sidebar-offcanvas" id="sidebar">
        <div className="sidebar-brand-wrapper d-none d-lg-flex align-items-center justify-content-center fixed-top">
          <Link className="sidebar-brand brand-logo fwaah-brand" to="/">
            <img className="fwaah-house" src={require('../../assets/images/fwaah-house.png')} alt="" />
            <span className="fwaah-brand-text">
              <span className="fwaah-title">FWAAH<span className="text-primary">!</span></span>
              <span className="fwaah-tagline">Fake World Assets at home</span>
            </span>
          </Link>
          <Link className="sidebar-brand brand-logo-mini" to="/">
            <img className="fwaah-house-mini" src={require('../../assets/images/fwaah-house.png')} alt="FWAAH!" />
          </Link>
        </div>
        <ul className="nav">
          <li className="nav-item nav-category">
            <span className="nav-link">Monitor</span>
          </li>
          <li className={this.props.location.pathname === '/' ? 'nav-item menu-items active' : 'nav-item menu-items'}>
            <Link className="nav-link" to="/">
              <span className="menu-icon"><i className="mdi mdi-speedometer"></i></span>
              <span className="menu-title">Dashboard</span>
            </Link>
          </li>
          <li className="nav-item nav-category">
            <span className="nav-link">Links</span>
          </li>
          <li className="nav-item menu-items">
            <a className="nav-link" href={abiNinjaUrl(FWA_ADDRESS, ['quoteAcquisitionPrice', 'acquire_0', 'listings', 'listNFT'])} target="_blank" rel="noopener noreferrer">
              <span className="menu-icon"><i className="mdi mdi-file-document"></i></span>
              <span className="menu-title">Contract</span>
            </a>
          </li>
          <li className="nav-item menu-items">
            <a className="nav-link" href={'https://repo.sourcify.dev/contracts/full_match/1/' + FWA_ADDRESS + '/'} target="_blank" rel="noopener noreferrer">
              <span className="menu-icon"><i className="mdi mdi-code-tags"></i></span>
              <span className="menu-title">Verified Source</span>
            </a>
          </li>
          <li className="nav-item menu-items">
            <a className="nav-link" href="https://x.com/clawdbotatg" target="_blank" rel="noopener noreferrer">
              <span className="menu-icon"><img className="sidebar-claw" src={require('../../assets/images/leftclaw.webp')} alt="" /></span>
              <span className="menu-title">Built by ClawdBotATG</span>
            </a>
          </li>
          <li className="nav-item nav-category">
            <span className="nav-link">Learn More</span>
          </li>
          <li className="nav-item sidebar-episode d-none d-lg-block">
            <a href="https://slop.computer/rhynotic?t=520" target="_blank" rel="noopener noreferrer" title="watch the slop.computer episode with Rhynotic">
              <img src={require('../../assets/images/rhynotic-episode.jpg')} alt="slop.computer episode with Rhynotic" />
              <span className="sidebar-episode-caption">▶ the Rhynotic episode on slop.computer</span>
            </a>
          </li>
        </ul>
      </nav>
    );
  }

  isPathActive(path) {
    return this.props.location.pathname.startsWith(path);
  }

  componentDidMount() {
    const body = document.querySelector('body');
    document.querySelectorAll('.sidebar .nav-item').forEach((el) => {
      el.addEventListener('mouseover', function () {
        if (body.classList.contains('sidebar-icon-only')) el.classList.add('hover-open');
      });
      el.addEventListener('mouseout', function () {
        if (body.classList.contains('sidebar-icon-only')) el.classList.remove('hover-open');
      });
    });
  }
}

export default withRouter(Sidebar);
