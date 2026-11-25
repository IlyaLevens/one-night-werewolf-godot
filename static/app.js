'use strict';

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const teams = {village:'Деревня', wolves:'Оборотни', tanner:'Кожевник'};
const phases = {lobby:'Собираемся', reveal:'Знакомство с ролью', night:'Ночь', discussion:'Обсуждение', voting:'Голосование', results:'Рассвет всё объяснил'};
let catalog = {}, session = null, state = null, screen = '', privateOpen = false, busy = false;
let phaseKey = '', clockOffset = 0, toastTimer;
try { session = JSON.parse(sessionStorage.getItem('onw-session') || 'null'); } catch (_) { /* повреждённая сессия */ }

function toast(message) {
  $('#toast').textContent = message; $('#toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 5500);
}
function setHtml(selector, html) {
  const element = $(selector);
  if (element && element._render !== html) { element.innerHTML = html; element._render = html; }
}
function roleLabel(id) { return esc(catalog[id]?.name || id); }
function roleIcon(id) { return catalog[id] ? `<img class="role-image" src="/static/icons/${esc(id)}.png" alt="" width="100" height="100">` : '☾'; }
function roleTeam(id) { return esc(catalog[id]?.team || ''); }
function saveSession(value) {
  session = value;
  if (value) sessionStorage.setItem('onw-session', JSON.stringify(value));
  else sessionStorage.removeItem('onw-session');
}
async function api(path, data, token = session?.token) {
  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(path, {method:data === undefined ? 'GET' : 'POST',
      headers:{...(data === undefined ? {} : {'Content-Type':'application/json'}), ...(token ? {Authorization:`Bearer ${token}`} : {})},
      body:data === undefined ? undefined : JSON.stringify(data), signal:controller.signal, cache:'no-store'});
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.error || 'Ошибка сервера'); error.status = response.status; throw error; }
    result._request_ms = performance.now() - started;
    return result;
  } catch (error) {
    if (error.name === 'AbortError' || error instanceof TypeError) throw new Error('Нет связи с сервером. Проверьте подключение.');
    throw error;
  } finally { clearTimeout(timeout); }
}
function accept(next) {
  if (state && next.code === state.code && next.server_time < state.server_time) return;
  TableUI.receive(next);
  state = next; clockOffset = next.server_time * 1000 - Date.now();
  MusicUI.receive(next);
  if (phaseKey !== next.stage) { phaseKey = next.stage; privateOpen = false; }
  $('#connection').textContent = '● Подключено'; $('#connection').classList.remove('offline');
  render();
  DialogUI.receive(next);
  TurnUI.receive(next);
  updateTimer();
}
async function command(action, data = {}) {
  if (busy || !session) return false;
  busy = true;
  try {
    const result = await api(`/api/rooms/${session.code}/${action}`, {...data, stage:state.stage});
    if (action === 'leave') { saveSession(null); state = null; renderLanding(); }
    else accept(result);
    return true;
  } catch (error) { toast(error.message); return false; }
  finally { busy = false; }
}
async function confirmCommand(action, data, options) {
  if (busy || !state || !session) return;
  const context = DialogUI.key(state);
  const valid = next => !data.target || next.players.some(p => p.id === data.target);
  if (await DialogUI.ask({...options, valid}) && DialogUI.key(state) === context && valid(state)) {
    await command(action, data);
  }
}
async function poll() {
  const current = session;
  try {
    if (current) {
      const next = await api(`/api/rooms/${current.code}`, undefined, current.token);
      if (session === current) accept(next);
    }
  } catch (error) {
    if (session !== current) return;
    $('#connection').textContent = '● Переподключение…'; $('#connection').classList.add('offline');
    if (error.status === 401 || error.status === 404) {
      saveSession(null); state = null; renderLanding(); toast(error.message);
    }
  } finally { setTimeout(poll, 1000); }
}

