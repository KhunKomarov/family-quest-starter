(() => {
  'use strict';
  const text=(tag,label,className)=>{const node=document.createElement(tag);if(label!==undefined)node.textContent=label;if(className)node.className=className;return node;};
  const types={weekly:'Еженедельная цель',monthly:'Ежемесячная цель',individual:'Индивидуальная цель'};
  function attach(container,readGroups,readNames){
    let selected=0;
    function input(card,goal,key,label,{number=false,min,max}={}){
      const wrap=text('label',label),field=document.createElement('input');field.type=number?'number':'text';field.value=goal[key];field.setAttribute('aria-label',label);if(number){field.min=min;field.max=max;field.step=1;}else field.maxLength=80;
      field.addEventListener('input',()=>goal[key]=number?field.valueAsNumber:field.value);wrap.append(field);card.append(wrap);return field;
    }
    function render(){
      const names=readNames(),groups=readGroups();selected=Math.min(selected,names.length-1);container.replaceChildren();
      const label=text('label','Цели ребёнка'),selector=document.createElement('select');selector.setAttribute('aria-label','Цели ребёнка');names.forEach((name,index)=>{const option=text('option',name||'Ребёнок '+(index+1));option.value=index;selector.append(option);});selector.value=selected;selector.addEventListener('change',()=>{selected=Number(selector.value);render();});label.append(selector);container.append(label);
      const buttons=text('div',undefined,'goal-add-buttons');
      for(const kind of Object.keys(types)){const add=text('button','＋ '+types[kind],'secondary');add.type='button';add.disabled=groups[selected].length>=10;add.addEventListener('click',()=>{const id=Array.from(crypto.getRandomValues(new Uint8Array(16)),v=>v.toString(16).padStart(2,'0')).join('');groups[selected].push({id,kind,title:types[kind],reward:'Выбрать семейное занятие',points:10,days:kind==='weekly'?5:kind==='monthly'?20:10,allowedSkips:kind==='monthly'?5:1,allowOneSkip:true,durationDays:kind==='weekly'?7:kind==='monthly'?30:14});render();});buttons.append(add);}
      container.append(buttons);
      if(!groups[selected].length)container.append(text('p','Добавьте одну или несколько целей. У других детей могут быть совсем другие условия.','fine'));
      groups[selected].forEach((goal,index)=>{
        const card=text('article',undefined,'goal-editor-card');const header=text('div',undefined,'section-title');header.append(text('h3',types[goal.kind]));const remove=text('button','Убрать','secondary');remove.type='button';remove.addEventListener('click',()=>{groups[selected].splice(index,1);render();});header.append(remove);card.append(header);
        input(card,goal,'title','Название цели');input(card,goal,'reward','Что ждёт в конце');
        const values=text('div',undefined,'goal-fields');input(values,goal,'points','Очков за шаг',{number:true,min:1,max:50});input(values,goal,'days','Шагов до цели',{number:true,min:1,max:366});input(values,goal,'allowedSkips','Можно пропустить дней в серии',{number:true,min:0,max:31});card.append(values);
        if(goal.kind==='individual')input(card,goal,'durationDays','Срок цели в днях',{number:true,min:1,max:366});
        const note=goal.kind==='weekly'?'Каждые 7 дней начинается новый период.':goal.kind==='monthly'?'Новый период начинается через календарный месяц от даты старта.':'Разовая цель: по окончании срока она не начинается заново.';
        card.append(text('p',note+' Отсчёт — от создания цели. Смена срока начинает её заново; другие изменения пересчитывают текущий прогресс.','fine'));container.append(card);
      });
    }
    function validate(){for(const group of readGroups())for(const goal of group){if(!goal.title.trim()||!goal.reward.trim())throw new Error('Заполните название и результат каждой цели.');for(const [key,min,max]of[['points',1,50],['days',1,366],['allowedSkips',0,31],['durationDays',1,366]])if(!Number.isInteger(goal[key])||goal[key]<min||goal[key]>max)throw new Error('Проверьте очки, шаги, пропуски и срок целей.');goal.allowOneSkip=goal.allowedSkips>0;}}
    return {render,validate};
  }
  window.FamilyGoalEditor={attach};
})();
