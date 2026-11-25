/* Optional browser regression suite: npm install --no-save playwright; node tests/test_ui.cjs */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const {spawn, spawnSync} = require('node:child_process');
const {chromium} = require('playwright');
const root = path.resolve(__dirname,'..');
const python = process.env.PYTHON || 'python';
const fixtures = spawnSync(python,['-m','tests.ui_fixtures'],{cwd:root,encoding:'utf8'});
if (fixtures.status) throw Error(fixtures.stderr);
const {lobby,result} = JSON.parse(fixtures.stdout);
const clone = value => JSON.parse(JSON.stringify(value));
const port = Number(process.env.UI_TEST_PORT || 8913);
const base = `http://127.0.0.1:${port}`;
const server = spawn(python,['-c',`from app import create_app; from waitress import serve; serve(create_app(), host='127.0.0.1', port=${port})`],{cwd:root,stdio:'ignore'});
let browser;
(async()=>{
  for(let i=0;i<100;i++) {
    try {if((await fetch(base+'/health')).ok) break;} catch(_) {}
    if(i===99) throw Error('Test server did not start');
    await new Promise(r=>setTimeout(r,100));
  }
  browser = await chromium.launch({headless:true,
    ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath:process.env.CHROMIUM_EXECUTABLE} : {}),
    ...(process.env.UI_BROWSER_ARGS ? {args:JSON.parse(process.env.UI_BROWSER_ARGS)} : {})});
  const page = await browser.newPage({viewport:{width:1280,height:1000}});
  const errors=[], nativeDialogs=[], requests=[];
  page.on('pageerror', e=>errors.push(e.message));
  page.on('dialog', async d=>{nativeDialogs.push(d.type()); await d.dismiss();});
  let current=clone(lobby);
  await page.addInitScript(({code})=>{
    sessionStorage.setItem('onw-session',JSON.stringify({code,token:'browser-test'}));
    window.cspErrors=[];
    document.addEventListener('securitypolicyviolation',e=>window.cspErrors.push(e.violatedDirective));
  },lobby);
  await page.route('**/api/rooms/**',async route=>{
    if(route.request().method()==='POST') requests.push({url:route.request().url(),data:route.request().postDataJSON()});
    await route.fulfill({json:{...current,server_time:Date.now()/1000}});
  });
  const push = async next=>{
    current=clone(next);
    await page.evaluate(s=>accept({...s,server_time:Date.now()/1000}),current);
  };
  const widths=()=>page.locator('#scoreboard-panel .score-row').evaluateAll(rows=>Object.fromEntries(rows.map(r=>[r.dataset.playerId,parseFloat(r.querySelector('.score-bar').style.width)])));
  const scoreState=(scores,points,round)=>{
    const next=clone(result);next.round=round;next.stage=`${round}:results:-`;next.scoreboard.round=round;
    next.scoreboard.players.forEach((p,i)=>{p.score=scores[i];p.points=points[i];});
    return next;
  };
  const ids=lobby.players.map(p=>p.id);
  await page.goto(base);
  await page.waitForSelector('#scoreboard-panel .score-row');
  const chat = page.locator('#chat-input');
  const submitChat = () => page.locator('#chat-form button').click();
  const chatRoute = '**/api/rooms/*/chat';
  await page.route(chatRoute, route => route.fulfill({status:503, json:{error:'Повторите отправку'}}));
  await chat.fill('Первое сообщение');
  await submitChat();
  await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Повторите отправку');
  assert.equal(await chat.inputValue(), 'Первое сообщение');
  await page.unroute(chatRoute);
  let pendingChat;
  const requestStarted = new Promise(resolve => {
    pendingChat = resolve;
  });
  await page.route(chatRoute, route => pendingChat(route));
  await submitChat();
  const pendingRoute = await requestStarted;
  await chat.fill('Следующее сообщение');
  await submitChat();
  assert.equal(await chat.inputValue(), 'Следующее сообщение');
  await pendingRoute.fulfill({json:{...current,server_time:Date.now()/1000}});
  await page.waitForFunction(() => !busy);
  assert.equal(await chat.inputValue(), 'Следующее сообщение');
  await page.unroute(chatRoute);
  await submitChat();
  await page.waitForFunction(() => document.querySelector('#chat-input').value === '');
  assert.equal(requests.pop().data.message, 'Следующее сообщение');
  await page.waitForTimeout(1100);
  assert.deepEqual(Object.values(await widths()),[0,0,0,0]);
  const skyNames={lobby:'evening',reveal:'dusk',night:'night',discussion:'dawn',voting:'voting',results:'day'};
  for (const phase of Object.keys(skyNames)) {
    const snapshot=clone(result);snapshot.phase=phase;snapshot.stage=`1:${phase}:-`;
    snapshot.night_role=phase==='night'?'werewolf':null;snapshot.me.original='hunter';snapshot.me.action=null;snapshot.me.ready=true;
    await push(snapshot);await page.waitForTimeout(2900);
    assert.equal(await page.evaluate(()=>document.body.dataset.atmosphere),phase);
    assert.equal(await page.locator(`.phase-landscape .sky-${skyNames[phase]}`).evaluate(el=>getComputedStyle(el).opacity),'1');
    const moon=await page.locator('.scene-moon').evaluate(el=>getComputedStyle(el).opacity);
    const sun=await page.locator('.scene-sun').evaluate(el=>getComputedStyle(el).opacity);
    if(phase==='night') {assert.equal(moon,'1');assert.equal(sun,'0');}
    if(phase==='results') {assert.equal(moon,'0');assert.equal(sun,'1');}
    if(process.env.UI_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.UI_SCREENSHOT_DIR,{recursive:true});
      await page.locator('.phase-landscape').screenshot({path:path.join(process.env.UI_SCREENSHOT_DIR,`sky-${phase}.png`)});
      if(phase==='night'||phase==='results') await page.screenshot({path:path.join(process.env.UI_SCREENSHOT_DIR,`page-${phase}.png`)});
    }
  }
  const cloud=page.locator('.cloud-one');
  const beforeCloud=await cloud.evaluate(el=>getComputedStyle(el).transform);await page.waitForTimeout(200);
  assert.notEqual(await cloud.evaluate(el=>getComputedStyle(el).transform),beforeCloud,'Clouds must actually move');
  await page.locator('.scene-motion').click();
  assert.equal(await cloud.evaluate(el=>getComputedStyle(el).animationName),'none');
  await page.locator('.scene-motion').click();
  assert.notEqual(await cloud.evaluate(el=>getComputedStyle(el).animationName),'none');
  console.log('PASS: six phase skies, moon/sun visibility, moving clouds and local animation toggle');
  await push(lobby);await page.waitForTimeout(1100);
  const first=scoreState([1,2,4,0],[1,2,3,0],1);
  await push(first);
  await page.waitForTimeout(160);
  const during=await widths();
  assert(during[ids[1]]>0 && during[ids[1]]<50,'Bar must animate, not jump');
  await page.waitForTimeout(1100);
  let w=await widths();
  assert.equal(w[ids[0]],25);assert.equal(w[ids[1]],50);assert.equal(w[ids[2]],100);assert.equal(w[ids[3]],0);
  await page.locator(`#scoreboard-panel [data-player-id="${ids[0]}"]`).evaluate(el=>{el.persisted=true;});
  const second=scoreState([2,3,4,0],[1,1,0,0],2);
  await push(second);await page.waitForTimeout(1100);
  w=await widths();assert.equal(w[ids[0]],50);assert.equal(w[ids[1]],75);
  assert(await page.locator(`#scoreboard-panel [data-player-id="${ids[0]}"]`).evaluate(el=>el.persisted),'Rows must survive updates');
  await push(second);
  assert.equal((await widths())[ids[0]],50,'Polling must not restart animation');
  const third=scoreState([2,3,8,0],[0,0,4,0],3);
  await push(third);await page.waitForTimeout(1100);
  assert.equal((await widths())[ids[1]],37.5,'All bars must rescale when the leader changes');
  assert.equal(await page.locator('.table-card.is-dead').count(),2,'Hunter victim needs a death mark');
  assert.equal(await page.locator('.table-card.your-vote').count(),0);
  console.log('PASS: animated proportional scores, zero scores, persistent rows, leader changes, hunter marks');

  const night=clone(third);night.phase='night';night.stage='4:night:seer';night.round=4;night.result=null;
  night.night_role='seer';night.night_steps=['werewolf','seer'];night.me.original='seer';night.me.vote=null;night.me.action='seer';night.me.action_done=false;night.deadline=Date.now()/1000+60;
  await push(night);
  await page.waitForSelector('#turn-dialog[open]');
  const bounds=await page.locator('#turn-dialog').boundingBox();
  assert.equal(bounds.width,1280);assert.equal(bounds.height,1000);
  assert.equal(await page.locator('#turn-title').textContent(),'Ваш ход!');
  const secondsLeft = await page.locator('#turn-countdown').textContent();
  await page.waitForFunction(previous => {
    const current = parseInt(document.querySelector('#turn-countdown').textContent, 10);
    return current < parseInt(previous, 10);
  }, secondsLeft, {timeout: 3500});
  if(process.env.UI_SCREENSHOT_DIR) {fs.mkdirSync(process.env.UI_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.UI_SCREENSHOT_DIR,'turn-desktop.png')});}
  await page.locator('#turn-scoreboard').click();
  await page.waitForSelector('#scoreboard-dialog[open]');
  await page.waitForTimeout(1100);
  assert.equal(await page.locator('#scoreboard-modal .score-row').count(),4);
  await page.locator('#scoreboard-close').click();
  await push(night);assert.equal(await page.locator('#turn-dialog[open]').count(),0,'No repeated turn popup');
  assert.deepEqual(await page.evaluate(()=>window.cspErrors),[],'Score animation must obey CSP');
  await page.reload();await page.waitForSelector('#table-panel .table-card');
  assert.equal(await page.locator('#turn-dialog[open]').count(),0,'Reload must not repeat acknowledged notice');
  const other=clone(night);other.stage='4:night:robber';other.night_role='robber';other.me.action=null;
  await push(other);assert.equal(await page.locator('#turn-dialog[open]').count(),0,'Other roles must not wake this player');
  const passive=clone(other);passive.stage='4:night:minion';passive.night_role='minion';passive.me.original='minion';
  await push(passive);await page.waitForSelector('#turn-dialog[open]');
  assert.equal(await page.locator('#turn-continue').textContent(),'Посмотреть сведения');
  await page.locator('#turn-continue').click();
  console.log('PASS: full-screen own turn, countdown, passive roles, no repeat after poll/reload, scoreboard during night');

  const vote=clone(night);vote.phase='voting';vote.stage='4:voting:-';vote.me.action=null;vote.night_role=null;
  await push(vote);await page.locator('#turn-continue').click();
  await page.locator(`[data-card="player:${ids[1]}"]`).click();
  await page.locator('[data-table-action="confirm"]').click();
  await page.waitForSelector('#action-dialog[open]');
  assert.equal(requests.length,0,'No command before confirmation');
  await page.keyboard.press('Escape');
  assert.equal(requests.length,0,'Escape must cancel');
  await page.locator('[data-table-action="confirm"]').click();
  await page.locator('#action-confirm').click();
  await page.waitForTimeout(150);
  assert.equal(requests.length,1);assert(requests[0].url.endsWith('/vote'));assert.equal(requests[0].data.target,ids[1]);assert.equal(requests[0].data.stage,'4:voting:-');
  await page.locator('[data-table-action="confirm"]').click();
  await page.waitForSelector('#action-dialog[open]');
  await push(third);
  assert.equal(await page.locator('#action-dialog[open]').count(),0,'Phase change must cancel pending vote');
  assert.equal(requests.length,1);
  await push(lobby);
  await page.locator(`[data-do="kick"][data-target="${ids[1]}"]`).click();
  await page.waitForSelector('#action-dialog[open]');
  const departed=clone(lobby);departed.players=departed.players.filter(p=>p.id!==ids[1]);
  await push(departed);assert.equal(await page.locator('#action-dialog[open]').count(),0,'Departed target cancels confirmation');
  await push(lobby);
  await page.locator('[data-do="leave"]').click();await page.waitForSelector('#action-dialog[open]');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'action-cancel');
  await page.keyboard.press('Enter');assert.equal(await page.locator('#action-dialog[open]').count(),0);
  await page.locator('[data-do="recovery"]').click();await page.waitForSelector('#action-dialog[open]');
  assert.equal(await page.locator('#action-value').inputValue(),'browser-test');
  await page.locator('#action-close').click();
  assert.equal(await page.locator('#action-value').inputValue(),'','Key must be removed from closed dialog');
  const discussion=clone(night);discussion.phase='discussion';discussion.stage='4:discussion:-';discussion.night_role=null;discussion.me.action=null;
  await push(discussion);
  await page.locator('[data-do="begin_vote"]').click();await page.waitForSelector('#action-dialog[open]');
  await page.locator('#action-confirm').click();await page.waitForTimeout(100);
  assert(requests.at(-1).url.endsWith('/begin_vote'));
  await page.locator('[data-do="reset"]').click();await page.waitForSelector('#action-dialog[open]');
  await page.locator('#action-confirm').click();await page.waitForTimeout(100);
  assert(requests.at(-1).url.endsWith('/reset'));
  await push(lobby);
  await page.locator(`[data-do="kick"][data-target="${ids[2]}"]`).click();
  await page.locator('#action-confirm').click();await page.waitForTimeout(100);
  assert(requests.at(-1).url.endsWith('/kick'));
  const reveal=clone(lobby);reveal.round=5;reveal.phase='reveal';reveal.stage='5:reveal:-';reveal.me.original='seer';reveal.me.ready=false;reveal.deadline=Date.now()/1000+60;
  await push(reveal);await page.waitForSelector('#turn-dialog[open]');
  assert.equal(await page.locator('#turn-title').textContent(),'Посмотрите свою карту');
  await push(lobby);assert.equal(await page.locator('#turn-dialog[open]').count(),0,'Phase change closes turn notice');
  console.log('PASS: custom confirmations, cancel/Escape/Enter, stale phase/target protection, custom key dialog, reveal notice');

  await page.setViewportSize({width:390,height:844});
  night.stage='5:night:seer';night.round=5;night.deadline=Date.now()/1000+50;
  await push(night);await page.waitForSelector('#turn-dialog[open]');
  const mobileBounds=await page.locator('#turn-dialog').boundingBox();assert.equal(mobileBounds.width,390);assert.equal(mobileBounds.height,844);
  if(process.env.UI_SCREENSHOT_DIR) await page.screenshot({path:path.join(process.env.UI_SCREENSHOT_DIR,'turn-mobile.png')});
  await page.locator('#turn-continue').click();
  await push(third);await page.waitForTimeout(2900);
  if(process.env.UI_SCREENSHOT_DIR) await page.locator('.phase-landscape').screenshot({path:path.join(process.env.UI_SCREENSHOT_DIR,'sky-mobile.png')});
  await page.locator('#scoreboard-open').click();await page.waitForTimeout(1100);
  assert(await page.locator('#scoreboard-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth),'Scoreboard must fit mobile width');
  if(process.env.UI_SCREENSHOT_DIR) await page.screenshot({path:path.join(process.env.UI_SCREENSHOT_DIR,'scores-mobile.png')});
  await page.locator('#scoreboard-close').click();
  await page.locator('[data-do="leave"]').click();
  assert(await page.locator('#action-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth),'Confirmation must fit mobile width');
  if(process.env.UI_SCREENSHOT_DIR) await page.screenshot({path:path.join(process.env.UI_SCREENSHOT_DIR,'confirm-mobile.png')});
  await page.locator('#action-cancel').click();
  await page.emulateMedia({reducedMotion:'reduce'});await push(second);
  assert.equal(await page.locator('.cloud-one').evaluate(el=>getComputedStyle(el).animationName),'none');
  assert(await page.locator('.scene-motion').isDisabled());
  assert(await page.locator('.phase-landscape').evaluate(el=>el.scrollWidth<=el.clientWidth),'Landscape must fit mobile width');
  assert.equal((await widths())[ids[0]],50,'Reduced motion updates immediately');
  assert.deepEqual(await page.evaluate(()=>window.cspErrors),[],'No blocked inline styles');
  assert.deepEqual(nativeDialogs,[],'No native browser dialogs');
  assert.deepEqual(errors,[],'No JavaScript errors');
  console.log('PASS: mobile dialogs, reduced motion, strict CSP, no native dialogs or JavaScript errors');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser) await browser.close();server.kill();});
