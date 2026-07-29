import React, { Component } from 'react';
import { Link } from 'react-router-dom';
import { FWA_ADDRESS, ETHERSCAN } from '../fwa/fwa';
import FwaAddress from '../fwa/FwaAddress';

class Navbar extends Component {
  toggleOffcanvas() {
    document.querySelector('.sidebar-offcanvas').classList.toggle('active');
  }
  render() {
    return (
      <nav className="navbar p-0 fixed-top d-flex flex-row">
        <div className="navbar-brand-wrapper d-flex d-lg-none align-items-center justify-content-center">
          <Link className="navbar-brand brand-logo-mini" to="/">
            <img src={require('../../assets/images/logo-mini.svg')} alt="logo" />
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
          <ul className="navbar-nav navbar-nav-right">
            <li className="nav-item d-none d-lg-block">
              <a className="nav-link" href={ETHERSCAN + '/address/' + FWA_ADDRESS} target="_blank" rel="noopener noreferrer" title="Etherscan">
                <i className="mdi mdi-magnify"></i>
              </a>
            </li>
            <li className="nav-item d-none d-lg-block">
              <span className="nav-link text-muted">
                <i className="mdi mdi-server text-success"></i> 192.168.68.54
              </span>
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
