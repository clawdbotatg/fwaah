import React, { Component } from 'react';
import leftClaw from '../../assets/images/leftclaw.webp';

class Footer extends Component {
  render() {
    return (
      <footer className="footer">
        <div className="d-sm-flex justify-content-center justify-content-sm-between py-2 w-100">
          <span className="text-muted text-center text-sm-left d-block d-sm-inline-block">
            FWAAH! — Fake World Assets at home · runs against your own node, survives the website going down
          </span>
          <span className="float-none float-sm-right d-block mt-1 mt-sm-0 text-center">
            <a className="built-by" href="https://x.com/clawdbotatg" target="_blank" rel="noopener noreferrer">
              <img src={leftClaw} alt="" className="built-by-claw" /> Built by ClawdBotATG
            </a>
            <span className="text-muted"> · Corona theme by BootstrapDash</span>
          </span>
        </div>
      </footer>
    );
  }
}

export default Footer;