function renderLanding() {
  AtmosphereUI.render('lobby');
  MusicUI.leave();
  ScoreboardUI.leave();
  DialogUI.dismiss();
  TurnUI.leave();
  screen = 'landing'; phaseKey = ''; privateOpen = false;
  const invite = new URLSearchParams(location.search).get('room') || '';
  $('#app').innerHTML = `
  <section class="landing">
    <div class="hero-copy"><p class="eyebrow"><span class="small-line"></span> ВЕЧЕР В КОМПАНИИ ДРУЗЕЙ</p>
      <h1>Одна ночь.<br>У каждого<br>своя правда.</h1>
      <p class="hero-description">Деревня засыпает, роли меняются.<br>Кому вы поверите, когда наступит утро?</p>
      <div class="hero-facts"><span><b>3–10</b> игроков</span><span><b>5–10</b> минут</span></div>
      <div class="table-art" aria-hidden="true"><div class="orbit"></div><div class="art-card first">✦<span>ТАЙНА</span></div><div class="art-card middle">☾<span>ОДНА НОЧЬ</span></div><div class="art-card last">✧<span>БЛЕФ</span></div></div>
    </div>
    <section class="entrance panel"><p class="eyebrow">ВАШЕ МЕСТО ЗА СТОЛОМ</p><h2>Соберите свою деревню</h2><p class="muted">Создайте лобби или присоединитесь к друзьям.</p>
      <form id="entry-form"><label for="nickname">Как вас зовут?</label><input id="nickname" name="name" autocomplete="nickname" maxlength="24" placeholder="Имя или прозвище" required>
        <button class="primary wide" type="submit" name="entry" value="create">Создать лобби <span>→</span></button>
        <div class="divider"><span>ИЛИ ПО КОДУ ПРИГЛАШЕНИЯ</span></div>
        <label for="room-code">Код лобби</label><div class="join-row"><input id="room-code" name="code" maxlength="6" autocomplete="off" placeholder="ABC123" value="${esc(invite.toUpperCase().slice(0,6))}"><button class="secondary" type="submit" name="entry" value="join">Войти →</button></div>
      </form>
      <p class="entry-hint">✧ Друзьям нужен только браузер.<br>У каждого игрока — собственный экран.</p>
      <details class="recovery"><summary>Восстановить вход по личному ключу</summary><form id="recover-form"><label>Код лобби<input name="code" maxlength="6" required></label><label>Личный ключ<input name="token" type="password" autocomplete="off" required></label><button class="secondary" type="submit">Восстановить</button></form></details>
    </section>
  </section>`;
  $('#connection').textContent = 'Вечер начинается';
}

function makeGameShell() {
  screen = 'game';
  $('#app').innerHTML = `
    <section class="room-heading"><div><p class="eyebrow">ВАША ДЕРЕВНЯ</p><h1 class="room-title">Лобби <span id="lobby-code"></span></h1></div><div class="room-tools"><button class="secondary" data-do="invite">Пригласить друзей ↗</button><button class="quiet" data-do="recovery">Личный ключ</button><button class="quiet" data-do="leave">Выйти</button></div></section>
    <div id="phase-banner" class="phase-banner"></div>
    <section id="table-panel" class="panel table-panel" aria-label="Интерактивный игровой стол"></section>
    <div class="game-grid"><aside class="sidebar"><section class="panel players-panel"><div class="section-heading"><h3>За столом</h3><span id="player-count" class="pill"></span></div><div id="players"></div><div id="host-claim"></div></section><section id="private-panel" class="panel private-panel"></section><section class="panel deck-panel"><h3>Карты этой ночи</h3><div id="deck"></div><p class="small muted">Всего игроков + 3 карты центра</p></section></aside>
      <section class="main-column"><section id="scoreboard-panel" class="panel" aria-label="Общий счёт"></section><div id="stage-content"></div><section class="panel chat-panel"><div class="section-heading"><h3>Разговор у костра</h3><span id="chat-status" class="small muted"></span></div><div id="chat-messages" class="chat-messages" role="log" aria-live="polite"></div><form id="chat-form"><input id="chat-input" name="message" maxlength="500" autocomplete="off" placeholder="Напишите друзьям…" required aria-label="Сообщение"><button class="secondary" type="submit" aria-label="Отправить сообщение">↑</button></form></section><div id="host-controls" class="host-controls"></div></section></div>`;
}

