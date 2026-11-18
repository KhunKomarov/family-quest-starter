const {test} = require('node:test');
const assert = require('node:assert/strict');
const {mkdtempSync, writeFileSync, readFileSync, mkdirSync, cpSync, copyFileSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {resolve, join} = require('node:path');
const {pathToFileURL} = require('node:url');
const {spawn} = require('node:child_process');
const {randomBytes, createHash} = require('node:crypto');
const net = require('node:net');
const {chromium} = require('playwright');
const root=resolve(__dirname,'..');
const launch=()=>chromium.launch({headless:true,...(process.env.FAMILY_TEST_CHROME?{executablePath:process.env.FAMILY_TEST_CHROME}:{})});

test('invited family completes setup with a photo, own tasks, codes and a private download', async()=>{
  const work=mkdtempSync(join(tmpdir(),'family-invitation-'));
  const token=randomBytes(32).toString('base64url');
  writeFileSync(join(work,'devices.json'),JSON.stringify({tv:randomBytes(32).toString('hex')}));
  writeFileSync(join(work,'parents.json'),JSON.stringify({'Factory parent':'999888'}));
  writeFileSync(join(work,'invitation.json'),JSON.stringify({digest:createHash('sha256').update(token).digest('hex'),expires:Math.floor(Date.now()/1000)+3600}));
  const reservation=net.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  const origin='http://127.0.0.1:'+port;
  const server=spawn('python3',[join(root,'sync/server.py'),'--preview','--port',String(port),'--database',join(work,'journal.sqlite3'),'--tokens',join(work,'devices.json'),'--parents',join(work,'parents.json'),'--invitation-file',join(work,'invitation.json')],{stdio:'ignore'});
  const browser=await launch();
  try{
    for(let attempt=0;attempt<100;attempt++){try{await fetch(origin+'/setup/');break;}catch(_){await new Promise(r=>setTimeout(r,30));}}
    const context=await browser.newContext({viewport:{width:390,height:844}});
    const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin+'/setup/#invite='+token);
    await page.getByRole('button',{name:'Настроить нашу семью',exact:false}).click();
    await page.getByLabel('Имя ребёнка 1',{exact:true}).fill('Тестовый Лист');
    await page.getByLabel('Имя ребёнка 2',{exact:true}).fill('Тестовое Солнце');
    await page.getByLabel('Фотография ребёнка 1',{exact:true}).setInputFiles(join(root,'web/avatar-1.png'));
    await page.waitForFunction(()=>document.querySelector('.child-card img').src.startsWith('data:image/jpeg;'));
    mkdirSync(join(root,'.local/screenshots'),{recursive:true});
    await page.screenshot({path:join(root,'.local/screenshots/invitation-family.jpg'),fullPage:true});
    await page.getByRole('button',{name:'Дальше →',exact:true}).click();
    await page.getByRole('textbox',{name:'Дневное дело 1',exact:true}).fill('Полить наше растение');
    await page.getByRole('button',{name:'Дальше →',exact:true}).click();
    await page.getByLabel('Название цели',{exact:true}).fill('Наша прогулка');
    await page.getByLabel('Что ждёт в конце',{exact:true}).fill('Выбрать парк');
    await page.getByRole('button',{name:'Дальше →',exact:true}).click();
    await page.getByLabel('Имя родителя 1',{exact:true}).fill('Первый');
    await page.getByLabel('Код из 6 цифр 1',{exact:true}).fill('246810');
    await page.getByLabel('Повторите код 1',{exact:true}).fill('246810');
    await page.getByLabel('Имя родителя 2',{exact:true}).fill('Второй');
    await page.getByLabel('Код из 6 цифр 2',{exact:true}).fill('135790');
    await page.getByLabel('Повторите код 2',{exact:true}).fill('135790');
    await page.getByRole('checkbox',{name:'Я согласен разместить данные нашей семьи',exact:false}).check();
    await page.route('**/setup/api/register',route=>route.fulfill({status:429,contentType:'text/html',body:'Too many requests'}));
    await page.getByRole('button',{name:'Создать нашу семью',exact:true}).click();
    await page.getByText('Слишком много попыток. Подождите минуту и повторите.',{exact:true}).waitFor();
    await page.unroute('**/setup/api/register');
    await page.getByRole('button',{name:'Создать нашу семью',exact:true}).click();
    await page.getByRole('heading',{name:'Ваша семья на месте',exact:true}).waitFor();
    assert.equal(new URL(page.url()).hash,'');
    await page.getByRole('link',{name:'Подключить детский экран',exact:true}).click();
    await page.getByText('Тестовый Лист',{exact:true}).waitFor();
    assert.equal(await page.locator('#family-preview img').count(),2);
    assert.equal(await page.locator('#family-preview img').evaluateAll(images=>images.every(image=>image.complete&&image.naturalWidth>0)),true);
    const download=await page.request.get(origin+'/parent/api/connection');assert.equal(download.status(),200);
    const state=await (await page.request.get(origin+'/parent/api/state')).json();
    assert.equal(state.wallets.length,2);
    assert.equal(state.catalog.at(-1)[1][0].afternoon[0][1],'Полить наше растение');
    await page.goto(origin+'/setup/#invite='+token);
    await page.getByText('Эта ссылка уже использована, отозвана или срок приглашения закончился. Попросите новое приглашение.',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Настроить нашу семью',exact:false}).isDisabled(),true);
    await page.getByRole('link',{name:'Уже зарегистрировались? Открыть кабинет',exact:true}).click();
    await page.getByRole('heading',{name:'Семейный журнал',exact:true}).waitFor();
    const second=await browser.newContext();const parent=await second.newPage();await parent.goto(origin+'/parent/');
    await parent.getByLabel('Шестизначный код',{exact:true}).fill('135790');await parent.getByRole('button',{name:'Войти',exact:true}).click();
    await parent.getByRole('heading',{name:'Семейный журнал',exact:true}).waitFor();
    await parent.getByRole('link',{name:'Подключить экран',exact:true}).waitFor();
    assert.deepEqual(errors,[]);
    await second.close();await context.close();
  }finally{await browser.close();server.kill();await new Promise(r=>server.once('exit',r));rmSync(work,{recursive:true,force:true});}
});

test('the child screen renders one, two and six configured profiles',async()=>{
  const browser=await launch();const work=mkdtempSync(join(tmpdir(),'family-count-'));
  try{
    cpSync(join(root,'web'),join(work,'web'),{recursive:true});
    for(const count of [1,2,6]){
      const config=JSON.parse(readFileSync(join(root,'config/family.json')));config.profiles=Array.from({length:count},(_,index)=>'Профиль '+(index+1));
      writeFileSync(join(work,'web/family-config.js'),'window.FamilyConfig='+JSON.stringify(config)+';');
      for(let index=3;index<count;index++)copyFileSync(join(root,'web/avatar-'+(index%3+1)+'.png'),join(work,'web/avatar-'+(index+1)+'.png'));
      const page=await browser.newPage({viewport:{width:1280,height:720}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.goto(pathToFileURL(join(work,'web/index.html')).href+'?demo=1');
      await page.locator('[data-child="0"]').waitFor();
      assert.equal(await page.locator('.cal-profiles [data-child]').count(),count);
      await page.locator('[data-child="'+(count-1)+'"]').click();
      await page.getByRole('heading',{name:'Профиль '+count,exact:true}).waitFor();
      assert.deepEqual(errors,[]);await page.close();
    }
  }finally{await browser.close();rmSync(work,{recursive:true,force:true});}
});
