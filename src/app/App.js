import React, { Component } from 'react';
import { withRouter } from 'react-router-dom';
import './App.scss';
import AppRoutes from './AppRoutes';
import Navbar from './shared/Navbar';
import Sidebar from './shared/Sidebar';
import Footer from './shared/Footer';
import ForkBanner from './shared/ForkBanner';

class App extends Component {
  render() {
    return (
      <div className="container-scroller">
        <Sidebar />
        <div className="container-fluid page-body-wrapper">
          <Navbar />
          <div className="main-panel">
            <div className="content-wrapper">
              <AppRoutes />
            </div>
            <Footer />
          </div>
        </div>
        <ForkBanner />
      </div>
    );
  }
}

export default withRouter(App);