function render() {
  if (!state) return;
  if (screen !== 'game') makeGameShell();
  const s = state, me = s.me, host = s.host === me.id;
  $('#lobby-code').textContent = s.code; $('#player-count').textContent = `${s.players.length} / 10`;
  const subtitle = s.phase === 'night' ? `${roleLabel(s.night_role)} · этап ${s.night_steps.indexOf(s.night_role)+1} из ${s.night_steps.length}` :
    s.phase === 'lobby' ? 'Все на месте? Отметьте готовность.' : s.phase === 'discussion' ? 'Расскажите свою версию. Правду говорить необязательно.' :
    s.phase === 'reveal' ? 'Посмотрите личную карту и подтвердите, что запомнили её.' : s.phase === 'voting' ? `Голоса скрыты до финала · принято ${s.voted_count} из ${s.players.length}` : `Раунд ${s.round} завершён`;
  setHtml('#phase-banner', `<div class="phase-symbol">${AtmosphereUI.symbol(s.phase)}</div><div><p class="eyebrow">${s.round ? `РАУНД ${s.round}` : 'ДО НАЧАЛА ИГРЫ'}</p><h2>${phases[s.phase]}</h2><p>${subtitle}</p></div><div class="timer" id="timer" aria-label="Осталось времени"></div>`);
  setHtml('#players', s.players.map((p,i) => `<div class="player-row"><div class="avatar a${i%4}">${esc(p.name.slice(0,1).toUpperCase())}</div><div class="player-name"><b>${esc(p.name)} ${p.id===me.id?'<span class="small muted">· вы</span>':''}</b><span class="small muted">${p.host?'Создатель лобби':p.online?'В сети':'Нет связи'}</span></div>${p.ready?'<span class="ready-check" title="Готов">✓</span>':`<span class="status-dot ${p.online?'':'away'}"></span>`}${host && p.id!==me.id && ['lobby','results'].includes(s.phase)?`<button class="kick quiet" data-do="kick" data-target="${p.id}" aria-label="Исключить ${esc(p.name)}">×</button>`:''}</div>`).join(''));
  setHtml('#host-claim', s.can_claim_host && !host ? '<button class="secondary wide" data-do="claim_host">Стать создателем лобби</button>' : '');
  renderPrivate();
  TableUI.render();
  AtmosphereUI.render(s.phase);
  const counts = s.deck.reduce((acc,r)=>(acc[r]=(acc[r]||0)+1,acc),{});
  setHtml('#deck',Object.entries(counts).map(([r,n])=>`<span class="role-chip role-surface" data-team="${roleTeam(r)}" title="${esc(catalog[r].description)}">${roleIcon(r)} ${roleLabel(r)}${n>1?` <b>×${n}</b>`:''}</span>`).join(''));
  let html = '';
  if (s.phase === 'lobby') html = lobbyContent(host);
  if (s.phase === 'reveal') html = `<section class="panel stage-panel"><p class="eyebrow">ТИХО. ЭТО ВАШ СЕКРЕТ.</p><h2>Узнайте свою роль</h2><p class="muted">Нажмите на свою карту внизу круглого стола. Когда запомните роль, подтвердите готовность. Ночь начнётся после всех подтверждений или через 90 секунд.</p><button class="primary" data-do="ready" ${me.ready?'disabled':''}>${me.ready?'✓ Роль запомнена':'Я запомнил свою роль'}</button><p class="small muted">Не показывайте карту другим игрокам.</p></section>`;
  if (s.phase === 'night') html = nightContent();
  if (s.phase === 'discussion') html = `<section class="panel stage-panel"><p class="eyebrow">ДЕРЕВНЯ ПРОСНУЛАСЬ</p><h2>Кто был кем?<br>И кто есть кто?</h2><p class="muted">Ночью карты могли поменяться. Расскажите о своих действиях, сопоставьте чужие версии или придумайте убедительную легенду.</p><div class="tip">Если считаете, что оборотней нет у игроков, договоритесь голосовать по кругу: при одном голосе на каждого казни не будет.</div>${host?'<button class="primary" data-do="begin_vote">Перейти к голосованию →</button>':'<p class="small muted">Голосование начнётся по таймеру или по решению создателя лобби.</p>'}</section>`;
  if (s.phase === 'voting') html = voteContent();
  if (s.phase === 'results') html = resultContent();
  setHtml('#stage-content', html);
  ScoreboardUI.render();
  const chatEnabled = ['lobby','discussion','results'].includes(s.phase);
  $('#chat-input').disabled = !chatEnabled;
  $('#chat-form button').disabled = !chatEnabled;
  $('#chat-input').placeholder = chatEnabled ? 'Напишите друзьям…' : 'Чат откроется после этой фазы';
  $('#chat-status').textContent = chatEnabled ? 'Общий чат' : 'Тишина за столом';
  const messages = $('#chat-messages'), wasAtBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 60;
  setHtml('#chat-messages', s.chat.length ? s.chat.map(m=>`<div class="chat-message"><b>${esc(m.name)}</b><p>${esc(m.text)}</p></div>`).join('') : '<p class="chat-empty">Здесь начинается ваша общая история.</p>');
  if (wasAtBottom) messages.scrollTop = messages.scrollHeight;
  setHtml('#host-controls', host && !['lobby','results'].includes(s.phase)?'<button class="quiet" data-do="reset">Отменить текущий раунд</button>':'');
}

