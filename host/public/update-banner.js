// Update banner for the host's pages (editor and monitor): shown when the host has found a newer
// release on GitHub. The page calls showUpdate(statusMessage.update, send) on every status message.
// "Install and restart" works from pages on the sim PC only (the host checks).
(() => {
  const css = `
    #clUpdate { position: fixed; left: 16px; bottom: 16px; z-index: 50; max-width: min(560px, calc(100vw - 32px));
      background: #1d2a22; color: #e6efe9; border: 1px solid #3ba55c; border-radius: 8px; padding: 10px 12px;
      font: 13px/1.4 system-ui, sans-serif; box-shadow: 0 6px 24px #0008; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    #clUpdate.err { border-color: #d9443a; background: #2a1d1d; }
    #clUpdate .msg { flex: 1 1 220px; }
    #clUpdate button, #clUpdate a.b { font: inherit; background: #3ba55c; color: #fff; border: 0; border-radius: 5px; padding: 5px 10px; cursor: pointer; text-decoration: none; }
    #clUpdate a.l { color: #9fd6b2; }
    #clUpdate .x { background: transparent; color: #9aa0a8; padding: 2px 6px; }`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  let last = '';
  let dismissed = null;
  try { dismissed = localStorage.getItem('clUpdateDismissed'); } catch {}

  window.showUpdate = (u, send) => {
    const key = JSON.stringify(u ?? null);
    if (key === last) return;
    last = key;
    let el = document.getElementById('clUpdate');
    const show = u && (u.state === 'downloading' || u.state === 'installing' || u.state === 'error' || (u.available && dismissed !== u.latest));
    if (!show) return void el?.remove();
    if (!el) {
      el = document.createElement('div');
      el.id = 'clUpdate';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.classList.toggle('err', u.state === 'error');
    const notes = u.url ? ` <a class="l" href="${esc(u.url)}" target="_blank" rel="noopener">What's new</a>` : '';
    if (u.state === 'downloading') el.innerHTML = `<span class="msg">Downloading CockpitCast ${esc(u.latest)}…</span>`;
    else if (u.state === 'installing') el.innerHTML = `<span class="msg">Installing CockpitCast ${esc(u.latest)}. The host and the display PCs restart by themselves; this page reconnects when it is back.</span>`;
    else {
      const beta = String(u.latest).includes('-') ? ' (beta)' : '';
      const what = u.state === 'error' ? `Update failed: ${esc(u.error)}` : `<b>CockpitCast ${esc(u.latest)}</b>${beta} is available (this is ${esc(u.current)}).`;
      const action = !u.canInstall
        ? '<a class="b" href="https://cockpitcast.ludvigh.dev/#download" target="_blank" rel="noopener">Download</a>'
        : local
          ? `<button data-a="install" title="Downloads the new version, installs it and restarts CockpitCast. Display PCs with the installed client update too.">${u.state === 'error' ? 'Try again' : 'Install and restart'}</button>`
          : '<span>Install it from the sim PC (tray icon or this page there).</span>';
      el.innerHTML = `<span class="msg">${what}${notes}</span>${action}<button class="x" data-a="close" title="Hide until the next version">✕</button>`;
    }
    el.querySelector('[data-a="install"]')?.addEventListener('click', (e) => {
      e.target.disabled = true;
      send({ type: 'installUpdate' });
    });
    el.querySelector('[data-a="close"]')?.addEventListener('click', () => {
      dismissed = u.latest;
      try { localStorage.setItem('clUpdateDismissed', u.latest); } catch {}
      el.remove();
    });
  };
})();
