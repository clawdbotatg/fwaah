import React from 'react';

const GITHUB_URL = 'https://github.com/clawdbotatg/fwaah';

// Shown only on the hosted site (fwaah.com) — self-hosters don't need to be
// told to fork what they're already running. ?forkbanner=1 forces it for preview.
function onHostedSite() {
  try {
    if (new URLSearchParams(window.location.search).get('forkbanner')) return true;
    return /(^|\.)fwaah\.com$/i.test(window.location.hostname);
  } catch (_) {
    return false;
  }
}

export default function ForkBanner() {
  if (!onHostedSite()) return null;
  return (
    <a className="fwaah-fork-banner" href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
      <i className="mdi mdi-source-fork"></i>
      &nbsp;fork this and get <strong>&nbsp;Fake World Assets At Home&nbsp;</strong>
      <i className="mdi mdi-github"></i>
    </a>
  );
}
