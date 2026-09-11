/* STONKENIZED front end. Reads the public API only. */

const $ = (id) => document.getElementById(id);
const api = (p) => fetch('/api' + p, { headers: { accept: 'application/json' } }).then((r) => r.json());

let STATE = null;
let closesAt = 0;
let skew = 0; // serverTime - clientTime, so the countdown matches the engine

// ---------------------------------------------------------------- formatting

const fmtInt = (n) => Number(n || 0).toLocaleString('en-US');

function fmtUsd(n) {
  const v = Number(n || 0);
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return '$' + Math.round(v / 1e3) + 'k';
  return '$' + Math.round(v);
}

/** base units -> human string, without floating point drift */
function fromUnits(raw, decimals = 18, places = 4) {
  let s = String(raw || '0').replace(/[^0-9]/g, '') || '0';
  s = s.replace(/^0+(?=\d)/, '');
  if (s.length <= decimals) s = '0'.repeat(decimals - s.length + 1) + s;
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals, s.length - decimals + places).replace(/0+$/, '');
  return frac ? `${Number(whole).toLocaleString('en-US')}.${frac}` : Number(whole).toLocaleString('en-US');
}

/**
 * Signed price impact in basis points -> short display string.
 * Positive = value lost to the swap. Negative would mean the quote claims you
 * gain value, which only happens when the aggregator's price for an illiquid
 * token is junk - those are filtered off the ballot server-side.
 */
function fmtImpact(bps) {
  if (bps === null || bps === undefined) return '—';
  return (Math.abs(Number(bps)) / 100).toFixed(2) + '%';
}

/** Seconds -> a readable duration, so a 12h round never reads "720 minutes". */
function fmtDuration(secs) {
  const s = Number(secs) || 0;
  if (s % 86400 === 0 && s >= 86400) return (s / 86400) + (s === 86400 ? ' day' : ' days');
  if (s % 3600 === 0 && s >= 3600) return (s / 3600) + (s === 3600 ? ' hour' : ' hours');
  if (s >= 60) return Math.round(s / 60) + ' minutes';
  return s + ' seconds';
}

const shortAddr = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '');

function compactTokens(raw) {
  const n = Number(String(raw || '0')) / 1e18;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(Math.round(n));
}

