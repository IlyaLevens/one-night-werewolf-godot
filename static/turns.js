'use strict';

const TurnUI = (() => {
  const dialog = document.querySelector('#turn-dialog');
  const pageTitle = document.title;
  let seen = '', active = '';
  try { seen = sessionStorage.getItem('onw-turn-seen') || ''; } catch (_) { /* private mode */ }

  function turn(s) {
    if (!s) return null;
    if (s.phase === 'reveal' && !s.me.ready) return {
      title:'Посмотрите свою карту', text:'Раунд начался. Запомните начальную роль и подтвердите готовность.', button:'Открыть игровой стол'
    };
    if (s.phase === 'voting' && !s.me.vote) return {
      title:'Пора голосовать', text:'Выберите подозреваемого на игровом столе и подтвердите свой голос.', button:'Перейти к голосованию'
    };
    if (s.phase === 'night' && s.me.original === s.night_role && !s.me.action_done) return {
      title:'Ваш ход!', text:s.me.action ? 'Деревня спит. Выберите карты на столе и выполните действие своей роли.' : 'Ваша роль проснулась. Посмотрите доступные вам сведения на игровом столе.',
      button:s.me.action ? 'Перейти к ходу' : 'Посмотреть сведения'
    };
    return null;
  }
  function close() {
    active = '';
    if (dialog.open) dialog.close();
    document.title = pageTitle;
  }
  function receive(next) {
    const info = turn(next), key = DialogUI.key(next);
    if (!info || (active && active !== key)) close();
    if (!info) return;
    if (seen !== key) {
      document.title = `${info.title} · One Night Werewolf`;
      // Wait until this tab is visible so the notice is not lost in the background.
      if (document.hidden) return;
      DialogUI.dismiss();
      document.querySelectorAll('dialog[open]').forEach(el => el.close());
      document.querySelector('#turn-title').textContent = info.title;
      document.querySelector('#turn-message').textContent = info.text;
      document.querySelector('#turn-continue').textContent = info.button;
      document.querySelector('#turn-role').textContent = next.phase === 'night' ? catalog[next.me.original].name : `Раунд ${next.round}`;
      active = seen = key;
      try { sessionStorage.setItem('onw-turn-seen', seen); } catch (_) { /* private mode */ }
      dialog.showModal();
      document.querySelector('#turn-continue').focus();
      updateTimer();
    }
  }
  function updateTimer() {
    if (!dialog.open || !state) return;
    const remaining = state.deadline == null ? null : Math.max(0, Math.ceil((state.deadline * 1000 - Date.now() - clockOffset) / 1000));
    document.querySelector('#turn-countdown').textContent = remaining === null ? '—' : `${remaining} сек.`;
    document.querySelector('#turn-countdown').classList.toggle('urgent', remaining !== null && remaining <= 10);
    if (remaining === 0) close();
  }
  function proceed() {
    close();
    const target = document.querySelector('.table-card.can-select, .your-seat .table-card:not(:disabled)');
    document.querySelector('#table-panel')?.scrollIntoView({block:'start', behavior:'instant'});
    target?.focus({preventScroll:true});
  }
  document.querySelector('#turn-continue').addEventListener('click', proceed);
  document.querySelector('#turn-scoreboard').addEventListener('click', () => { close(); ScoreboardUI.open(); });
  dialog.addEventListener('cancel', event => { event.preventDefault(); proceed(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state) receive(state); });
  return {receive, updateTimer, leave:close};
})();