function renderPrivate() {
  const me = state.me;
  if (!me.original) { setHtml('#private-panel','<div class="sleeping-moon">☾</div><h3>Ваша роль пока в тени</h3><p class="small muted">После начала игры только вы увидите свою карту.</p>'); return; }
  setHtml('#private-panel', `<div class="section-heading"><p class="eyebrow">ЛИЧНАЯ КАРТА</p><button class="quiet small" data-do="private">${privateOpen?'Скрыть':'Открыть'}</button></div>${privateOpen?`<div class="private-role role-surface" data-team="${roleTeam(me.original)}"><span class="pill">${esc(teams[catalog[me.original].team])}</span><div class="role-icon">${roleIcon(me.original)}</div><h2>${roleLabel(me.original)}</h2><p class="small muted">${esc(catalog[me.original].description)}</p><span class="small">НАЧАЛЬНАЯ РОЛЬ</span></div><p class="small muted">Текущая карта может быть другой.</p><div class="private-notes"><h3>Что вы знаете</h3>${me.notes.length?me.notes.map(n=>`<div class="memory-note"><p>${esc(n.text)}</p>${(n.cards || []).map(c=>`<span class="memory-card role-surface" data-team="${roleTeam(c.role)}">${roleIcon(c.role)} ${roleLabel(c.role)}</span>`).join('')}</div>`).join(''):'<p class="muted">Ночные события появятся здесь.</p>'}</div>`:'<button class="card-back" data-do="private" aria-label="Открыть личную карту"><span>☾</span><small>НАЖМИТЕ, ЧТОБЫ ОТКРЫТЬ</small></button>'}`);
}
function lobbyContent(host) {
  const s = state, ready = s.players.filter(p=>p.ready).length;
  return `<section class="panel stage-panel"><p class="eyebrow">ПЕРЕД ПЕРВОЙ НОЧЬЮ</p><h2>Все ли собрались?</h2><p class="muted">Пригласите друзей, выберите роли и отметьте готовность. Каждый играет со своего телефона или компьютера.</p><div class="lobby-actions"><button class="${s.me.ready?'secondary':'primary'}" data-do="ready">${s.me.ready?'✓ Вы готовы · отменить':'Я готов играть'}</button>${host?`<button class="primary" data-do="start" ${s.players.length<3 || ready!==s.players.length?'disabled':''}>Начать игру →</button>`:''}<span class="small muted">Готовы ${ready} из ${s.players.length}</span></div></section>
    ${host?`<section class="panel settings-panel"><div class="section-heading"><div><p class="eyebrow">ПРАВИЛА ВАШЕГО СТОЛА</p><h3>Настройки раунда</h3></div><span class="pill">${s.custom_deck?'Своя колода':'Автоподбор'}</span></div><form id="settings-form"><div class="time-settings"><label>Ход ночью, сек.<input type="number" name="night_seconds" min="10" max="60" value="${s.settings.night_seconds}" required></label><label>Обсуждение, сек.<input type="number" name="discussion_seconds" min="30" max="900" value="${s.settings.discussion_seconds}" required></label><label>Голосование, сек.<input type="number" name="vote_seconds" min="15" max="180" value="${s.settings.vote_seconds}" required></label></div><details class="deck-editor"><summary>Выбрать роли вручную · нужно ${Math.max(3,s.players.length)+3} карт</summary><div class="role-settings">${Object.entries(catalog).map(([id,r])=>`<label title="${esc(r.description)}"><span>${roleIcon(id)} ${esc(r.name)}</span><select name="role_${id}" aria-label="Количество: ${esc(r.name)}">${(id==='mason'?[0,2]:Array.from({length:r.limit+1},(_,i)=>i)).map(n=>`<option value="${n}" ${s.deck.filter(x=>x===id).length===n?'selected':''}>${n}</option>`).join('')}</select></label>`).join('')}</div></details><div class="settings-actions"><button type="submit" class="secondary" name="preset" value="auto">Сохранить с автоподбором</button><button type="submit" class="quiet" name="preset" value="custom">Сохранить свою колоду</button></div><p class="small muted">Изменение настроек сбрасывает готовность. Автоподбор учитывает новых игроков.</p></form></section>`:'<section class="panel stage-panel"><h3>Стол готовит создатель лобби</h3><p class="muted">Выбранные роли видны слева. После изменения состава игроков или настроек нужно снова отметить готовность.</p></section>'}`;
}
function nightContent() {
  const s = state;
  return `<section class="panel stage-panel night-panel"><div class="night-progress">${s.night_steps.map((r,i)=>`<span class="${r===s.night_role?'active':i<s.night_steps.indexOf(s.night_role)?'done':''}" title="${esc(catalog[r].name)}">${roleIcon(r)}</span>`).join('')}</div><p class="eyebrow">${s.me.action?'ВАША ОЧЕРЕДЬ':'НОЧЬ ПРОДОЛЖАЕТСЯ'}</p><h2>${s.me.action ? roleLabel(s.me.action) : s.me.action_done ? 'Действие сохранено' : 'Деревня спит'}</h2><p class="muted">${s.me.action ? 'Выберите подсвеченные карты на круглом столе выше и подтвердите действие.' : 'Разрешённые вам сведения появляются на столе и сохраняются в личных заметках.'}</p><p class="small muted">Все этапы длятся одинаковое время, даже если роль находится в центре. Ночные обмены видит только действующий игрок.</p></section>`;
}
function voteContent() {
  const me = state.me;
  return `<section class="panel stage-panel"><p class="eyebrow">ОДИН ГОЛОС МОЖЕТ ИЗМЕНИТЬ ВСЁ</p><h2>${me.vote?'Ваш голос учтён':'Кого вы подозреваете?'}</h2><p class="muted">${me.vote ? `Вы выбрали: <b>${esc(state.players.find(p=>p.id===me.vote)?.name)}</b>. Ждём остальные голоса или окончания таймера.` : 'Выберите карту другого игрока на круглом столе выше и подтвердите голос. Изменить его после подтверждения нельзя.'}</p></section>`;
}
function resultContent() {
  const r = state.result;
  const byId = Object.fromEntries(r.players.map(p=>[p.id,p.name]));
  return `<section class="panel stage-panel results-panel"><p class="eyebrow">ВСЕ КАРТЫ НА СТОЛ</p><h2>${r.teams.length?'Победа: '+r.teams.map(t=>teams[t]).join(' и '):'Никто не победил'}</h2>${r.reasons.map(t=>`<p class="muted">${esc(t)}</p>`).join('')}<div class="results-list">${r.players.map(p=>`<article class="result-row ${p.won?'won':''}"><div class="result-icon role-surface ${p.dead?'is-dead':''}" data-team="${roleTeam(p.role)}">${roleIcon(p.role)}</div><div class="result-person"><b>${esc(p.name)} ${p.won?'<span class="winner-mark">✦</span>':''}</b><span>${roleLabel(p.role)}</span><small class="muted">В начале: ${roleLabel(p.original)}<br>Голос: ${esc(byId[p.vote] || 'не подан')}</small></div><div class="result-verdict"><b>${p.votes} гол.</b><span>+${p.points} очк.</span><span class="${p.dead?'dead':'survived'}">${p.dead?'Погиб':'Выжил'}</span>${p.hunter_victim?'<small>Выстрел охотника</small>':''}</div></article>`).join('')}</div><h3>Центр после ночи</h3><div class="result-center">${r.center.map((role,i)=>`<div class="role-surface" data-team="${roleTeam(role)}"><small>КАРТА ${i+1}</small><span>${roleIcon(role)}</span><b>${roleLabel(role)}</b><small>Было: ${roleLabel(r.original_center[i])}</small></div>`).join('')}</div><details class="night-history"><summary>Восстановить события ночи</summary>${r.history.length?r.history.map(h=>`<p><b>${esc(h.name)}:</b> ${esc(h.text)}</p>`).join(''):'<p class="muted">Ночью ничего не произошло.</p>'}</details>${state.host===state.me.id?'<button class="primary wide" data-do="reset">Ещё одну ночь →</button>':'<p class="muted">Создатель лобби может начать новый раунд.</p>'}</section>`;
}
function updateTimer() {
  TurnUI.updateTimer();
  if (!state || !$('#timer')) return;
  if (!state.deadline) { $('#timer').textContent = '✦'; return; }
  const remaining = Math.max(0, Math.ceil((state.deadline*1000 - Date.now() - clockOffset)/1000));
  $('#timer').textContent = `${Math.floor(remaining/60)}:${String(remaining%60).padStart(2,'0')}`;
  $('#timer').classList.toggle('urgent',remaining<=10);
}
async function copyText(text, label) {
  try { await navigator.clipboard.writeText(text); toast(label); }
  catch (_) { DialogUI.showText({title:'Скопируйте текст', message:'Автоматическое копирование недоступно. Выделите и скопируйте текст ниже.', value:text}); }
}

