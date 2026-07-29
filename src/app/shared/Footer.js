import React, { Component } from 'react';

class Footer extends Component {
  render() {
    return (
      <footer className="footer">
        <div className="d-sm-flex justify-content-center justify-content-sm-between py-2 w-100">
          <span className="text-muted text-center text-sm-left d-block d-sm-inline-block">
            FWAAH! — Fake World Assets at home · runs against your own node, survives the website going down
          </span>
          <span className="float-none float-sm-right d-block mt-1 mt-sm-0 text-center text-muted">
            Corona theme by BootstrapDash
          </span>
        </div>
      </footer>
    );
  }
}

export default Footer;
