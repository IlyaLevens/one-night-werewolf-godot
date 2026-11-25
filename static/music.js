'use strict';

// One persistent media element; the room clock owns playback, the listener owns sound.
const MusicUI = (() => {
  const audio = document.querySelector('#background-music');
  const select = document.querySelector('#music-track');
  const play = document.querySelector('#music-play');
  const next = document.querySelector('#music-next');
  const local = document.querySelector('#music-local');
  const volume = document.querySelector('#music-volume');
  const status = document.querySelector('#music-status');
  const refresh = document.querySelector('#music-refresh');
  const hostControls = document.querySelector('#music-host-controls');
  let shared = null, room = '', host = false, allowed = false, muted = false;
  let receivedAt = 0, transportAt = 0, generation = 0, pendingPlay = false;
  let priming = false, sending = false, warning = '', url = '', playlistKey = '';
  try {
    const saved = JSON.parse(localStorage.getItem('onw-music') || '{}');
    if (Number.isFinite(saved.volume)) volume.value = Math.max(0, Math.min(100, saved.volume));
    muted = saved.muted === true;
  } catch (_) { /* Storage is optional. Permission itself is never persisted. */ }

  function remember() {
    try { localStorage.setItem('onw-music', JSON.stringify({volume:Number(volume.value), muted})); } catch (_) {}
  }
  function sound() {
    audio.volume = Number(volume.value) / 100;
    audio.muted = !allowed || muted || Number(volume.value) === 0 || priming;
  }
  function fresh() { return performance.now() - receivedAt < 10000; }
  function controls() {
    hostControls.hidden = !room || !host;
    play.disabled = next.disabled = sending || !shared?.tracks.length || !fresh();
    select.disabled = !host || sending || !shared?.tracks.length || !fresh();
    refresh.disabled = !room || sending;
    local.disabled = !room;
    local.textContent = !allowed ? '♫ Разрешить музыку' : muted ? '♫ Включить у себя' : '♫ Выключить у себя';
    local.setAttribute('aria-pressed', String(allowed && !muted));
    play.textContent = shared?.playing ? 'Ⅱ Пауза для всех' : '▶ Включить всем';
    if (!room) status.textContent = 'Войдите в лобби, чтобы слушать вместе';
    else if (!fresh()) status.textContent = 'Переподключение к музыке лобби…';
    else if (warning) status.textContent = warning;
    else if (!shared?.tracks.length) status.textContent = 'Добавьте MP3 в папку music на сервере';
    else if (!allowed) status.textContent = 'Нажмите «Разрешить музыку» для звука у себя';
    else if (muted || Number(volume.value) === 0) status.textContent = 'Звук выключен только у вас';
    else if (shared.playing) status.textContent = host ? 'Общая музыка · вы управляете лобби' : 'Общая музыка · управляет создатель лобби';
    else status.textContent = host ? 'Готово · нажмите «Включить всем»' : 'Ждём запуска музыки создателем лобби';
  }
  function desiredTime() {
    return shared.position + (shared.playing ? Math.max(0, performance.now() - transportAt) / 1000 : 0);
  }
  function align(force = false) {
    if (!shared || !audio.readyState || !Number.isFinite(audio.duration)) return;
    const target = Math.max(0, Math.min(desiredTime(), audio.duration));
    if (force || Math.abs(audio.currentTime - target) > 1.25) {
      try { audio.currentTime = target; } catch (_) { /* Wait for seekable metadata. */ }
    }
  }
  function start() {
    if (pendingPlay || !audio.paused || !url) return;
    pendingPlay = true;
    const version = generation;
    audio.play().then(() => {
      if (version === generation) { pendingPlay = false; controls(); }
    }).catch(error => {
      if (version !== generation) return;
      pendingPlay = false;
      if (error.name === 'AbortError') return;
      if (error.name === 'NotAllowedError') {
        allowed = false;
        warning = 'Браузер просит нажать «Разрешить музыку» ещё раз';
      } else warning = 'Этот файл не проигрывается. Создатель может выбрать другой MP3.';
      controls();
    });
  }
  function sync(force = false) {
    if (priming) { controls(); return; }
    sound();
    if (!shared || !room) { audio.pause(); controls(); return; }
    align(force);
    if (!allowed || !shared.playing || !fresh() || !url || warning) audio.pause();
    else if (!(audio.ended && desiredTime() >= audio.duration)) start();
    controls();
  }
  function receive(view) {
    if (!view.music) return;
    const identity = `${view.code}:${view.me.id}`;
    const changedRoom = room !== identity;
    if (changedRoom) { leave(); room = identity; }
    const oldRevision = shared?.revision;
    shared = view.music;
    host = view.host === view.me.id;
    receivedAt = performance.now();
    transportAt = receivedAt - (shared.playing ? Math.min(1000, (view._request_ms || 0) / 2) : 0);
    const key = JSON.stringify(shared.tracks.map(t => [t.file, t.version]));
    if (key !== playlistKey) {
      playlistKey = key;
      select.replaceChildren();
      shared.tracks.forEach(t => select.add(new Option(t.name, t.file)));
      if (!shared.tracks.length) select.add(new Option('Папка music пуста', ''));
    }
    select.value = shared.file || '';
    const track = shared.tracks.find(t => t.file === shared.file);
    const newUrl = track?.url || '';
    if (newUrl !== url) {
      generation++; pendingPlay = false; priming = false; warning = ''; audio.pause();
      url = newUrl;
      if (url) audio.src = url;
      else audio.removeAttribute('src');
      audio.load();
    }
    sync(changedRoom || oldRevision !== shared.revision);
  }
  function leave() {
    generation++; pendingPlay = false; priming = false;
    audio.pause(); audio.removeAttribute('src'); audio.load();
    shared = null; room = ''; host = false; url = ''; playlistKey = ''; warning = '';
    select.replaceChildren(new Option('Музыка лобби', ''));
    controls();
  }
  function authorize(unmute = true) {
    // Prime the same element quietly inside the click, even if the host is paused.
    allowed = true;
    if (unmute) muted = false;
    warning = ''; remember();
    if (!url) audio.src = '/static/silence.wav';
    const version = ++generation;
    pendingPlay = false; priming = true; sound();
    audio.play().then(() => {
      if (version !== generation) return;
      priming = false;
      if (!shared?.playing) audio.pause();
      sync(true);
    }).catch(error => {
      if (version !== generation) return;
      priming = false;
      if (error.name === 'NotAllowedError') {
        allowed = false; warning = 'Разрешите звук для сайта в настройках браузера и повторите нажатие';
      } else if (error.name !== 'AbortError') warning = 'Не удалось включить файл. Попробуйте другой MP3.';
      sync();
    });
    controls();
  }
  async function send(operation, data = {}) {
    if (sending || !host || !shared || !session) return;
    const current = session;
    sending = true; warning = ''; controls();
    try {
      const view = await api(`/api/rooms/${current.code}/music`, {operation, revision:shared.revision, ...data}, current.token);
      if (session === current) accept(view);
    } catch (error) {
      if (session !== current) return;
      toast(error.message);
      try { const view = await api(`/api/rooms/${current.code}`, undefined, current.token); if (session === current) accept(view); } catch (_) {}
    } finally { sending = false; controls(); }
  }
  local.addEventListener('click', () => {
    if (!allowed || muted) authorize();
    else { muted = true; remember(); sync(); }
  });
  play.addEventListener('click', () => {
    if (!shared?.playing && !allowed) authorize(false);
    send(shared?.playing ? 'pause' : 'play');
  });
  next.addEventListener('click', () => send('next'));
  select.addEventListener('change', () => send('select', {file:select.value}));
  volume.addEventListener('input', () => { remember(); sound(); controls(); });
  refresh.addEventListener('click', async () => {
    if (!session) return;
    const current = session; warning = '';
    try { const view = await api(`/api/rooms/${current.code}`, undefined, current.token); if (session === current) accept(view); }
    catch (error) { toast(error.message); }
  });
  audio.addEventListener('loadedmetadata', () => sync(true));
  audio.addEventListener('ended', controls);
  audio.addEventListener('error', () => {
    if (url && audio.getAttribute('src') === url) {
      warning = 'Не удалось загрузить музыку. Проверьте соединение или выберите другой трек.';
      controls();
    }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(true); });
  setInterval(() => sync(), 1000);
  sound(); controls();
  return {receive, leave};
})();