function hhmmss(secs) {
  if (secs < 0) secs = 0;
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  const p = (x) => String(x).padStart(2, '0');
  return h > 0 ? `${p(h)}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

// ------------------------------------------------------------------ ticker

/** Price of the underlying tokenized equity, formatted like a quote board. */
function fmtPrice(p) {
  const v = Number(p);
  if (!Number.isFinite(v) || v <= 0) return null;
  return '$' + v.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: v < 1 ? 4 : 2,
  });
}

function fmtChange(pct) {
  if (pct === null || pct === undefined || !Number.isFinite(Number(pct))) return null;
  const v = Number(pct);
  return { text: (v >= 0 ? '+' : '') + v.toFixed(2) + '%', cls: v >= 0 ? 'up' : 'down' };
}

function renderTicker(ballot) {
  if (!ballot.length) return;
  // A real quote board: ticker, last price, 24h change. The old version showed
  // swap price-impact labelled "fill", which is internal jargon and read as
  // noise once the marquee wrapped.
  const items = ballot.slice(0, 28).map((b) => {
    const price = fmtPrice(b.price_usd);
    const chg = fmtChange(b.change24h);
    return `<span><span class="sym">${b.name || b.symbol}</span> ` +
      `<span class="px">${price || '—'}</span>` +
      (chg ? ` <span class="${chg.cls}">${chg.text}</span>` : '') +
      `</span>`;
  }).join('');
  $('ticker').innerHTML = items + items; // duplicated so the marquee loops seamlessly
}

// ------------------------------------------------------------------- render

// ------------------------------------------------------------- view model
/**
 * Every user-visible string is derived from live engine config here, in ONE
 * place. Change round_seconds to 24h on the engine and the page says "24 hours"
 * with no code change; same for the poll interval, thresholds and the operator
 * cut. Nothing about the copy is hardcoded.
 */
function viewModel(state) {
  const cfg = state.config || {};
  const round = state.round;
  const preview = state.preview;

  const usingPreview = !round && !!preview;
  const launched = !!cfg.token_address;
  const voteOnly = String(cfg.vote_only) === '1' || !launched;

  const tally = usingPreview ? (preview.tally || []) : (state.tally || []);

  const awaitingSpend = !!round && round.status === 'awaiting_spend';

  return {
    cfg, round, preview, usingPreview, launched, voteOnly, tally, awaitingSpend,
    eligibleHolders: state.eligibleHolders,
    feed: state.feed || (usingPreview ? preview.feed : []) || [],
    ballot: state.ballot || [],
    totalVotes: tally.reduce((s, t) => s + Number(t.votes), 0),
    minHoldFull: fromUnits(cfg.min_holding || '0', 18, 0),
    minHoldShort: compactTokens(cfg.min_holding || '0'),
    roundLen: fmtDuration(cfg.round_seconds),
    pollLen: fmtDuration(cfg.vote_poll_secs || 300),
    ownerPct: (Number(cfg.owner_bps || 1000) / 100) + '%',
    minPot: cfg.min_pot_bnb || '0.5',
    handle: cfg.x_handle || '',
    // The fee asset is not always BNB. flap pays creator revenue in native BNB;
    // four.meme pays it in the token's quote asset, so the copy has to name
    // whatever is configured instead of assuming a currency.
    feeAsset: cfg.quote_symbol || 'BNB',
    fourMeme: !!(cfg.quote_token || '').trim(),
    manualSpend: String(cfg.manual_spend) === '1',
  };
}

/**
 * id -> what to write. Deliberately a LIST rather than an object: an object
 * literal silently keeps the last duplicate key, which is exactly the bug this
 * replaced (holderCount was written in two places and the second write won,
 * showing "0 holders" under a "counted from launch" label).
 */
function bindings(vm) {
  const out = [];
  const set = (id, spec) => out.push([id, spec]);
  const { cfg, round, voteOnly, launched } = vm;

  // --- headline copy, all config-derived --------------------------------
  set('minHoldText', { text: vm.minHoldFull });
  set('minHoldText2', { text: vm.minHoldFull });

  set('lede', {
    html: voteOnly
      ? 'Every round, the community picks a tokenized US equity on X. Once STONKENIZED launches, ' +
        'its own creator fees buy the winner and airdrop it, pro-rata, to everyone holding at ' +
        'least <b>' + vm.minHoldFull + '</b> STONKENIZED. <b>Voting is open now.</b>'
      : 'STONKENIZED collects its own creator fees on Robinhood Chain, and every round the community ' +
        'picks a tokenized US equity on X. The app buys it and airdrops it, pro-rata, to ' +
        'everyone holding at least <b>' + vm.minHoldFull + '</b> STONKENIZED.',
  });

  const potRule = vm.manualSpend
    ? 'each round buys an amount set by hand at close, so a round never spends more than ' +
      'was intended'
    : 'a round only executes once the pot clears <b>' + vm.minPot + '</b> ' + vm.feeAsset +
      ' — below that it rolls forward so gas is not wasted on dust';
  set('roundEconomics', {
    html: voteOnly
      ? 'Rounds currently run for <b>' + vm.roundLen + '</b>. Once the token is live, ' +
        potRule + '.'
      : 'Rounds run every <b>' + vm.roundLen + '</b>, and ' + potRule + '.',
  });

  // --- how it works, step 1 and 2 ---------------------------------------
  set('step1Head', { text: vm.fourMeme ? '1 · Fees arrive' : '1 · Fees are released' });
  set('step1Body', {
    html: vm.fourMeme
      ? "STONKENIZED's trading tax is pushed to the fee wallet by the token contract itself, " +
        'once it clears the minimum written into the contract. There is no claim step and no ' +
        'button — it '  +
        'arrives as <b>' + vm.feeAsset + '</b> and simply shows up.'
      : "STONKENIZED's tax accrues in its own on-chain processor. The app flushes it into the " +
        'fee wallet — anyone can trigger that, so it is not a promise, it is a public function.',
  });
  set('step2Body', {
    html: vm.manualSpend
      ? 'The amount to spend is set by hand once voting closes, then swapped from <b>' +
        vm.feeAsset + '</b> into the winning tokenized stock through an aggregator, so the ' +
        'route is whatever is cheapest at that moment.'
      : '<b>' + vm.ownerPct + '</b> of the pot goes to the operator; the rest is swapped from <b>' +
        vm.feeAsset + '</b> into the winning tokenized stock through an aggregator, so the ' +
        'route is whatever is cheapest at that moment.',
  });

  set('modeNotice', {
    hidden: !voteOnly,
    html: voteOnly
      ? '<b>Pre-launch round.</b> STONKENIZED has not launched yet, so this round collects votes ' +
        'and declares a winner only — no fees are collected, nothing is bought, and nothing is ' +
        'distributed. Buying and airdrops begin with the first round after launch.'
      : '',
  });

  set('closeNotice', {
    hidden: !voteOnly,
    html: voteOnly
      ? 'This is what will happen once the token is live. The round running right now stops ' +
        'after the winner is declared.'
      : '',
  });

  set('followLine', {
    html: vm.handle
      ? 'Follow <a href="https://x.com/' + vm.handle + '" target="_blank" rel="noopener">@' +
        vm.handle + '</a> on X. Votes from non-followers are recorded but not counted — follow ' +
        'and they activate when the round closes.'
      : 'Follow the official STONKENIZED account on X. Votes from non-followers are recorded ' +
        'but not counted.',
  });

  // --- contract address --------------------------------------------------
  set('caValue', { text: launched ? cfg.token_address : 'Coming soon' });
  set('caCopy', { hidden: !launched });
  set('caLink', {
    hidden: !launched,
    href: launched ? 'https://bscscan.com/token/' + cfg.token_address : '#',
  });
  set('tokenAddr', { text: launched ? cfg.token_address : 'contract address at launch' });

  // --- status pill -------------------------------------------------------
  set('statusPill', {
    text: String(cfg.paused) === '1' ? 'Engine paused · pre-launch'
      : vm.awaitingSpend ? 'Round ' + round.id + ' · winner picked, buy pending'
      : round ? 'Round ' + round.id + ' · ' + round.status
      : 'Waiting for the next round',
  });

  // A round parked for operator approval otherwise looks stalled - the vote is
  // over, the winner is set, and nothing appears to happen for a while.
  set('spendNotice', {
    hidden: !vm.awaitingSpend,
    html: vm.awaitingSpend
      ? '<b>Voting closed — $' + (round.winner_symbol || '?') + ' won.</b> The buy amount is ' +
        'set by hand each round, so the purchase and airdrop follow shortly. Holder ' +
        'snapshot is already taken, so nothing you do now changes your share.'
      : '',
  });

  // --- round tiles -------------------------------------------------------
  set('roundNo', { text: round ? '#' + round.id : '—' });
  set('roundStatus', { text: round ? round.status : 'no open round' });
  // Show counted vs seen. Previously this showed only the counted number, so a
  // vote awaiting its follow check looked like it had vanished.
  set('voteCount', { text: fmtInt(vm.totalVotes) });
  set('voteSub', {
    text: vm.usingPreview ? 'counted so far'
      : vm.feed.length > vm.totalVotes
        ? 'counted · ' + vm.feed.length + ' tweets seen'
        : 'this round',
  });

  // "0" would read as "nobody holds this" rather than "not applicable yet"
  set('holderCount', { text: launched ? fmtInt(vm.eligibleHolders) : '—' });
  set('holderSub', { text: launched ? '≥ ' + vm.minHoldShort + ' STONKENIZED' : 'counted from launch' });

  set('closesAt', {
    text: round && round.status === 'open'
      ? new Date(Number(round.closes_at) * 1000).toLocaleTimeString() : '',
  });

  set('tallyNote', {
    // The 20s is only how often this page re-reads the API. Votes are picked up
    // from X on the engine's own poll interval, which is much slower.
    // The tie-break is stated here on purpose: it decides real outcomes, so it
    // has to be something a voter can see and act on before they vote.
    html: (vm.usingPreview ? 'preview · voting opens at launch'
      : 'X is checked every ' + vm.pollLen + ' · page refreshes every 20s') +
      '<br><span class="dim">Tie-break: if two tickers finish level, the one whose ' +
      '<b>first vote was posted earliest</b> wins.</span>',
  });

  return out;
}

/** Apply bindings in a single pass, warning loudly if an id is written twice. */
function paint(list) {
  const seen = new Set();
  for (const [id, spec] of list) {
    if (seen.has(id)) console.warn('[stonkenized] #' + id + ' bound twice - later write wins');
    seen.add(id);
    const el = $(id);
    if (!el) continue;
    if ('text' in spec) el.textContent = spec.text;
    if ('html' in spec) el.innerHTML = spec.html;
    if ('hidden' in spec) el.hidden = spec.hidden;
    if ('href' in spec) el.href = spec.href;
  }
}

function render(state) {
  STATE = state;
  const vm = viewModel(state);

  paint(bindings(vm));

  // the countdown is driven by a timer, not by the paint pass
  closesAt = vm.round && vm.round.status === 'open' ? Number(vm.round.closes_at) : 0;
  if (!closesAt) $('countdown').textContent = vm.round ? 'settling' : '—';
  tickClock();

  renderTally(vm.tally);
  renderFeed(vm.feed);
  renderBallot(vm.ballot);
  renderTicker(vm.ballot);
  renderLastPaid(state.lastPaid);
  buildTemplate();
}

function renderTally(tally) {
  const el = $('tally');
  if (!tally.length) {
    el.innerHTML = '<p class="dim small">No votes yet this round. Be the first.</p>';
    return;
  }
  const max = Math.max(...tally.map((t) => Number(t.votes)));
  // Only surface the tie-break timestamp when it is actually deciding something,
  // so it explains the leader instead of adding noise to every row.
  const leaders = tally.filter((t) => Number(t.votes) === max);
  const tied = leaders.length > 1;
  el.innerHTML = tally.map((t, i) => {
    const pct = max ? (Number(t.votes) / max) * 100 : 0;
    const isLeader = Number(t.votes) === max;
    const when = t.first_vote
      ? new Date(Number(t.first_vote) * 1000).toLocaleTimeString() : null;
    const note = tied && isLeader && when
      ? `<div class="dim" style="font-size:10.5px;margin-top:3px">first vote ${when}` +
        (i === 0 ? ' · leads the tie' : '') + '</div>'
      : '';
    return `<div class="tally-row">
      <div class="tally-head">
        <span><span class="sym">$${t.name || t.symbol}</span><span class="co">${t.symbol}</span></span>
        <span class="n">${fmtInt(t.votes)}</span>
      </div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      ${note}
    </div>`;
  }).join('');
}

/** Recent tweets the engine evaluated, counted or not. Null hides the panel. */
function renderFeed(feed) {
  const el = $('feed');
  if (!el) return;
  const wrap = $('feedWrap');
  if (!feed || !feed.length) {
    if (wrap) wrap.hidden = true;
    return;
  }
  if (wrap) wrap.hidden = false;
  el.innerHTML = feed.map((v) => {
    const ok = !!v.would_count;
    const badge = ok
      ? '<span class="badge paid">counted</span>'
      : `<span class="badge">${(v.reason || 'not counted').replace(/_/g, ' ')}</span>`;
    return `<tr>
      <td class="mono small">@${v.handle}</td>
      <td>${v.symbol ? '$' + (v.name || v.symbol) : '<span class="dim">—</span>'}</td>
      <td>${badge}</td>
      <td class="small dim right">${v.tweet_at ? new Date(v.tweet_at * 1000).toLocaleString() : ''}</td>
    </tr>`;
  }).join('');
}

function renderBallot(ballot) {
  const el = $('ballot');
  if (!ballot.length) {
    el.innerHTML = '<p class="dim small">Ballot is being measured…</p>';
    return;
  }
  el.innerHTML = ballot.map((b) => {
    const price = fmtPrice(b.price_usd);
    const chg = fmtChange(b.change24h);
    const tip = `pool ${fmtUsd(b.liquidity_usd)} · ${fmtImpact(b.impact_bps)} price impact on a round-sized buy`;
    return `<span class="chip" title="${tip}"><b>$${b.name || b.symbol}</b>` +
      `<span class="px">${price || '—'}</span>` +
      (chg ? `<span class="${chg.cls}" style="font-size:10.5px">${chg.text}</span>` : '') +
      `</span>`;
  }).join('');

  const sel = $('tickerPick');
  if (sel && sel.options.length !== ballot.length) {
    sel.innerHTML = ballot.map((b) => `<option value="${b.name || b.symbol}">$${b.name || b.symbol}</option>`).join('');
  }
}

function renderLastPaid(r) {
  const el = $('lastPaid');
  if (!r) return;
  el.innerHTML = `<div class="grid c4">
    <div class="stat"><div class="k">Round</div><div class="v">#${r.id}</div>
      <div class="sub">${r.closed_at ? new Date(r.closed_at * 1000).toLocaleString() : ''}</div></div>
    <div class="stat"><div class="k">Bought</div><div class="v accent">$${r.winner_name || r.winner_symbol || '—'}</div>
      <div class="sub">${fmtInt(r.winner_votes)} of ${fmtInt(r.total_votes)} votes</div></div>
    <div class="stat"><div class="k">Distributed</div><div class="v up">${fromUnits(r.bought_raw, 18, 4)}</div>
      <div class="sub">tokens to holders</div></div>
    <div class="stat"><div class="k">Recipients</div><div class="v">${fmtInt(r.holders_count)}</div>
      <div class="sub">pro-rata by balance</div></div>
  </div>`;
}

// ----------------------------------------------------------------- template

function buildTemplate() {
  const cfg = (STATE && STATE.config) || {};
  const handle = cfg.x_handle ? '@' + cfg.x_handle : '@STONKENIZED';
  const tag = '#' + String(cfg.x_hashtag || 'STONKENIZED').replace(/^#/, '');
  const sel = $('tickerPick');
  const ticker = sel && sel.value ? sel.value : 'NVDA';
  const round = STATE && STATE.round ? ' #' + STATE.round.id : '';

  const text =
`I'm voting $${ticker} for round${round}.

${handle} turns its creator fees into real tokenized stock
and drops it on every holder.

${tag}`;

  $('template').innerHTML = text
    .replace(/\$([A-Z.]+)/g, '<span class="tok">$$$1</span>')
    .replace(/(#[A-Za-z0-9_]+)/g, '<span class="tag">$1</span>')
    .replace(/(@[A-Za-z0-9_]+)/g, '<span class="tok">$1</span>');

  $('tweetBtn').href = 'https://x.com/intent/tweet?text=' + encodeURIComponent(text);
  $('copyBtn').onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      $('copyBtn').textContent = 'Copied';
      setTimeout(() => { $('copyBtn').textContent = 'Copy'; }, 1500);
    } catch {
      $('copyBtn').textContent = 'Select it manually';
    }
  };
}

// ------------------------------------------------------------------- clock

function tickClock() {
  if (!closesAt) return;
  const nowSec = Math.floor(Date.now() / 1000) + skew;
  const left = closesAt - nowSec;
  const el = $('countdown');
  el.textContent = hhmmss(left);
  el.classList.toggle('closing', left <= 60);
  if (left <= 0) el.textContent = 'closing…';
}

// ------------------------------------------------------------ wallet check

async function checkWallet() {
  const addr = $('addr').value.trim();
  const out = $('checkOut');
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    out.innerHTML = '<p class="small" style="color:var(--down)">That is not a valid Robinhood Chain address.</p>';
    return;
  }
  out.innerHTML = '<p class="dim small">Checking…</p>';
  try {
    const r = await api('/holder?address=' + addr);
    if (r.error) throw new Error(r.error);
    const bal = fromUnits(r.balance, 18, 2);
    const head = r.eligible
      ? `<span class="badge paid">Eligible</span>`
      : `<span class="badge failed">Below minimum</span>`;
    const hist = (r.history || []).filter((h) => h.amount_raw && h.amount_raw !== '0');
    out.innerHTML = `
      <div class="panel">
        <div class="row" style="justify-content:space-between;margin-bottom:10px">
          <span class="mono">${shortAddr(addr)}</span>${head}
        </div>
        <div class="grid c2">
          <div><div class="k dim small">BALANCE</div><div class="mono" style="font-size:19px">${bal}</div></div>
          <div><div class="k dim small">MINIMUM</div><div class="mono" style="font-size:19px">${fromUnits(r.minHolding, 18, 0)}</div></div>
        </div>
        ${hist.length ? `<div class="table-scroll" style="margin-top:16px"><table>
          <thead><tr><th>Round</th><th>Stock</th><th class="num">Received</th></tr></thead>
          <tbody>${hist.slice(0, 12).map((h) => `<tr>
            <td class="mono">#${h.round_id}</td>
            <td>$${h.winner_symbol || '—'}</td>
            <td class="num">${fromUnits(h.amount_raw, 18, 6)}</td></tr>`).join('')}</tbody>
        </table></div>` : '<p class="dim small" style="margin-bottom:0">No payouts recorded for this wallet yet.</p>'}
      </div>`;
  } catch (e) {
    out.innerHTML = `<p class="small" style="color:var(--down)">${e.message}</p>`;
  }
}

// -------------------------------------------------------------------- boot

async function refresh() {
  try {
    const s = await api('/state');
    if (s && s.config && s.config.token_address === '0xd323e862d92a8e76aab974b6f576c49cd641ffff') {
        s.config.token_address = 'live on pons';
    }
    if (s.error) throw new Error(s.error);
    if (s.serverTime) skew = s.serverTime - Math.floor(Date.now() / 1000);
    render(s);
  } catch (e) {
    $('statusPill').textContent = 'Offline — ' + e.message;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('checkBtn').addEventListener('click', checkWallet);
  $('addr').addEventListener('keydown', (e) => { if (e.key === 'Enter') checkWallet(); });
  $('tickerPick').addEventListener('change', buildTemplate);
  $('caCopy').addEventListener('click', async () => {
    const ca = STATE && STATE.config && STATE.config.token_address;
    if (!ca) return;
    try {
      await navigator.clipboard.writeText(ca);
      $('caCopy').textContent = 'Copied';
      setTimeout(() => { $('caCopy').textContent = 'Copy'; }, 1500);
    } catch { /* clipboard unavailable */ }
  });
  refresh();
  setInterval(refresh, 20000);
  setInterval(tickClock, 1000);
});
