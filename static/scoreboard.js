'use strict';
const ScoreboardUI = (() => {
  const views = new WeakMap();
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function mount(el) {
    el.innerHTML = `<p class="eyebrow">ОБЩИЙ СЧЁТ ЛОББИ</p><h2>Таблица счёта</h2><p class="small muted">Мирные +1 · Оборотни и миньон +2 · Кожевник +3<br>Команда определяется конечной ролью.</p><p class="score-round small" role="status" aria-live="polite"></p><div class="score-scale small muted"><span>0</span><span class="score-maximum"></span></div><div class="score-chart" role="list" aria-label="Гистограмма очков"></div>`;
    const view = {identity:`${state.code}:${state.me.id}`, rows:new Map(), signature:'', frame:0};
    views.set(el, view);
    return view;
  }
  function makeRow(id) {
    const el = document.createElement('div');
    el.className = 'score-row'; el.dataset.playerId = id; el.setAttribute('role','listitem');
    el.innerHTML = '<div class="score-label"><b></b><span><strong>0</strong> очк. <em></em></span></div><div class="score-track" aria-hidden="true"><div class="score-bar"></div></div>';
    return {el, bar:el.querySelector('.score-bar'), number:el.querySelector('strong'), score:0, width:0};
  }
  function paint(row, score, width) {
    row.score = score; row.width = width;
    row.number.textContent = Math.round(score);
    // CSSOM updates work with the app's strict CSP. Inline HTML style attributes do not.
    row.bar.style.width = `${width}%`;
  }
  function update(selector) {
    const el = document.querySelector(selector);
    if (!el) return;
    let view = views.get(el);
    if (!view || view.identity !== `${state.code}:${state.me.id}`) {
      if (view) cancelAnimationFrame(view.frame);
      view = mount(el);
    }
    const board = state.scoreboard;
    const players = [...board.players].sort((a,b) => b.score-a.score || a.name.localeCompare(b.name,'ru') || a.id.localeCompare(b.id));
    const signature = JSON.stringify([board.round, players]);
    if (view.signature === signature) return;
    const initial = !view.signature;
    view.signature = signature;
    cancelAnimationFrame(view.frame);
    const maximum = Math.max(1, ...players.map(p => p.score));
    const oldMaximum = Math.max(1, ...players.map(p => Math.max(0, p.score-p.points)));
    const chart = el.querySelector('.score-chart');
    el.querySelector('.score-round').textContent = board.round ? `Учтён раунд ${board.round}. Прибавка показана рядом с общим счётом.` : 'Первый раунд ещё не завершён.';
    el.querySelector('.score-maximum').textContent = `${maximum} очк.`;
    for (const [id,row] of view.rows) {
      if (!players.some(p => p.id === id)) { row.el.remove(); view.rows.delete(id); }
    }
    const changes = players.map((p,index) => {
      let row = view.rows.get(p.id);
      if (!row) {
        row = makeRow(p.id); view.rows.set(p.id,row);
        // Reopening the results also shows the gain in the just-completed round.
        if (initial && state.phase === 'results') {
          const before = Math.max(0,p.score-p.points);
          paint(row,before,before/oldMaximum*100);
        }
      }
      if (chart.children[index] !== row.el) chart.insertBefore(row.el,chart.children[index] || null);
      row.el.querySelector('b').textContent = p.name + (p.id === state.me.id ? ' · вы' : '');
      row.el.querySelector('em').textContent = `+${p.points}`;
      row.el.classList.toggle('score-you',p.id === state.me.id);
      row.el.setAttribute('aria-label',`${p.name}: ${p.score} очков, прибавка ${p.points}`);
      return {row, fromScore:row.score, fromWidth:row.width, score:p.score, width:p.score/maximum*100};
    });
    const started = performance.now();
    function step(now) {
      const progress = reducedMotion() ? 1 : Math.min(1,Math.max(0,(now-started)/1000));
      const eased = 1-Math.pow(1-progress,3);
      changes.forEach(c => paint(c.row,c.fromScore+(c.score-c.fromScore)*eased,c.fromWidth+(c.width-c.fromWidth)*eased));
      if (progress < 1) view.frame = requestAnimationFrame(step);
      else view.frame = 0;
    }
    if (reducedMotion()) step(started);
    else view.frame = requestAnimationFrame(step);
  }
  function render() {
    document.querySelector('#scoreboard-open').hidden = false;
    const panel = document.querySelector('#scoreboard-panel');
    panel.hidden = !['lobby','results'].includes(state.phase);
    if (!panel.hidden) update('#scoreboard-panel');
    if (document.querySelector('#scoreboard-dialog').open) update('#scoreboard-modal');
  }
  function open() {
    if (!state) return;
    const dialog = document.querySelector('#scoreboard-dialog');
    if (!dialog.open) dialog.showModal();
    render();
  }
  function leave() {
    document.querySelector('#scoreboard-open').hidden = true;
    document.querySelector('#scoreboard-dialog').close();
    for (const selector of ['#scoreboard-panel','#scoreboard-modal']) {
      const el = document.querySelector(selector), view = el && views.get(el);
      if (view) { cancelAnimationFrame(view.frame); views.delete(el); }
      if (el) el.innerHTML = '';
    }
  }
  document.querySelector('#scoreboard-open').addEventListener('click',open);
  document.querySelector('#scoreboard-close').addEventListener('click',() => document.querySelector('#scoreboard-dialog').close());
  return {render, open, leave};
})();