document.addEventListener('submit', async event => {
  const form = event.target; event.preventDefault();
  const fields = new FormData(form);
  if (form.id === 'entry-form') {
    const name = String(fields.get('name')).trim(), code = String(fields.get('code')).trim().toUpperCase();
    const create = event.submitter?.value === 'create';
    if (!create && !/^[A-Z2-9]{6}$/.test(code)) { toast('Введите шестизначный код лобби.'); return; }
    if (busy) return; busy = true;
    try {
      const result = await api(create?'/api/rooms':`/api/rooms/${code}/join`,{name},null);
      saveSession({code:result.code,token:result.token}); state = null; accept(result.state);
      history.replaceState(null,'',`/?room=${result.code}`);
    } catch (error) { toast(error.message); } finally { busy = false; }
  } else if (form.id === 'recover-form') {
    const code = String(fields.get('code')).trim().toUpperCase(), token = String(fields.get('token')).trim();
    if (!/^[A-Z2-9]{6}$/.test(code)) { toast('Проверьте код лобби.'); return; }
    try { const next = await api(`/api/rooms/${code}`,undefined,token); saveSession({code,token}); state=null; accept(next); }
    catch (error) { toast(error.message); }
  } else if (form.id === 'chat-form') {
    const input = form.elements.message;
    const draft = input.value;
    const message = draft.trim();
    if (message && await command('chat', {message}) && input.value === draft) input.value = '';
  } else if (form.id === 'settings-form') {
    const deck = Object.keys(catalog).flatMap(r=>Array(Number(fields.get(`role_${r}`))).fill(r));
    await command('settings', {automatic:event.submitter?.value==='auto', deck,
      night_seconds:Number(fields.get('night_seconds')), discussion_seconds:Number(fields.get('discussion_seconds')), vote_seconds:Number(fields.get('vote_seconds'))});

  }
});

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-do]');
  if (!button || !state) return;
  const action = button.dataset.do;
  if (action==='private') { privateOpen=!privateOpen; renderPrivate(); }
  else if (action==='invite') await copyText(`${location.origin}/?room=${state.code}`, 'Ссылка на лобби скопирована');
  else if (action==='recovery') DialogUI.showText({title:'Личный ключ', message:'Не отправляйте его друзьям. Сохраните ключ вместе с кодом лобби '+state.code+'.', value:session.token});
  else if (action==='vote') {
    const name = state.players.find(p=>p.id===button.dataset.target)?.name;
    await confirmCommand('vote', {target:button.dataset.target}, {title:'Подтвердить голос?', message:`Вы выбираете «${name}». Изменить голос будет нельзя.`, confirmLabel:'Проголосовать'});
  } else if (action==='kick') {
    const name = state.players.find(p=>p.id===button.dataset.target)?.name;
    await confirmCommand('kick', {target:button.dataset.target}, {title:'Исключить игрока?', message:`«${name}» покинет лобби и потеряет накопленные очки.`, confirmLabel:'Исключить', danger:true});
  } else if (action==='reset') {
    if (state.phase==='results') await command('reset');
    else await confirmCommand('reset', {}, {title:'Отменить раунд?', message:'Текущий раунд завершится без начисления очков. Счёт предыдущих раундов сохранится.', confirmLabel:'Отменить раунд', danger:true});
  } else if (action==='leave') {
    await confirmCommand('leave', {}, {title:'Выйти из лобби?', message:'Ваше место и накопленные очки будут удалены. При новом входе счёт начнётся с нуля.', confirmLabel:'Выйти', danger:true});
  } else if (action==='begin_vote') {
    await confirmCommand('begin_vote', {}, {title:'Начать голосование?', message:'Обсуждение закончится для всех игроков. Начнётся таймер голосования.', confirmLabel:'Начать голосование'});
  } else if (action==='skip') await command('night_action',{mode:'skip'});
  else await command(action);
});

$('#rules-open').addEventListener('click',()=>$('#rules-dialog').showModal());
$('#rules-close').addEventListener('click',()=>$('#rules-dialog').close());
async function init() {
  try {
    catalog = (await api('/api/roles',undefined,null)).roles;
    $('#role-guide').innerHTML = Object.entries(catalog).map(([id,r])=>`<article><span class="guide-icon role-surface" data-team="${roleTeam(id)}">${roleIcon(id)}</span><div><b>${esc(r.name)}</b><small>${teams[r.team]}</small><p>${esc(r.description)}</p></div></article>`).join('');
    if (session) {
      try { accept(await api(`/api/rooms/${session.code}`)); }
      catch (error) {
        if (error.status===401 || error.status===404) saveSession(null);
        renderLanding(); toast(error.message);
      }
    } else renderLanding();
    poll(); setInterval(updateTimer,250);
  } catch (_) {
    $('#app').innerHTML='<div class="loading">Не удалось подключиться. Проверьте, что сервер запущен, и обновите страницу.</div>';
  }
}
init();
