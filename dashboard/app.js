/* Token Launch Radar — board rendering, filters, sorting and detail view.
 *
 * The data comes from data.js, written by main.ts from the same board: every row carries its
 * rank, implied value, TVL, 7-day change, age with no token, chains, category and the five score
 * parts that valueBreakdown shows. The scoring itself lives in lib/model.ts (scoreProtocol and
 * impliedValueUsd); this file only displays the numbers it computed, so the screenshots and the
 * code behind them can never disagree.
 *
 * Deep links, used by the screenshots and shareable by hand:
 *   #p=<slug>        open one protocol's detail view
 *   #cat=<category>  filter to a category, e.g. #cat=Dexs
 *   #chain=<chain>   filter to a chain, e.g. #chain=Base
 *   #q=<text>        search text
 */

(function () {
  'use strict';

  var DATA = window.TOKEN_RADAR;
  if (!DATA || !Array.isArray(DATA.rows)) {
    document.getElementById('rows').innerHTML =
      '<tr><td colspan="9">No board data was loaded.</td></tr>';
    return;
  }

  var rows = DATA.rows;
  var bySlug = {};
  rows.forEach(function (r) { bySlug[r.slug] = r; });

  var state = { q: '', cat: '', chain: '', watch: false, sort: 'rank', dir: 1, selected: null };

  /* ------------------------------------------------------------ formatting */

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** $1.58B / $320.2M / $45.0K / $812 — short money for table cells. */
  function fmtUsd(v) {
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(v);
  }

  /** $1,583,204,000 with thousands separators, for the detail view. */
  function fmtUsdFull(v) {
    return '$' + Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function fmtPct(v) {
    if (v === null || v === undefined) return '<span class="muted">—</span>';
    var cls = v > 0 ? 'pos' : v < 0 ? 'neg' : '';
    return '<span class="' + cls + '">' + (v > 0 ? '+' : '') + v.toFixed(1) + '%</span>';
  }

  function fmtAge(years) {
    if (years === null || years === undefined) return '—';
    if (years < 1) return '&lt;1 yr';
    return years.toFixed(1) + ' yrs';
  }

  function fmtScore(s) { return s.toFixed(2); }

  /* ------------------------------------------------------------ header stats */

  function renderStats() {
    var el = document.getElementById('stats');
    el.innerHTML =
      stat(rows.length, 'ranked') +
      stat(DATA.watchlist_size, 'watchlist') +
      stat(DATA.eligible_total, 'pre-token eligible') +
      stat(DATA.tokenized_total, 'already trading');
    function stat(v, label) {
      return '<div><dt>' + esc(label) + '</dt><dd>' + v + '</dd></div>';
    }
    document.getElementById('asof').textContent =
      'Snapshot of ' + DATA.as_of + ' · ' + DATA.protocols_total +
      ' protocols at or above $5M TVL · floor $' + (DATA.floor_usd / 1e6) + 'M · values in US dollars';
  }

  /* ------------------------------------------------------------ filtering + sorting */

  function applyFilters(list) {
    var q = state.q.trim().toLowerCase();
    return list.filter(function (r) {
      if (state.watch && !r.watchlist) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) === -1) return false;
      if (q && r.name.toLowerCase().indexOf(q) === -1 && r.slug.indexOf(q) === -1) return false;
      return true;
    });
  }

  /** Sort a filtered list by the current key; rank order is the value order. */
  function sortRows(list) {
    var key = state.sort;
    var dir = state.dir;
    function num(a, b) { return (a - b) * dir; }
    function str(a, b) { return (a < b ? -1 : a > b ? 1 : 0) * dir; }
    var cmp = {
      rank: function (a, b) { return num(a.rank, b.rank); },
      name: function (a, b) { return str(a.name.toLowerCase(), b.name.toLowerCase()); },
      category: function (a, b) { return str(a.category, b.category) || num(a.rank, b.rank); },
      tvl: function (a, b) { return num(a.tvl_usd, b.tvl_usd); },
      growth: function (a, b) { return num(a.change_7d === null ? -Infinity : a.change_7d, b.change_7d === null ? -Infinity : b.change_7d); },
      age: function (a, b) { return num(a.age_years === null ? -1 : a.age_years, b.age_years === null ? -1 : b.age_years); },
      score: function (a, b) { return num(a.score, b.score); },
      value: function (a, b) { return num(a.implied_value_usd, b.implied_value_usd); },
    }[key] || function (a, b) { return num(a.rank, b.rank); };
    return list.slice().sort(function (a, b) { return cmp(a, b) || num(a.rank, b.rank); });
  }

  function renderTable() {
    var list = sortRows(applyFilters(rows));
    var tbody = document.getElementById('rows');
    document.getElementById('count').textContent =
      'Showing ' + list.length + ' of ' + rows.length + ' protocols';
    document.getElementById('empty').hidden = list.length > 0;
    tbody.innerHTML = list.map(function (r) {
      var badges = r.watchlist ? '<span class="badge">Watchlist</span>' : '';
      if (r.filler) badges += '<span class="badge filler">Version-marked name</span>';
      return '<tr data-slug="' + esc(r.slug) + '"' + (state.selected === r.slug ? ' class="selected"' : '') + '>' +
        '<td class="rank">' + r.rank + '</td>' +
        '<td class="name">' + esc(r.name) + badges + '<span class="sub">' + esc(r.slug) + '</span></td>' +
        '<td>' + esc(r.category) + '</td>' +
        '<td>' + esc(r.chains.slice(0, 3).join(', ')) + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</td>' +
        '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
        '<td class="num">' + fmtPct(r.change_7d) + '</td>' +
        '<td class="num">' + fmtAge(r.age_years) + '</td>' +
        '<td class="num">' + fmtScore(r.score) + '</td>' +
        '<td class="num"><strong>' + fmtUsd(r.implied_value_usd) + '</strong></td>' +
        '</tr>';
    }).join('');
    document.querySelectorAll('#board thead th[data-sort]').forEach(function (th) {
      th.classList.toggle('sorted', th.getAttribute('data-sort') === state.sort);
    });
  }

  /* ------------------------------------------------------------ detail view */

  var PARTS = [
    { key: 'size', label: 'Size · TVL', weight: 0.45 },
    { key: 'growth', label: 'Growth · 7d', weight: 0.25 },
    { key: 'age', label: 'Age · no token', weight: 0.15 },
    { key: 'chains', label: 'Chains', weight: 0.10 },
    { key: 'sector', label: 'Sector prior', weight: 0.05 },
  ];

  /** The value breakdown: each score part, its weight, and what it contributes. */
  function valueBreakdown(r) {
    return PARTS.map(function (p) {
      var part = r.parts[p.key];
      var contrib = p.weight * part;
      var pct = Math.round(part * 100);
      return '<div class="bar-row"><span class="lbl">' + p.label + ' (' + Math.round(p.weight * 100) + '%)</span>' +
        '<span class="bar"><i class="' + (part < 0.4 ? 'low' : '') + '" style="width:' + pct + '%"></i></span>' +
        '<span class="val">' + part.toFixed(2) + ' → ' + contrib.toFixed(3) + '</span></div>';
    }).join('');
  }

  function openDetail(slug, scroll) {
    var r = bySlug[slug];
    if (!r) return;
    state.selected = slug;
    document.getElementById('detail-panel').hidden = false;
    document.getElementById('detail-name').textContent = '#' + r.rank + ' · ' + r.name;
    var badges = r.watchlist ? 'Watchlist protocol · ' : 'Below the watchlist floor · ';
    badges += r.filler ? 'flagged: kept out of the watchlist only by a version marker in its name' :
      'records no token, not a wrapped, staked or bridged product';
    document.getElementById('detail-badges').textContent = badges;
    document.getElementById('detail').innerHTML =
      '<div class="detail-grid">' +
      statCell('Implied value', fmtUsdFull(r.implied_value_usd), 'score ' + fmtScore(r.score)) +
      statCell('TVL', fmtUsdFull(r.tvl_usd), r.chains.length + ' chain' + (r.chains.length === 1 ? '' : 's')) +
      statCell('7-day change', r.change_7d === null ? 'not reported' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(1) + '%', 'winsorised to −30%…+50%') +
      statCell('No token for', r.age_years === null ? 'not reported' : fmtAge(r.age_years), 'since first listed') +
      statCell('Category', esc(r.category), esc(r.chains.join(', '))) +
      '</div>' +
      '<div class="breakdown"><h3>How the value is built</h3>' +
      valueBreakdown(r) +
      '<p class="formula">Implied value = TVL × (2% + 48% × score²) = ' + fmtUsdFull(r.tvl_usd) +
      ' × (0.02 + 0.48 × ' + fmtScore(r.score) + '²) = <strong>' + fmtUsdFull(r.implied_value_usd) + '</strong>. ' +
      'Score = 0.45·size + 0.25·growth + 0.15·age + 0.10·chains + 0.05·sector.</p></div>' +
      '<div class="farm"><h3>Farm plan — what to do, what it costs, how long it takes</h3><ol>' +
      r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') +
      '</ol></div>';
    function statCell(k, v, s) {
      return '<div class="detail-stat"><div class="k">' + k + '</div><div class="v">' + v + '</div><div class="s">' + s + '</div></div>';
    }
    renderTable();
    if (scroll) document.getElementById('detail-panel').scrollIntoView({ block: 'start' });
    if (location.hash !== '#p=' + slug) history.replaceState(null, '', '#p=' + slug);
  }

  /* ------------------------------------------------------------ already trading */

  function renderLive() {
    document.getElementById('live-rows').innerHTML = DATA.live_top.map(function (p) {
      return '<tr><td class="name">' + esc(p.name) + '<span class="sub">' + esc(p.slug) + '</span></td>' +
        '<td class="num">' + fmtUsd(p.tvl_usd) + '</td>' +
        '<td class="num">' + (p.mcap_usd === null ? '—' : fmtUsd(p.mcap_usd)) + '</td></tr>';
    }).join('');
  }

  /* ------------------------------------------------------------ controls + hash */

  function fillSelects() {
    var cat = document.getElementById('cat');
    DATA.categories.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c; o.textContent = c; cat.appendChild(o);
    });
    var chains = {};
    rows.forEach(function (r) { r.chains.forEach(function (c) { chains[c] = true; }); });
    var chain = document.getElementById('chain');
    Object.keys(chains).sort().forEach(function (c) {
      var o = document.createElement('option');
      o.value = c; o.textContent = c; chain.appendChild(o);
    });
  }

  function readHash() {
    var h = location.hash.replace(/^#/, '');
    var params = {};
    h.split('&').forEach(function (kv) {
      var i = kv.indexOf('=');
      if (i > 0) params[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
    });
    return params;
  }

  function applyHash() {
    var p = readHash();
    if (p.cat) { state.cat = p.cat; document.getElementById('cat').value = p.cat; }
    if (p.chain) { state.chain = p.chain; document.getElementById('chain').value = p.chain; }
    if (p.q) { state.q = p.q; document.getElementById('q').value = p.q; }
    if (p.watch) { state.watch = true; document.getElementById('watch').checked = true; }
    renderTable();
    if (p.p) openDetail(p.p, false);
  }

  document.getElementById('q').addEventListener('input', function (e) { state.q = e.target.value; renderTable(); });
  document.getElementById('cat').addEventListener('change', function (e) { state.cat = e.target.value; renderTable(); });
  document.getElementById('chain').addEventListener('change', function (e) { state.chain = e.target.value; renderTable(); });
  document.getElementById('watch').addEventListener('change', function (e) { state.watch = e.target.checked; renderTable(); });
  document.getElementById('sort').addEventListener('change', function (e) {
    state.sort = e.target.value; state.dir = 1; renderTable();
  });
  document.querySelectorAll('#board thead th[data-sort]').forEach(function (th) {
    th.addEventListener('click', function () {
      var key = th.getAttribute('data-sort');
      if (state.sort === key) state.dir = -state.dir;
      else { state.sort = key; state.dir = key === 'name' || key === 'category' ? 1 : -1; }
      var sortSel = document.getElementById('sort');
      if (sortSel.querySelector('option[value="' + state.sort + '"]')) sortSel.value = state.sort;
      renderTable();
    });
  });
  document.getElementById('rows').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-slug]');
    if (tr) openDetail(tr.getAttribute('data-slug'), true);
  });
  window.addEventListener('hashchange', applyHash);

  renderStats();
  fillSelects();
  renderLive();
  applyHash();
  if (!readHash().p) renderTable();
})();
