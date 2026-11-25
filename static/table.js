'use strict';

// Only server-authorized, time-stamped observations can turn a card face up.
const TableUI = (() => {
  let stage = '', identity = '', roster = '', selected = [], ownOpen = false, hidden = false;
  let pendingSwap = null, pendingFocus = [], moving = new Set(), animations = [], generation = 0;
  const seen = new Set();
  const keyOf = id => `player:${id}`;
  const elementFor = key => [...document.querySelectorAll('.table-card')].find(el => el.dataset.card === key);
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function receive(next) {
    const who = `${next.code}:${next.me.id}`;
    const changedPlayer = identity !== who;
    if (changedPlayer) { identity = who; roster = ''; seen.clear(); }
    if (changedPlayer || stage !== next.stage) {
      stage = next.stage; selected = []; ownOpen = false; hidden = false;
      pendingSwap = null; pendingFocus = []; moving.clear(); generation++;
      animations.forEach(a => a.cancel()); animations = [];
      document.querySelector('#card-dialog')?.close();
    }
    for (const note of next.me.notes) {
      const id = `${who}:${note.id}`;
      if (!seen.has(id)) {
        seen.add(id);
        if (note.stage === next.stage) {
          if (note.swap?.length === 2) pendingSwap = note.swap;
          if (note.cards?.length) pendingFocus = note.cards.map(c => c.key);
        }
      }
    }
    if (next.me.action_done || next.me.vote) selected = [];
  }

  function cardMarkup(key, title) {
    return `<button class="table-card" type="button" data-card="${esc(key)}" aria-label="${esc(title)}" aria-pressed="false"><span class="card-inner"><span class="card-side card-reverse"><span class="card-corner">✦</span><span class="card-moon">☾</span><span class="card-ornament">✧ ─ ✦ ─ ✧</span><span class="card-signature">ONE NIGHT<br>WEREWOLF</span></span><span class="card-side card-face"></span></span><span class="selection-number" aria-hidden="true"></span></button>`;
  }

  function build() {
    const s = state, meIndex = s.players.findIndex(p => p.id === s.me.id);
    const players = [...s.players.slice(meIndex), ...s.players.slice(0, meIndex)];
    const key = `${s.code}:${players.map(p => p.id + p.name).join('|')}`;
    if (roster === key && document.querySelector('.board-canvas')) return;
    roster = key;
    document.querySelector('#table-panel').innerHTML = `${AtmosphereUI.sceneMarkup()}<div class="table-heading"><div><p class="eyebrow">ОДНА ДЕРЕВНЯ. МНОГО СЕКРЕТОВ.</p><h2>За одним столом</h2></div><span class="table-privacy">◈ Ваш личный вид</span></div><div id="table-instruction" class="table-instruction"></div><p class="table-scroll-hint">↔ Стол можно прокручивать влево и вправо</p><div class="board-viewport" tabindex="0" aria-label="Игровой стол. На узком экране прокручивается по горизонтали"><div class="board-canvas ${players.length >= 8 ? 'dense-table' : ''}"><div class="table-felt" aria-hidden="true"><div class="felt-ring"></div><div class="ritual-seal"></div></div><div class="table-candles" aria-hidden="true">${Array.from({length:4}, () => '<span class="candle-group"><i></i><i></i><i></i></span>').join('')}</div><div class="table-center"><span class="center-caption">ТРИ ТАЙНЫ В ЦЕНТРЕ</span><div class="table-center-cards">${[0,1,2].map(i => `<div class="center-place">${cardMarkup(`center:${i}`, `Карта центра ${i+1}`)}<span class="center-number">${['I','II','III'][i]}</span></div>`).join('')}</div><span class="center-footer">ONE NIGHT · WEREWOLF</span></div>${players.map((p,i) => `<div class="table-seat ${p.id === s.me.id ? 'your-seat' : ''}" data-player="${p.id}" data-seat-index="${i}"><span class="seat-name"><span class="seat-online"></span><b>${esc(p.name)}</b>${p.id === s.me.id ? '<small>ВЫ</small>' : ''}</span>${cardMarkup(keyOf(p.id), `Карта игрока ${p.name}`)}<span class="seat-state"></span></div>`).join('')}</div></div><div id="table-action" class="table-action" aria-live="polite"></div>`;
    for (const seat of document.querySelectorAll('.table-seat')) {
      const angle = Number(seat.dataset.seatIndex) * Math.PI * 2 / players.length;
      seat.style.left = `${50 + Math.sin(angle) * 40}%`;
      seat.style.top = `${50 + Math.cos(angle) * (players.length >= 8 ? 37 : 34)}%`;
    }
    const viewport = document.querySelector('.board-viewport');
    viewport.scrollLeft = (viewport.scrollWidth - viewport.clientWidth) / 2;
  }

  function observations() {
    const faces = new Map();
    if (state.phase === 'results') {
      state.result.players.forEach(p => faces.set(keyOf(p.id), p.role));
      state.result.center.forEach((r,i) => faces.set(`center:${i}`, r));
    } else if (state.phase === 'reveal' && ownOpen) {
      faces.set(keyOf(state.me.id), state.me.original);
    } else if (state.phase === 'night' && !hidden) {
      state.me.notes.filter(n => n.stage === state.stage).forEach(n => (n.cards || []).forEach(c => faces.set(c.key, c.role)));
    }
    return faces;
  }

  function selectable(key) {
    const isPlayer = key.startsWith('player:'), own = key === keyOf(state.me.id);
    if (state.phase === 'voting') return !state.me.vote && isPlayer && !own;
    if (state.phase !== 'night' || !state.me.action) return false;
    switch (state.me.action) {
      case 'seer': return !own;
      case 'robber': case 'troublemaker': return isPlayer && !own;
      case 'werewolf': case 'drunk': return !isPlayer;
      default: return false;
    }
  }

  function selectionName(key) {
    return key.startsWith('center:') ? `центр ${Number(key.split(':')[1])+1}` : state.players.find(p => keyOf(p.id) === key)?.name || '';
  }

  function payload() {
    if (!selected.length) return null;
    const targets = selected.filter(k => k.startsWith('player:')).map(k => k.slice(7));
    const center = selected.filter(k => k.startsWith('center:')).map(k => Number(k.slice(7)));
    const role = state.me.action;
    if (state.phase === 'voting') return targets.length === 1 ? {target:targets[0]} : null;
    if (role === 'troublemaker' && targets.length !== 2) return null;
    if (role === 'seer' && center.length && center.length !== 2) return null;
    return {mode:center.length ? 'center' : role === 'troublemaker' ? 'players' : 'player', targets, center};
  }

  function instruction() {
    const s = state;
    if (s.phase === 'lobby') return 'Места заняты. Карты будут розданы в начале раунда.';
    if (s.phase === 'reveal') return 'Нажмите на свою карту внизу стола. Запомните роль и подтвердите готовность.';
    if (s.phase === 'results') return 'Наступило утро. Все карты раскрыты — нажмите на любую, чтобы рассмотреть.';
    if (s.phase === 'discussion') return 'Карты закрыты. Ваша начальная роль и ночные наблюдения сохранены в личных заметках.';
    if (s.phase === 'voting') return s.me.vote ? 'Ваш голос сохранён. Ждём остальных игроков.' : 'Нажмите на карту подозреваемого и подтвердите свой голос.';
    const help = {seer:'Нажмите на карту другого игрока или выберите две карты центра.', robber:'Выберите другого игрока: ваша карта поменяется с его картой.', troublemaker:'Выберите двух других игроков: их карты поменяются местами вслепую.', drunk:'Выберите карту центра для обмена со своей. Новую роль вы не увидите.', werewolf:'Вы единственный оборотень. Выберите одну карту центра для просмотра.'};
    return help[s.me.action] || (s.me.original === s.night_role ? 'Здесь видны только разрешённые вам сведения этого этапа.' : 'Деревня спит. Чужие ночные действия на вашем экране не отображаются.');
  }

  function renderAction() {
    const s = state, hasTurn = s.phase === 'voting' ? !s.me.vote : Boolean(s.me.action);
    let html = '';
    if (hasTurn) {
      const label = s.phase === 'voting' ? 'Подтвердить голос' : ['robber','troublemaker','drunk'].includes(s.me.action) ? 'Поменять карты' : 'Посмотреть карты';
      html = `<div class="selection-summary"><span class="eyebrow">${s.phase === 'voting' ? 'ВАШ ВЫБОР' : 'ВАШ НОЧНОЙ ХОД'}</span><b>${selected.length ? selected.map(k => esc(selectionName(k))).join(' + ') : 'Выберите подсвеченные карты на столе'}</b></div><div class="table-action-buttons"><button class="primary" data-table-action="confirm" ${!payload() || busy || moving.size ? 'disabled' : ''}>${label}</button>${selected.length ? '<button class="quiet" data-table-action="clear">Отменить выбор</button>' : ''}${s.phase === 'night' && s.me.action !== 'drunk' ? '<button class="quiet" data-do="skip">Пропустить ход</button>' : ''}</div>`;
    } else if (s.phase === 'night' && s.me.notes.some(n => n.stage === s.stage)) {
      const notes = s.me.notes.filter(n => n.stage === s.stage);
      html = `<div class="table-observation"><span class="eyebrow">ТОЛЬКО ДЛЯ ВАС · НА МОМЕНТ ДЕЙСТВИЯ</span>${hidden ? '<p>Сведения скрыты.</p>' : notes.map(n => `<p>${esc(n.text)}</p>`).join('')}<button class="quiet" data-table-action="hide">${hidden ? 'Показать сведения' : 'Скрыть сведения и карты'}</button></div>`;
    } else {
      html = `<span class="small muted">${s.phase === 'reveal' ? 'Свою карту можно открыть и снова закрыть. Другие игроки её не увидят.' : s.phase === 'results' ? 'На столе показаны конечные роли.' : 'Каждая карта хранит свой секрет. У каждого игрока — собственный вид стола.'}</span>`;
    }
    setHtml('#table-action', html);
  }

  function render() {
    if (!state || !document.querySelector('#table-panel')) return;
    build();
    document.querySelector('#table-instruction').textContent = instruction();
    if (pendingSwap) pendingSwap.forEach(k => moving.add(k));
    const faces = observations();
    for (const card of document.querySelectorAll('.table-card')) {
      const key = card.dataset.card, role = faces.get(key), canSelect = selectable(key);
      const index = selected.indexOf(key);
      const initial = state.phase === 'reveal' && key === keyOf(state.me.id);
      card.classList.toggle('is-open', Boolean(role) && !moving.has(key));
      card.classList.toggle('can-select', canSelect);
      card.classList.toggle('is-selected', index !== -1);
      card.classList.toggle('is-moving', moving.has(key));
      card.classList.toggle('your-vote', state.phase === 'voting' && state.me.vote && key === keyOf(state.me.vote));
      const outcome = state.phase === 'results' ? state.result.players.find(p => keyOf(p.id) === key) : null;
      card.classList.toggle('is-dead', Boolean(outcome?.dead));
      card.title = outcome?.dead ? (outcome.hunter_victim ? 'Выбыл: выстрел охотника' : 'Выбыл по голосованию') : '';
      card.disabled = !canSelect && !role && !initial;
      card.setAttribute('aria-pressed', String(index !== -1));
      const face = card.querySelector('.card-face');
      // Only tint information this client is allowed to see. Clear it when closed.
      face.classList.toggle('role-surface', Boolean(role));
      if (role) face.dataset.team = catalog[role].team;
      else delete face.dataset.team;
      const html = role ? `<span class="face-team ${esc(catalog[role].team)}">${esc(teams[catalog[role].team])}</span>${roleIcon(role)}<b>${roleLabel(role)}</b><small>${state.phase === 'results' ? 'КОНЕЧНАЯ РОЛЬ' : initial ? 'НАЧАЛЬНАЯ РОЛЬ' : 'ВАШЕ НАБЛЮДЕНИЕ'}</small>` : '';
      if (face._html !== html) { face.innerHTML = html; face._html = html; }
      card.querySelector('.selection-number').textContent = index === -1 ? '' : index + 1;
      const name = selectionName(key);
      card.setAttribute('aria-label', `Карта: ${name}${outcome?.dead ? '. Выбыл' + (outcome.hunter_victim ? ': выстрел охотника' : ': голосование') : ''}${initial && !ownOpen ? '. Открыть свою начальную роль' : role ? `. ${catalog[role].name}` : canSelect ? '. Выбрать' : '. Закрыта'}`);
    }
    for (const seat of document.querySelectorAll('.table-seat')) {
      const p = state.players.find(p => p.id === seat.dataset.player);
      seat.querySelector('.seat-online').classList.toggle('away', !p.online);
      const result = state.result?.players.find(x => x.id === p.id);
      seat.querySelector('.seat-state').textContent = result ? result.dead ? '' : 'Выжил' : p.ready ? '✓ Готов' : p.id === state.me.id ? 'Ваше место' : p.host ? 'Создатель' : '';
    }
    renderAction();
    if (pendingSwap) { const pair = pendingSwap; pendingSwap = null; animateSwap(pair); }
    else if (pendingFocus.length && !moving.size) {
      const cards = pendingFocus.map(elementFor).filter(Boolean); pendingFocus = [];
      const viewport = document.querySelector('.board-viewport');
      if (cards.length && viewport.scrollWidth > viewport.clientWidth) {
        const middle = cards.reduce((sum, c) => { const r = c.getBoundingClientRect(); return sum + r.left + r.width/2; }, 0) / cards.length;
        viewport.scrollTo({left:viewport.scrollLeft + middle - viewport.getBoundingClientRect().left - viewport.clientWidth/2, behavior:reducedMotion() ? 'instant' : 'smooth'});
      }
    }
  }

  async function animateSwap(pair) {
    const version = generation, cards = pair.map(elementFor);
    if (cards.some(c => !c) || reducedMotion()) { moving.clear(); render(); return; }
    const bounds = cards.map(c => c.getBoundingClientRect());
    animations = cards.map((c,i) => {
      const a = bounds[i], b = bounds[1-i], dx = b.left - a.left, dy = b.top - a.top;
      return c.animate([{transform:'translate(0,0) rotate(0deg)'}, {transform:`translate(${dx/2}px,${dy/2 - 30}px) rotate(${i ? 12 : -12}deg)`, offset:0.5}, {transform:`translate(${dx}px,${dy}px) rotate(0deg)`}], {duration:900, easing:'ease-in-out', fill:'forwards'});
    });
    try { await Promise.all(animations.map(a => a.finished)); } catch (_) { return; }
    if (version !== generation) return;
    animations.forEach(a => a.cancel()); animations = []; moving.clear(); render();
  }

  function choose(key) {
    if (busy || moving.size) return;
    if (state.phase === 'reveal' && key === keyOf(state.me.id)) { ownOpen = !ownOpen; render(); return; }
    if (!selectable(key)) {
      const role = observations().get(key);
      if (role) showCard(role, selectionName(key));
      return;
    }
    if (selected.includes(key)) selected = selected.filter(k => k !== key);
    else {
      const sameKind = selected[0]?.split(':')[0] === key.split(':')[0];
      const limit = state.me.action === 'troublemaker' || (state.me.action === 'seer' && key.startsWith('center:')) ? 2 : 1;
      if (limit === 1 || !sameKind) selected = [key];
      else if (selected.length < limit) selected.push(key);
      else { toast('Уже выбраны две карты. Снимите выбор с одной из них.'); return; }
    }
    render();
  }

  function showCard(role, name) {
    let dialog = document.querySelector('#card-dialog');
    if (!dialog) {
      dialog = document.createElement('dialog'); dialog.id = 'card-dialog';
      dialog.setAttribute('aria-label','Просмотр карты'); document.body.append(dialog);
    }
    dialog.innerHTML = `<button class="dialog-close quiet" data-table-action="close" aria-label="Закрыть карту">✕</button><p class="eyebrow">${esc(name)}</p><div class="large-role role-surface" data-team="${roleTeam(role)}">${roleIcon(role)}<h2>${roleLabel(role)}</h2><span class="pill">${esc(teams[catalog[role].team])}</span></div><p class="muted">${esc(catalog[role].description)}</p><p class="small muted">${state.phase === 'results' ? 'Конечная роль после всех обменов.' : 'Роль на момент вашего просмотра. Позже карта могла измениться.'}</p>`;
    dialog.showModal();
  }

  document.addEventListener('click', async event => {
    if (!state) return;
    const card = event.target.closest('[data-card]');
    if (card) { choose(card.dataset.card); return; }
    const action = event.target.closest('[data-table-action]')?.dataset.tableAction;
    if (action === 'close') { document.querySelector('#card-dialog')?.close(); return; }
    if (action === 'hide') { hidden = !hidden; render(); }
    if (action === 'clear') { selected = []; render(); }
    if (action === 'confirm' && !busy && !moving.size) {
      const data = payload(); if (!data) return;
      const voting = state.phase === 'voting';
      const promise = voting
        ? confirmCommand('vote', data, {title:'Подтвердить голос?', message:`Вы выбираете «${selectionName(selected[0])}». Изменить голос будет нельзя.`, confirmLabel:'Проголосовать'})
        : command('night_action', data);
      renderAction(); await promise; render();
    }
  });
  return {receive, render};
})();
