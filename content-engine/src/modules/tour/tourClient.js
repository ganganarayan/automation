/*
 * Onboarding tour, browser side. Served as /api/v1/admin/tour.js and loaded by
 * the admin menu (utils/adminNav.js) and the funnel setup wizard.
 *
 * A Help box sits at the top right with a small bot that jumps three times
 * whenever the step changes. Each step says what to do in one or two lines,
 * offers "Take me there" when the step is on another page, and spotlights the
 * exact field or button on this page. The server (GET /admin/tour/state) says
 * which stage the workspace is at; this file only maps it onto the page.
 *
 * Plain ES2017, no imports, no build step.
 */
(function () {
  'use strict';
  if (window.__ctour) return;
  window.__ctour = true;

  var TOTAL = 7;
  var PREFIX = (location.pathname.match(/^\/t\/[^/]+/) || [''])[0];
  var API = PREFIX + '/api/v1/admin/tour/state';
  var ADMIN_KEY = new URLSearchParams(location.search).get('key') || '';
  var WIZ = location.pathname.match(/\/admin\/funnels\/(\d+)\/setup/);
  var WIZ_ID = WIZ ? Number(WIZ[1]) : 0;
  var WIZ_STEP = WIZ ? (Number(new URLSearchParams(location.search).get('step')) || 0) : -1;
  var ON_SETTINGS = /\/admin\/settings\/?$/.test(location.pathname);
  var OPEN_KEY = 'ctour-open';
  var CONNECT_KEY = 'ctour-connect-';

  var S = null; // server state
  var root, box, pill, spot, lastKey = '', target = null, refreshTimer = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function ss(k, v) {
    try { if (v === undefined) return sessionStorage.getItem(k); if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { return null; }
    return null;
  }
  function headers() {
    var h = { 'Content-Type': 'application/json' };
    if (ADMIN_KEY) h['X-Admin-Key'] = ADMIN_KEY;
    return h;
  }
  function q(sel) { try { return document.querySelector(sel); } catch (e) { return null; } }
  function visible(el) { return !!(el && el.getClientRects().length && el.offsetParent !== null); }

  // ---- styles + markup --------------------------------------------------
  var CSS = [
    '#ctour{position:fixed;top:16px;right:16px;z-index:2147483000;font-family:system-ui,sans-serif;color:#e8e8ef}',
    '#ctour.low{top:auto;bottom:16px}',
    '#ctour .ct-pill{display:flex;align-items:center;gap:.45rem;background:#15224a;border:1px solid #2d6cdf;color:#fff;border-radius:999px;padding:.3rem .85rem .3rem .3rem;cursor:pointer;font-size:.88rem;font-weight:600;box-shadow:0 6px 24px rgba(0,0,0,.45)}',
    '#ctour .ct-pill:hover{background:#1b2c5e}',
    '#ctour .ct-box{width:min(350px,calc(100vw - 32px));background:#12121b;border:1px solid #2d6cdf;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.6);overflow:hidden}',
    '#ctour .ct-head{display:flex;align-items:center;gap:.6rem;padding:.7rem .8rem .5rem}',
    '#ctour .ct-k{font-size:.68rem;text-transform:uppercase;letter-spacing:.08em;color:#7aa2ff;font-weight:700}',
    '#ctour .ct-t{font-size:1rem;font-weight:700;color:#fff;margin-top:.1rem;line-height:1.25}',
    '#ctour .ct-x{margin-left:auto;align-self:flex-start;background:none;border:0;color:#8a8aa2;font-size:1.1rem;cursor:pointer;padding:.1rem .3rem}',
    '#ctour .ct-bar{height:3px;background:#1c1c2a}#ctour .ct-bar i{display:block;height:3px;background:#2d6cdf;transition:width .4s}',
    '#ctour .ct-body{padding:.75rem .9rem .2rem;font-size:.88rem;line-height:1.5;color:#d7d7e6;max-height:52vh;overflow:auto}',
    '#ctour .ct-body p{margin:0 0 .55rem}#ctour .ct-body ol{margin:.2rem 0 .55rem;padding-left:1.2rem}#ctour .ct-body li{margin:.25rem 0}',
    '#ctour .ct-body a{color:#7aa2ff}#ctour .ct-body b{color:#fff}',
    '#ctour .ct-do{background:#15224a;border-left:3px solid #ffd479;border-radius:6px;padding:.5rem .65rem;margin:.2rem 0 .6rem;color:#fff}',
    '#ctour .ct-do:before{content:"Do this now";display:block;font-size:.66rem;letter-spacing:.08em;text-transform:uppercase;color:#ffd479;font-weight:700;margin-bottom:.15rem}',
    '#ctour code{background:#0b0b12;border:1px solid #24243a;border-radius:4px;padding:0 .3rem;font-size:.8rem;color:#c7c7d9;word-break:break-all}',
    '#ctour .ct-copy{background:#2a2a44;color:#fff;border:0;border-radius:6px;padding:.12rem .5rem;font-size:.74rem;cursor:pointer;margin-left:.25rem}',
    '#ctour .ct-acts{display:flex;align-items:center;gap:.45rem;padding:.55rem .9rem .8rem;flex-wrap:wrap}',
    '#ctour .ct-btn{border:0;border-radius:8px;padding:.45rem .85rem;font-size:.84rem;cursor:pointer;background:#2a2a44;color:#fff;text-decoration:none}',
    '#ctour .ct-btn.pri{background:#2d6cdf}',
    '#ctour .ct-skip{margin-left:auto;background:none;border:0;color:#6f6f88;font-size:.76rem;cursor:pointer;text-decoration:underline}',
    '#ctour .ct-bot{flex:0 0 auto;width:44px;height:44px;display:block}',
    '#ctour .ct-pill .ct-bot{width:30px;height:30px}',
    '#ctour .ct-bot.jump{animation:ctjump .55s ease-in-out 3}',
    '@keyframes ctjump{0%,100%{transform:translateY(0)}35%{transform:translateY(-14px) rotate(-6deg)}60%{transform:translateY(0) scaleY(.9)}75%{transform:translateY(-3px)}}',
    '#ctour .ct-eye{animation:ctblink 4s infinite;transform-origin:center}',
    '@keyframes ctblink{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(.1)}}',
    '#ctour-spot{position:fixed;z-index:2147482999;pointer-events:none;border:2px solid #ffd479;border-radius:10px;box-shadow:0 0 0 9999px rgba(5,5,12,.5);transition:top .25s,left .25s,width .25s,height .25s;display:none}',
    '#ctour-spot:after{content:"";position:absolute;inset:-6px;border:2px solid #ffd479;border-radius:14px;animation:ctpulse 1.4s ease-out infinite}',
    '#ctour-spot .ct-here{position:absolute;left:-2px;top:-26px;background:#ffd479;color:#1a1400;font:700 .72rem system-ui,sans-serif;padding:.15rem .5rem;border-radius:6px 6px 6px 0;white-space:nowrap}',
    '#ctour-spot.below .ct-here{top:auto;bottom:-26px;border-radius:0 6px 6px 6px}',
    '@keyframes ctpulse{0%{opacity:.9;transform:scale(1)}100%{opacity:0;transform:scale(1.08)}}',
    '@media (prefers-reduced-motion:reduce){#ctour .ct-bot.jump,#ctour-spot:after,#ctour .ct-eye{animation:none}}',
  ].join('\n');

  // The content engine bot: a small round robot with an antenna and a play-button chest.
  var BOT = '<svg class="ct-bot" viewBox="0 0 64 64" aria-hidden="true">' +
    '<line x1="32" y1="6" x2="32" y2="15" stroke="#7aa2ff" stroke-width="3" stroke-linecap="round"/>' +
    '<circle cx="32" cy="6" r="4" fill="#ffd479"/>' +
    '<rect x="10" y="14" width="44" height="32" rx="12" fill="#2d6cdf"/>' +
    '<rect x="16" y="20" width="32" height="18" rx="8" fill="#0b0b12"/>' +
    '<g class="ct-eye"><circle cx="25" cy="29" r="3.6" fill="#8ff0b0"/><circle cx="39" cy="29" r="3.6" fill="#8ff0b0"/></g>' +
    '<path d="M27 34 q5 3.5 10 0" stroke="#8ff0b0" stroke-width="2" fill="none" stroke-linecap="round"/>' +
    '<rect x="6" y="25" width="5" height="11" rx="2.5" fill="#1f4f9f"/><rect x="53" y="25" width="5" height="11" rx="2.5" fill="#1f4f9f"/>' +
    '<rect x="18" y="47" width="28" height="13" rx="6" fill="#1f4f9f"/>' +
    '<path d="M29 50 l7 3.5 -7 3.5z" fill="#ffd479"/></svg>';

  function mount() {
    var st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
    root = document.createElement('div');
    root.id = 'ctour';
    root.setAttribute('role', 'complementary');
    root.setAttribute('aria-label', 'Setup help');
    document.body.appendChild(root);
    spot = document.createElement('div');
    spot.id = 'ctour-spot';
    spot.innerHTML = '<span class="ct-here">Here</span>';
    document.body.appendChild(spot);
  }

  // ---- what to do, step by step -----------------------------------------
  function funnelsLink() {
    return q('.nv[data-target="funnels"]') || q('a.nv[href*="#funnels"]');
  }
  function funnelsPanelOpen() {
    var p = document.getElementById('panel-funnels');
    return ON_SETTINGS && visible(p);
  }
  function setupHref(stage) {
    var i = S.wizard && S.wizard[stage] >= 0 ? S.wizard[stage] : 0;
    return PREFIX + '/api/v1/admin/funnels/' + S.funnel.id + '/setup?step=' + i;
  }
  function goFunnels() {
    if (ON_SETTINGS && typeof window.show === 'function') { window.show('funnels'); render(true); return; }
    location.href = PREFIX + '/api/v1/admin/settings#funnels';
  }
  function goWizard(i) {
    if (WIZ && typeof window.nav === 'function') { window.nav(i); return; }
    location.href = PREFIX + '/api/v1/admin/funnels/' + S.funnel.id + '/setup?step=' + i;
  }
  function filled(sel) { var el = q(sel); return !!(el && String(el.value || '').trim()); }

  var STAGE_META = {
    basics: { n: 4, title: 'Fill in the basics', page: 'Shared basics' },
    publish: { n: 5, title: 'Connect your social accounts', page: 'Publish & comments' },
    image: { n: 6, title: 'Bring your Google Sheet', page: 'Lane 3: Image post' },
  };

  /** -> { n, title, html, sel|el, here, go:{label,run}|null, finish } */
  function current() {
    var f = S.funnel;
    if (S.stage === 'add') {
      if (!funnelsPanelOpen()) {
        return {
          n: 1, title: 'Open Funnels',
          html: '<p>Welcome! I will get your first posts going in a few short steps.</p>' +
            '<p>A <b>funnel</b> is one brand or campaign. Its accounts, schedule and content all live inside it.</p>' +
            '<div class="ct-do">Click <b>Funnels</b> in the menu on the left.</div>',
          el: funnelsLink(), here: 'Click Funnels', go: { label: 'Take me there', run: goFunnels },
        };
      }
      var name = q('#panel-funnels form[action$="/admin/funnels"] input[name="name"]');
      if (!name || !String(name.value || '').trim()) {
        return {
          n: 2, title: 'Name your funnel',
          html: '<p>Give it a name you will recognise, such as your brand or the offer it promotes.</p>' +
            '<div class="ct-do">Type the name in the highlighted <b>Funnel name</b> box.</div>',
          el: name, here: 'Type a name',
        };
      }
      return {
        n: 2, title: 'Add your funnel',
        html: '<p>Good name. Now save it.</p><div class="ct-do">Click <b>+ Add funnel</b>.</div>',
        el: name.form && name.form.querySelector('button[type="submit"]'), here: 'Click here',
      };
    }

    if (S.stage === 'done') {
      return {
        n: 7, title: 'You are set up',
        html: '<p><b>' + esc(f && f.name) + '</b> now posts every day at its publish time. Each day the router picks a ready video, an AI video or an image post from your sheet, and emails you to approve it first.</p>' +
          '<p>Optional, when you want more:</p><ol><li><b>Lane 1</b>: a Drive folder of your own videos, posted in order.</li><li><b>Lane 2</b>: AI videos, once your keys are in.</li></ol>' +
          '<p>Click <b>Help</b> at the top right any time to see this again.</p>',
        finish: true,
      };
    }

    var meta = STAGE_META[S.stage];
    var idx = S.wizard ? S.wizard[S.stage] : 0;
    if (!f) return null;

    // Not on this funnel's setup yet.
    if (WIZ_ID !== f.id) {
      var setupLink = q('a[href$="/admin/funnels/' + f.id + '/setup"]');
      var first = S.stage === 'basics';
      var html = first
        ? '<p>Your funnel <b>' + esc(f.name) + '</b> is added. Its setup has a few short pages; I will take you through only the ones you need.</p>'
        : '<p>Next for <b>' + esc(f.name) + '</b>: ' + esc(meta.title.toLowerCase()) + '. It is on the funnel\'s setup.</p>';
      if (funnelsPanelOpen() && visible(setupLink)) {
        return {
          n: first ? 3 : meta.n, title: first ? 'Open its setup' : meta.title,
          html: html + '<div class="ct-do">Click <b>Set up</b> next to <b>' + esc(f.name) + '</b>.</div>',
          el: setupLink, here: 'Click Set up', go: { label: 'Take me there', run: function () { location.href = setupHref(S.stage); } },
        };
      }
      return {
        n: first ? 3 : meta.n, title: first ? 'Open its setup' : meta.title,
        html: html + '<div class="ct-do">Click <b>Funnels</b> in the menu, then <b>Set up</b> next to your funnel. Or let me take you there.</div>',
        el: funnelsLink(), here: 'Funnels', go: { label: 'Take me there', run: function () { location.href = setupHref(S.stage); } },
      };
    }

    // On the setup, but another page of it.
    if (WIZ_STEP !== idx) {
      return {
        n: meta.n, title: meta.title,
        html: '<p>This step is on the <b>' + esc(meta.page) + '</b> page of the setup.</p>' +
          '<div class="ct-do">Click <b>' + esc(meta.page) + '</b> in the list on the left. What you typed here is saved first.</div>',
        el: q('.wnav[data-step="' + idx + '"]'), here: 'Click here', go: { label: 'Take me there', run: function () { goWizard(idx); } },
      };
    }

    // On the right page: point at the next field.
    if (S.stage === 'basics') return basicsStep(meta);
    if (S.stage === 'publish') return publishStep(meta, f.id);
    return imageStep(meta);
  }

  function basicsStep(meta) {
    var intro = '<p>Two things the app cannot work without. Leave the rest as it is for now.</p>';
    if (!filled('[name="set[approval_email]"]')) {
      return {
        n: meta.n, title: meta.title,
        html: intro + '<div class="ct-do">Type the email address where approval emails should go. Nothing posts until you approve it there or in the app.</div>',
        el: q('[name="set[approval_email]"]'), here: 'Your email',
      };
    }
    if (!filled('[name="set[cta_link]"]')) {
      return {
        n: meta.n, title: meta.title,
        html: intro + '<div class="ct-do">Paste the link people should open from your posts: your booking, assessment or landing page. It starts with https://</div>',
        el: q('[name="set[cta_link]"]'), here: 'Your link',
      };
    }
    return {
      n: meta.n, title: meta.title,
      html: '<p>Both are filled in.</p><div class="ct-do">Click <b>Save &amp; Next</b> at the bottom.</div>',
      el: q('.btn.next'), here: 'Click here',
    };
  }

  function publishStep(meta, fid) {
    var list = document.getElementById('pfmlist-' + fid);
    var boxes = list ? list.querySelectorAll('input[type="checkbox"]') : [];
    var ticked = list ? list.querySelectorAll('input[type="checkbox"]:checked').length : 0;
    var plat = document.getElementById('pfmplat-' + fid);
    var connected = ss(CONNECT_KEY + fid) === '1';
    var intro = '<p>This is where your funnel gets its Instagram, Facebook, YouTube, LinkedIn and other channels. You sign in on each platform yourself; no password is shared with us.</p>';
    if (!boxes.length && !connected) {
      return {
        n: meta.n, title: meta.title,
        html: intro + '<ol><li>Pick a channel in the highlighted list.</li><li>Click <b>Connect an account</b>. A new tab opens.</li><li>Sign in there and allow access, then come back to this tab.</li></ol>' +
          '<div class="ct-do">Pick a channel and click <b>Connect an account</b>.</div>',
        el: plat && plat.parentElement, here: 'Pick, then Connect',
      };
    }
    if (!boxes.length) {
      return {
        n: meta.n, title: meta.title,
        html: '<p>Signed in on the new tab? Bring the accounts here. To add another channel, connect it first, then fetch once for all.</p>' +
          '<div class="ct-do">Click <b>Fetch accounts from Post for Me</b>.</div>',
        el: q('button[onclick^="fetchPfm"]'), here: 'Click Fetch',
        extra: plat ? '<p style="font-size:.78rem;color:#8a8aa2">Need another channel? Pick it and click Connect an account again.</p>' : '',
      };
    }
    if (!ticked) {
      return {
        n: meta.n, title: meta.title,
        html: '<p>These are the accounts you connected.</p><div class="ct-do">Tick each account this funnel should post to.</div>',
        el: list, here: 'Tick your accounts',
      };
    }
    return {
      n: meta.n, title: meta.title,
      html: '<p>' + ticked + ' account' + (ticked === 1 ? '' : 's') + ' ticked.</p><div class="ct-do">Click <b>Save</b> at the bottom.</div>',
      el: q('.btn.save'), here: 'Click Save',
    };
  }

  function imageStep(meta) {
    var hdr = (S.sheetHeaders || []).join('\t');
    var sa = S.saEmail || '';
    var shareLine = sa
      ? '<li>Click <b>Share</b> on the sheet and add <code>' + esc(sa) + '</code><button type="button" class="ct-copy" data-copy="' + esc(sa) + '">Copy</button> as <b>Editor</b>.</li>'
      : '<li>Click <b>Share</b> on the sheet and set <b>General access</b> to <b>Anyone with the link</b>, role <b>Editor</b>.</li>';
    var steps = '<p>On days with no video, the funnel posts an image from a Google Sheet that you own. You only make it once; the app fills in new post ideas by itself.</p>' +
      '<ol><li>Open <a href="https://sheets.new" target="_blank" rel="noopener">sheets.new</a> in a new tab to make a blank sheet.</li>' +
      '<li>Click cell <b>A1</b> and paste the headers <button type="button" class="ct-copy" data-copy="' + esc(hdr) + '">Copy headers</button><br><code>' + esc((S.sheetHeaders || []).join(' | ')) + '</code></li>' +
      shareLine +
      '<li>Copy the sheet\'s address from the browser bar and paste it in the highlighted box. I keep only the ID.</li></ol>';
    if (!filled('[name="set[sheet_id]"]')) {
      return {
        n: meta.n, title: meta.title,
        html: steps + '<div class="ct-do">Paste your sheet\'s link into <b>Content sheet ID</b>.</div>',
        el: q('[name="set[sheet_id]"]'), here: 'Paste the sheet link',
      };
    }
    return {
      n: meta.n, title: meta.title,
      html: '<p>Sheet linked. Make sure it is shared as Editor, or the app cannot add ideas to it.</p><div class="ct-do">Click <b>Save</b> at the bottom.</div>',
      el: q('.btn.save'), here: 'Click Save',
    };
  }

  // ---- render -------------------------------------------------------------
  function isOpen() {
    var v = ss(OPEN_KEY);
    if (v === '1') return true;
    if (v === '0') return false;
    return !!(S && S.open);
  }

  function render(force) {
    if (!S || !root) return;
    var open = isOpen();
    var step = open ? current() : null;
    if (!open || !step) {
      if (force || lastKey !== 'pill') {
        root.className = '';
        root.innerHTML = '<button type="button" class="ct-pill" aria-label="Open setup help">' + BOT + '<span>Help</span></button>';
        root.querySelector('.ct-pill').onclick = function () { setOpen(true); };
        lastKey = 'pill';
      }
      setTarget(null);
      return;
    }
    var key = step.n + '|' + step.title + '|' + step.html.length + '|' + (step.here || '');
    if (force || key !== lastKey) {
      var stepChanged = lastKey.split('|')[0] !== String(step.n) || lastKey === 'pill' || lastKey === '';
      lastKey = key;
      var acts = '';
      if (step.go) acts += '<button type="button" class="ct-btn pri" data-a="go">' + esc(step.go.label) + '</button>';
      if (step.el) acts += '<button type="button" class="ct-btn" data-a="show">Show me</button>';
      if (step.finish) {
        acts += '<button type="button" class="ct-btn pri" data-a="finish">Finish</button>';
        acts += '<a class="ct-btn" href="' + PREFIX + '/api/v1/admin/today">Open Today</a>';
      } else {
        acts += '<button type="button" class="ct-btn" data-a="hide">Hide</button>';
        acts += '<button type="button" class="ct-skip" data-a="skip">Skip tour</button>';
      }
      root.innerHTML = '<div class="ct-box">' +
        '<div class="ct-head">' + BOT + '<div><div class="ct-k">Step ' + step.n + ' of ' + TOTAL + '</div><div class="ct-t">' + esc(step.title) + '</div></div>' +
        '<button type="button" class="ct-x" data-a="hide" aria-label="Hide help">×</button></div>' +
        '<div class="ct-bar"><i style="width:' + Math.round((step.n / TOTAL) * 100) + '%"></i></div>' +
        '<div class="ct-body">' + step.html + (step.extra || '') + '</div>' +
        '<div class="ct-acts">' + acts + '</div></div>';
      wire(step);
      if (stepChanged) jump();
      setTarget(step.el || null, step.here, true);
    } else {
      setTarget(step.el || null, step.here, false);
    }
  }

  function wire(step) {
    root.querySelectorAll('[data-a]').forEach(function (b) {
      b.onclick = function () {
        var a = b.getAttribute('data-a');
        if (a === 'go' && step.go) step.go.run();
        else if (a === 'show') { setTarget(step.el, step.here, true); jump(); }
        else if (a === 'hide') setOpen(false);
        else if (a === 'skip') { save('dismissed'); S.saved = 'dismissed'; setOpen(false); }
        else if (a === 'finish') { save('done'); S.saved = 'done'; setOpen(false); }
      };
    });
    root.querySelectorAll('[data-copy]').forEach(function (b) {
      b.onclick = function () { copy(b.getAttribute('data-copy'), b); };
    });
  }

  function jump() {
    var bot = root.querySelector('.ct-bot');
    if (!bot) return;
    bot.classList.remove('jump');
    void bot.getBoundingClientRect();
    bot.classList.add('jump');
  }

  function setOpen(v) {
    ss(OPEN_KEY, v ? '1' : '0');
    if (v && S && (S.saved === 'dismissed')) { save(''); S.saved = ''; }
    lastKey = '';
    render(true);
  }

  function copy(text, btn) {
    var done = function () { var t = btn.textContent; btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = t; }, 1400); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else { fallbackCopy(text); done(); }
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) { /* nothing more to try */ }
    ta.remove();
  }

  // ---- spotlight ----------------------------------------------------------
  function setTarget(el, here, scroll) {
    target = el && visible(el) ? el : null;
    if (!target) { spot.style.display = 'none'; root.classList.remove('low'); return; }
    spot.querySelector('.ct-here').textContent = here || 'Here';
    if (scroll) {
      var r = target.getBoundingClientRect();
      if (r.top < 70 || r.bottom > window.innerHeight - 20) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    place();
  }
  function place() {
    if (!target) return;
    if (!visible(target)) { spot.style.display = 'none'; return; }
    var r = target.getBoundingClientRect();
    var pad = 6;
    spot.style.display = 'block';
    spot.style.top = (r.top - pad) + 'px';
    spot.style.left = (r.left - pad) + 'px';
    spot.style.width = (r.width + pad * 2) + 'px';
    spot.style.height = (r.height + pad * 2) + 'px';
    spot.classList.toggle('below', r.top < 40);
    // Keep the help box off the thing it points at.
    var b = root.firstElementChild ? root.firstElementChild.getBoundingClientRect() : null;
    if (b) {
      var overlap = !(r.right < b.left || r.left > b.right || r.bottom < b.top || r.top > b.bottom);
      if (overlap && !root.classList.contains('low')) root.classList.add('low');
      else if (!overlap && root.classList.contains('low') && r.top > window.innerHeight / 2) root.classList.remove('low');
    }
  }
  function loop() {
    if (target) place();
    requestAnimationFrame(loop);
  }

  // ---- server -------------------------------------------------------------
  function load() {
    var url = API + (WIZ_ID ? '?funnel=' + WIZ_ID : '');
    return fetch(url, { headers: headers(), credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.ok) { S = j; render(false); } })
      .catch(function () { /* help is best-effort; the page works without it */ });
  }
  function save(state) {
    fetch(API, { method: 'POST', headers: headers(), credentials: 'same-origin', body: JSON.stringify({ state: state }) }).catch(function () {});
  }
  function refreshSoon(ms) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(load, ms || 1500);
  }

  // ---- page events ----------------------------------------------------------
  function watch() {
    document.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target : null;
      if (!t || (root && root.contains(t))) return;
      if (t.closest('button[onclick^="connectPfm"]') && S && S.funnel) ss(CONNECT_KEY + S.funnel.id, '1');
      if (t.closest('.btn.save')) refreshSoon(1500);
      if (t.closest('.nav') || t.closest('.nv')) setTimeout(function () { render(false); }, 50);
      setTimeout(function () { render(false); }, 120);
    }, true);
    document.addEventListener('input', function (e) {
      var el = e.target;
      // A pasted sheet link becomes its ID: the box stores the ID only.
      if (el && el.name === 'set[sheet_id]') {
        var m = String(el.value || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
        if (m) el.value = m[1];
      }
      render(false);
    }, true);
    document.addEventListener('change', function () { render(false); }, true);
    window.addEventListener('hashchange', function () { render(false); });
    // Lists that fill in by themselves (Fetch accounts) are caught here.
    setInterval(function () { if (isOpen()) render(false); }, 1200);
  }

  function start() {
    mount();
    watch();
    requestAnimationFrame(loop);
    load();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
