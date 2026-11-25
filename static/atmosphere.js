'use strict';

// Public phase only: lighting must never reveal roles, actions or winners.
const AtmosphereUI = (() => {
  const phases = {
    lobby: {title:'Вечер в деревне', caption:'Огонь ещё горит. Все собираются за столом.', symbol:'☀', color:'#251e25'},
    reveal: {title:'Сумерки сгущаются', caption:'Запомните свою роль. Скоро погаснут свечи.', symbol:'☾', color:'#201e35'},
    night: {title:'Деревня спит', caption:'За окнами — луна. За столом — чужие тайны.', symbol:'☾', color:'#0b1429'},
    discussion: {title:'Перед рассветом', caption:'Туман отступает. Пора рассказать свою версию.', symbol:'☀', color:'#292638'},
    voting: {title:'Час решения', caption:'Деревня замерла в ожидании вашего выбора.', symbol:'☀', color:'#32252b'},
    results: {title:'Первый свет', caption:'Солнце взошло. Тайное становится явным.', symbol:'☀', color:'#26343a'}
  };
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let motion = true;
  try { motion = localStorage.getItem('onw-atmosphere-motion') !== 'off'; } catch (_) { /* private mode */ }

  function sceneMarkup() {
    const stars = Array.from({length:34},(_,i) => `<circle cx="${(i*139+47)%1200}" cy="${(i*43+17)%156}" r="${i%3===0?1.5:.8}"/>`).join('');
    const trees = [0,35,76,117,165,218,260,305,352,410,470,535,595,652,718,774,828,883,940,996,1050,1105,1157,1195].map((x,i)=>{
      const y=183+(i*7)%25, h=33+(i*11)%31;
      return `<path d="M${x},${y-h} l-16,30 h8 l-17,28 h20 v15 h10 v-15 h20 l-17,-28 h8 Z"/>`;
    }).join('');
    const houses = [[310,202,48,37],[400,189,57,44],[525,200,44,32],[645,190,60,42],[768,201,45,33]].map(([x,y,w,h],i)=>`<g class="village-house"><path d="M${x},${y} v-${h} l${w/2},-${18+i%2*7} l${w/2},${18+i%2*7} v${h} Z"/><path class="village-roof" d="M${x-5},${y-h+2} l${w/2+5},-${23+i%2*7} l${w/2+5},${23+i%2*7}"/><path class="village-window" d="M${x+10},${y-h+12} h8 v11 h-8 Z M${x+w-18},${y-h+12} h8 v11 h-8 Z"/></g>`).join('');
    return `<section class="phase-landscape" aria-label="Освещение деревни"><div class="scene-art" aria-hidden="true"><div class="sky-layer sky-evening"></div><div class="sky-layer sky-dusk"></div><div class="sky-layer sky-night"></div><div class="sky-layer sky-dawn"></div><div class="sky-layer sky-voting"></div><div class="sky-layer sky-day"></div><svg class="scene-stars" viewBox="0 0 1200 240" preserveAspectRatio="xMidYMid slice">${stars}</svg><div class="scene-sun"><div class="sun-rays"></div></div><div class="scene-moon"></div><div class="scene-cloud cloud-one"></div><div class="scene-cloud cloud-two"></div><svg class="village-landscape" viewBox="0 0 1200 240" preserveAspectRatio="xMidYMax slice"><path class="hill-far" d="M0 172 Q150 90 300 157 T600 133 T900 152 T1200 126 V240 H0Z"/><path class="forest" d="M0 220 H1200 V240 H0Z"/><g class="forest">${trees}</g><path class="hill-near" d="M0 213 Q180 170 370 208 T760 206 T1200 191 V240 H0Z"/>${houses}<path class="village-road" d="M570 240 Q596 213 640 205 Q610 225 614 240Z"/></svg><div class="scene-mist"></div><div class="scene-candle candle-left"><span></span></div><div class="scene-candle candle-right"><span></span></div><div class="scene-vignette"></div></div><div class="scene-copy"><span class="eyebrow">ОДНА ДЕРЕВНЯ · ОДНА НОЧЬ</span><h3 class="scene-title"></h3><p class="scene-caption"></p></div><button class="scene-motion quiet" type="button" aria-pressed="true">Анимация: вкл.</button></section>`;
  }
  function render(phase='lobby') {
    const selected = Object.hasOwn(phases,phase) ? phase : 'lobby';
    const theme = phases[selected];
    if (document.body.dataset.atmosphere !== selected) {
      document.body.dataset.atmosphere = selected;
      document.querySelector('meta[name="theme-color"]').content = theme.color;
    }
    document.querySelectorAll('.scene-title').forEach(el => { el.textContent = theme.title; });
    document.querySelectorAll('.scene-caption').forEach(el => { el.textContent = theme.caption; });
    const badge = document.querySelector('.turn-moon');
    if (badge) badge.textContent = theme.symbol;
    updateMotion();
  }
  function updateMotion() {
    const enabled = motion && !motionQuery.matches;
    document.body.dataset.atmosphereMotion = enabled ? 'on' : 'off';
    document.body.classList.toggle('atmosphere-paused',document.hidden);
    document.querySelectorAll('.scene-motion').forEach(button => {
      button.setAttribute('aria-pressed',String(enabled));
      button.textContent = motionQuery.matches ? 'Анимация: системная настройка' : `Анимация: ${enabled?'вкл.':'выкл.'}`;
      button.disabled = motionQuery.matches;
      button.title = motionQuery.matches ? 'В системе включено уменьшение движения' : 'Изменить анимацию фона только на этом устройстве';
    });
  }
  document.addEventListener('click',event => {
    if (!event.target.closest('.scene-motion') || motionQuery.matches) return;
    motion = !motion;
    try { localStorage.setItem('onw-atmosphere-motion',motion?'on':'off'); } catch (_) { /* private mode */ }
    updateMotion();
  });
  motionQuery.addEventListener('change',updateMotion);
  document.addEventListener('visibilitychange',updateMotion);
  render();
  return {sceneMarkup, render, symbol:phase=>(phases[phase] || phases.lobby).symbol};
})();
