(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const token = new URLSearchParams(location.hash.slice(1)).get('invite') || '';
  const steps = Array.from(document.querySelectorAll('[data-step]'));
  let template, step = 0, busy = false, currentChild = 0;
  const children = [];
  const goalEditor = window.FamilyGoalEditor.attach($('#goal-editor'),()=>children.map(child=>child.goals),()=>children.map(child=>child.name));
  const parentValues = [{name:'Родитель 1', code:'', confirm:''}, {name:'Родитель 2', code:'', confirm:''}];
  const clone = value => JSON.parse(JSON.stringify(value));
  const node = (tag, className, text) => { const result = document.createElement(tag); if(className) result.className = className; if(text !== undefined) result.textContent = text; return result; };
  const button = (text, action, className) => { const result = node('button', className, text); result.type = 'button'; result.addEventListener('click', action); return result; };
  const status = text => { $('#form-status').textContent = text; };
  const id = () => 'custom-' + Array.from(crypto.getRandomValues(new Uint8Array(8)), v=>v.toString(16).padStart(2,'0')).join('');
  async function api(path, body) {
    let response;
    try { response = await fetch('/setup/api/' + path, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)}); }
    catch (_) { throw new Error('Нет связи с семейным сервером. Проверьте интернет и попробуйте ещё раз.'); }
    const data = await response.json().catch(()=>({}));
    if(!response.ok) {const error = new Error(response.status === 410 ? 'Эта ссылка уже использована, отозвана или срок приглашения закончился. Попросите новое приглашение.' : response.status === 429 ? 'Слишком много попыток. Подождите минуту и повторите.' : 'Не удалось сохранить настройки. Проверьте поля и попробуйте ещё раз.');error.status=response.status;throw error;}
    return data;
  }
  function addChild() { children.push({name:'', photo:null, menu:{...clone(template),repeatables:clone(template.repeatables||[])}, goals:[]}); renderChildren(); }
  function renderChildren() {
    const cards = $('#child-cards'); cards.replaceChildren();
    children.forEach((child,index) => {
      const card = node('article','child-card');
      const image = node('img'); image.alt = 'Аватар ребёнка ' + (index+1); image.src = child.photo ? 'data:image/jpeg;base64,'+child.photo : '/setup/avatar-'+(index%3+1)+'.png';
      const label = node('label',null,'Имя ребёнка '+(index+1)); const name = node('input'); name.id = 'child-name-'+index; name.maxLength = 24; name.autocomplete = 'off'; label.htmlFor = name.id; name.value = child.name; name.addEventListener('input',()=>child.name=name.value);
      const uploadLabel = node('label','photo-label'); const upload = node('input','photo-file'); upload.type = 'file'; upload.accept = 'image/jpeg,image/png,image/webp,image/heic'; upload.setAttribute('aria-label','Фотография ребёнка '+(index+1));
      upload.addEventListener('change',async()=>{
        if(!upload.files[0]) return;
        status('');
        try {
          if(upload.files[0].size > 20*1024*1024) throw new Error('large');
          const bitmap = await createImageBitmap(upload.files[0]);
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 384;
          const side = Math.min(bitmap.width,bitmap.height); canvas.getContext('2d').drawImage(bitmap,(bitmap.width-side)/2,(bitmap.height-side)/2,side,side,0,0,384,384); bitmap.close();
          child.photo = canvas.toDataURL('image/jpeg',.86).split(',')[1]; image.src = 'data:image/jpeg;base64,'+child.photo;
        } catch(_) { status('Не получилось открыть фото. Выберите JPEG, PNG или WebP до 20 МБ. Можно оставить аватар и продолжить.'); }
      });
      uploadLabel.append(upload,node('span',null,child.photo?'Выбрать другое фото':'Добавить фотографию'));
      card.append(image,uploadLabel,button('Оставить стандартный аватар',()=>{child.photo=null;renderChildren();},'avatar-choice'),label,name);
      if(children.length>1) { const remove = button('×',()=>{children.splice(index,1);renderChildren();},'remove-child'); remove.setAttribute('aria-label','Убрать ребёнка '+(index+1)); card.append(remove); }
      cards.append(card);
    });
    $('#add-child').disabled = children.length>=6;
  }
  function renderTaskChild() {
    const selector = $('#task-child'); selector.replaceChildren();
    children.forEach((child,index)=>{const option=node('option',null,child.name);option.value=index;selector.append(option);});
    currentChild = Math.min(currentChild,children.length-1); selector.value = currentChild; renderTasks();
  }
  function renderTasks() {
    const menu = children[currentChild].menu;
    for(const [category,selector] of [['morning','#morning-tasks'],['afternoon','#afternoon-tasks'],['rewards','#reward-tasks'],['repeatables','#repeatable-tasks']]) {
      const list = $(selector); list.replaceChildren();
      menu[category].forEach((task,index)=>{
        const row=node('div','task-row '+category); const input=node('input'); input.value=task[1]; input.maxLength=180; input.setAttribute('aria-label',(category==='morning'?'Утреннее дело ':category==='afternoon'?'Дневное дело ':category==='repeatables'?'Повторяемое дело ':'Супердело ')+(index+1)); input.addEventListener('input',()=>task[1]=input.value); row.append(input);
        if(category==='rewards'||category==='repeatables') { const rate=node('input'); rate.type='number';rate.min=1;rate.max=120;rate.value=task[2];rate.setAttribute('aria-label',(category==='repeatables'?'Минуты за повторяемое дело ':'Минуты за супердело ')+(index+1));rate.addEventListener('input',()=>task[2]=rate.valueAsNumber);row.append(rate); }
        if(category!=='morning') {const remove=button('×',()=>{menu[category].splice(index,1);renderTasks();});remove.setAttribute('aria-label','Убрать '+(category==='afternoon'?'дневное дело ':'супердело ')+(index+1));row.append(remove);}
        list.append(row);
      });
    }
    $('#video-title').value=menu.video.title; $('#video-rate').value=menu.video.minutes || menu.video.bats || 10;
  }
  function renderParents() {
    const count=Number($('#parent-count').value), container=$('#parent-cards');container.replaceChildren();
    parentValues.slice(0,count).forEach((parent,index)=>{
      const card=node('div');
      for(const [key,title] of [['name','Имя родителя'],['code','Код из 6 цифр'],['confirm','Повторите код']]) {
        const label=node('label',null,title+' '+(index+1));const input=node('input');input.id='parent-'+index+'-'+key;label.htmlFor=input.id;input.value=parent[key];input.type=key==='name'?'text':'password';input.maxLength=key==='name'?40:6;if(key!=='name'){input.inputMode='numeric';input.autocomplete='new-password';} input.addEventListener('input',()=>parent[key]=input.value);card.append(label,input);
      }
      container.append(card);
    });
  }
  function checkStep(number) {
    if(number===0){const names=children.map(c=>c.name.trim());if(names.some(n=>!n || n.length>24) || new Set(names.map(n=>n.toLocaleLowerCase())).size!==names.length)throw new Error('Введите разные имена для всех детей.');}
    if(number===1){for(const child of children){for(const category of ['morning','afternoon','rewards','repeatables'])for(const task of child.menu[category]){if(!task[1].trim() || task[1].length>180)throw new Error('Заполните названия всех дел.');if((category==='rewards'||category==='repeatables')&&(!Number.isInteger(task[2])||task[2]<1||task[2]>120))throw new Error('Ставка дела — целое число от 1 до 120.');}if(!child.menu.video.title.trim()||!Number.isInteger(child.menu.video.minutes)||child.menu.video.minutes<1||child.menu.video.minutes>120)throw new Error('Проверьте название и ставку повторяемого дела.');}}
    if(number===2){goalEditor.validate();for(const selector of ['#goal-title','#goal-reward'])if(!$(selector).value.trim())throw new Error('Введите цель и то, что ждёт в конце.');for(const [selector,max] of [['#goal-points',50],['#goal-days',30]])if(!Number.isInteger($(selector).valueAsNumber)||$(selector).valueAsNumber<1||$(selector).valueAsNumber>max)throw new Error('Проверьте количество очков и дней.');if(!Number.isInteger($('#goal-skips').valueAsNumber)||$('#goal-skips').valueAsNumber<0||$('#goal-skips').valueAsNumber>30)throw new Error('Количество пропусков — от 0 до 30.');}
    if(number===3){const parents=parentValues.slice(0,Number($('#parent-count').value));if(parents.some(p=>!p.name.trim()||!/^\d{6}$/.test(p.code)||p.code!==p.confirm)||new Set(parents.map(p=>p.code)).size!==parents.length||new Set(parents.map(p=>p.name.trim())).size!==parents.length)throw new Error('Укажите имена родителей и разные шестизначные коды. Повтор кода должен совпадать.');if(!$('#consent').checked)throw new Error('Подтвердите размещение данных на сервере владельца приглашения.');}
  }
  function showStep(number) {
    step=number;steps.forEach((section,index)=>section.hidden=index!==number);document.querySelectorAll('.steps span').forEach((item,index)=>{if(index===number)item.setAttribute('aria-current','step');else item.removeAttribute('aria-current');});$('#previous').hidden=number===0;$('#next').hidden=number===3;$('#finish').hidden=number!==3;$('#step-caption').textContent=(number+1)+' из 4';status('');
    if(number===1)renderTaskChild();if(number===2)goalEditor.render();if(number===3){renderParents();$('#review').textContent='Ваша команда: '+children.map(c=>c.name.trim()).join(', ')+'. Личных целей: '+children.reduce((sum,c)=>sum+c.goals.length,0)+'. У каждой семьи будет отдельный журнал.';}
    window.scrollTo({top:0,behavior:'instant'});
  }
  $('#add-child').addEventListener('click',addChild);
  $('#begin').addEventListener('click',()=>{$('#welcome').hidden=true;$('#wizard').hidden=false;showStep(0);});
  $('#task-child').addEventListener('change',event=>{currentChild=Number(event.target.value);renderTasks();});
  for(const category of ['afternoon','rewards','repeatables'])$('#add-'+category).addEventListener('click',()=>{const tasks=children[currentChild].menu[category];if(tasks.length>=100)return;tasks.push(category==='afternoon'?[id(),'']:[id(),'',10]);renderTasks();});
  $('#video-title').addEventListener('input',event=>children[currentChild].menu.video.title=event.target.value);
  $('#video-rate').addEventListener('input',event=>{children[currentChild].menu.video.minutes=children[currentChild].menu.video.bats=event.target.valueAsNumber;});
  $('#parent-count').addEventListener('change',renderParents);
  $('#next').addEventListener('click',()=>{try{checkStep(step);showStep(step+1);}catch(error){status(error.message);}});
  $('#previous').addEventListener('click',()=>showStep(step-1));
  $('#wizard').addEventListener('submit',async event=>{
    event.preventDefault();if(busy)return;
    try{
      for(let number=0;number<4;number++)checkStep(number);
      busy=true;$('#finish').disabled=true;$('#previous').disabled=true;status('Сохраняем вашу семью…');
      await api('register',{token,consent:$('#consent').checked,config:{profiles:children.map(c=>c.name.trim()),utcOffsetMinutes:Number($('#timezone').value),goal:{title:$('#goal-title').value.trim(),reward:$('#goal-reward').value.trim(),points:$('#goal-points').valueAsNumber,days:$('#goal-days').valueAsNumber,allowOneSkip:$('#goal-skips').valueAsNumber>0,allowedSkips:$('#goal-skips').valueAsNumber},childGoals:children.map(c=>c.goals)},menus:children.map(c=>c.menu),parents:parentValues.slice(0,Number($('#parent-count').value)).map(p=>({name:p.name.trim(),code:p.code})),photos:children.map(c=>c.photo)});
      history.replaceState(null,'','/setup/');$('#wizard').hidden=true;$('#complete').hidden=false;window.scrollTo(0,0);
    }catch(error){status(error.message);if(error.status===410){const link=node('a','secondary','Если вы уже зарегистрировались — открыть кабинет');link.href='/parent/';$('#form-status').append(document.createElement('br'),link);}}finally{busy=false;$('#finish').disabled=false;$('#previous').disabled=false;}
  });
  for(let offset=-720;offset<=840;offset+=15){const option=node('option');option.value=offset;const sign=offset<0?'−':'+';option.textContent='UTC'+sign+String(Math.floor(Math.abs(offset)/60)).padStart(2,'0')+':'+String(Math.abs(offset)%60).padStart(2,'0');$('#timezone').append(option);}$('#timezone').value=-new Date().getTimezoneOffset();
  (async()=>{try{const data=await api('preview',{token});template=data.template;template.video.minutes=template.video.bats=template.video.minutes||template.video.bats||10;addChild();addChild();$('#invite-status').textContent='Приглашение действительно. Настройка займёт несколько минут.';$('#begin').disabled=false;}catch(error){$('#invite-status').textContent=token?error.message:'Для начала нужна личная ссылка-приглашение от владельца сервера.';$('#existing-family').hidden=false;}})();
})();
