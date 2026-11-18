(() => {
  'use strict';
  const DAY = 86400000;
  function monthAt(anchor, months, offset) {
    const local = new Date(anchor + offset), year = local.getUTCFullYear(), month = local.getUTCMonth() + months;
    const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return Date.UTC(year, month, Math.min(local.getUTCDate(), last), local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds(), local.getUTCMilliseconds()) - offset;
  }
  function windowFor(goal, now, offset) {
    const anchor = goal.startedAt;
    if (goal.kind === 'monthly') {
      const start = new Date(anchor + offset), current = new Date(now + offset);
      let index = Math.max(0, (current.getUTCFullYear() - start.getUTCFullYear()) * 12 + current.getUTCMonth() - start.getUTCMonth());
      if (monthAt(anchor, index, offset) > now && index) index--;
      return [monthAt(anchor, index, offset), monthAt(anchor, index + 1, offset)];
    }
    const duration = (goal.kind === 'weekly' ? 7 : goal.durationDays) * DAY;
    const index = goal.kind === 'weekly' ? Math.max(0, Math.floor((now - anchor) / duration)) : 0;
    return [anchor + index * duration, anchor + (index + 1) * duration];
  }
  function evaluate(config, now, first, scoreFor, saved = []) {
    const results = [], offset = config.utcOffsetMinutes * 60000, today = Math.floor((now + offset) / DAY);
    (config.childGoals || []).forEach((assigned, child) => {
      for (const goal of assigned) {
        if (!goal.startedAt || now < goal.startedAt) continue;
        const [begin, end] = windowFor(goal, now, offset), threshold = goal.points, target = goal.days;
        const allowed = goal.allowedSkips === undefined ? Number(Boolean(goal.allowOneSkip)) : goal.allowedSkips;
        const expired = goal.kind === 'individual' && now >= end;
        const archived = saved.find(row => row.child === child && row.id === goal.id && row.windowStart === begin && row.windowEnd === end);
        if (expired && archived && archived.expired) { results.push(archived); continue; }
        const last = Math.min(today, Math.floor((end - 1 + offset) / DAY)), closedUntil = expired ? last + 1 : today;
        let steps = 0, carry = 0, missed = 0, earned = false;
        const seed = !expired && saved.find(row => row.child === child && row.id === goal.id && row.windowStart === begin && row.windowEnd === end);
        if (seed) { steps = seed.confirmed; carry = seed.carried; missed = seed.missCount; earned = seed.baseEarned; }
        for (let day = seed ? today : Math.max(Math.floor((begin + offset) / DAY), first); day < closedUntil; day++) {
          const row = scoreFor(day, child, begin, end), raw = row.morningMet ? row.score : 0;
          const points = carry + raw + (raw >= threshold ? row.extra || 0 : 0), gained = Math.floor(points / threshold);
          if (gained) { steps += gained; carry = points % threshold; }
          else if (steps && missed < allowed) { missed++; carry = 0; }
          else { steps = carry = missed = 0; }
          if (steps >= target) { earned = true; break; }
        }
        const row = !expired ? scoreFor(today, child, begin, end) : {score:0,morningMet:false};
        const raw = row.morningMet ? row.score : 0;
        const points = carry + raw + (raw >= threshold ? row.extra || 0 : 0), confirmed = Math.min(steps, target), baseEarned = earned;
        if (!earned && !expired) { steps += Math.floor(points / threshold); earned = steps >= target; }
        const complete = Math.min(steps, target), remainder = earned || expired ? 0 : points % threshold;
        const cells = Array.from({length: target}, (_, index) => ({phase: index < confirmed ? 'complete' : index <= complete ? 'today' : 'future',
          fill: index < complete ? 100 : index === complete ? remainder / threshold * 100 : 0}));
        results.push({...goal, child, windowStart:begin, windowEnd:end, streak:complete, earned, expired,
          missCount:missed, allowedSkips:allowed, todayPoints:points, carried:carry, confirmed, baseEarned, cells});
      }
    });
    return results;
  }
  function fromJournal(config, now, first, cells, adjustments, catalog, saved = []) {
    const marks = new Map(), corrections = new Map();
    for (const cell of cells.values()) { if (!cell[4]) continue; const key=cell[0]+'/'+cell[1];if(!marks.has(key))marks.set(key,[]);marks.get(key).push(cell); }
    for (const row of adjustments || []) {const key=row[0]+'/'+row[1];if(!corrections.has(key))corrections.set(key,[]);corrections.get(key).push(row);}
    return evaluate(config,now,first,(day,child,begin,end)=>{
      const menu=window.FamilyRules.menuFor(child,day,catalog), rows=marks.get(day+'/'+child)||[];
      const all=new Set(rows.filter(row=>row[3]<end).map(row=>row[2]));
      const marked=new Set(rows.filter(row=>row[3]>=begin&&row[3]<end).map(row=>row[2]));
      const required=window.FamilyRules.morningTasks.map(([id])=>id);
      const eligible=new Set(menu.morning.concat(menu.afternoon).map(([id])=>id));
      const adjustment=(corrections.get(day+'/'+child)||[]).filter(row=>row[3]>=begin&&row[3]<end).reduce((sum,row)=>sum+row[2],0);
      return {morningMet:required.every(id=>all.has(id)),score:Math.max(0,[...marked].filter(id=>eligible.has(id)).length+adjustment),extra:[...marked].filter(id=>/^(bonus:|video:|repeat:)/.test(id)).length};
    },saved);
  }
  function render(container, results, profiles, {compact=false}={}) {
    const focused = container.contains(document.activeElement) ? document.activeElement.dataset.goalFocus : null;
    container.replaceChildren();container.hidden=!results.length;
    for(const goal of results){
      const card=document.createElement('article');card.className='period-goal '+goal.kind;card.tabIndex=0;card.dataset.goalFocus=goal.child+'/'+goal.id;
      const header=document.createElement('strong');header.textContent=profiles[goal.child]+' · '+({weekly:'Еженедельная цель',monthly:'Ежемесячная цель',individual:'Индивидуальная цель'}[goal.kind]);
      const title=document.createElement('div');title.textContent=goal.title;
      const status=document.createElement('small');status.textContent=goal.earned?'✓ Цель достигнута':(goal.expired?'Срок завершён · ':'')+goal.streak+' / '+goal.days+' шагов · '+goal.points+' очков за шаг';
      const track=document.createElement('div');track.className='period-goal-track';track.setAttribute('role','progressbar');track.setAttribute('aria-label',profiles[goal.child]+': '+goal.title);track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax',goal.days);track.setAttribute('aria-valuenow',goal.streak);
      for(const cell of goal.cells){const segment=document.createElement('i');segment.style.setProperty('--fill',cell.fill+'%');track.append(segment);}
      const detail=document.createElement('small');detail.textContent='Пропуски: '+goal.missCount+'/'+goal.allowedSkips+' · '+goal.reward;
      card.append(header,title,status,track,detail);
      if(!compact){const dates=document.createElement('small');const format=ms=>new Date(ms+(window.FamilyConfig.utcOffsetMinutes*60000)).toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:'UTC'});dates.textContent='До '+format(goal.windowEnd)+(goal.kind==='individual'?'':' · затем новый период');card.append(dates);}
      container.append(card);
    }
    if(focused){const replacement=[...container.children].find(card=>card.dataset.goalFocus===focused);if(replacement)replacement.focus({preventScroll:true});}
  }
  window.FamilyPeriodGoals={monthAt,windowFor,evaluate,fromJournal,render};
})();
