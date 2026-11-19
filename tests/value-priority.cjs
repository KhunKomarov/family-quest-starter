const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {resolve}=require('node:path'),{spawnSync}=require('node:child_process');
const root=resolve(__dirname,'..'),box={window:{}};
for(const name of ['family-config.js','rules.js']){const p=resolve(root,'web',name);if(fs.existsSync(p))vm.runInNewContext(fs.readFileSync(p,'utf8'),box);}
const R=box.window.FamilyRules,day=Date.UTC(2026,10,19)/86400000;
const essentials=['bed','teeth','dress','breakfast','car'];
const menu={morning:essentials.map(x=>[x,x]),afternoon:[['wash','Wash'],['toys','Toys'],['dish-out','Dishwasher'],['trash','Trash'],['reflective-vest','Vest']],afternoonMinutes:5,rewards:[['music','Music',15]],video:{title:'Video',minutes:15,bats:0}};
const rates={wash:5,toys:5,'dish-out':10,trash:10,'reflective-vest':10};
function calculate(tasks,{when=day,debt=0}={}){
 const e=R.blank();for(const task of tasks){if(task==='remark')e.remarks++;else if(task==='parent'){e.parentPoints++;e.order.push(task);}else if(task.startsWith('bonus:')){e.rewards.push(task.slice(6));e.order.push(task);}else if(task.startsWith('video:')){e.videos++;e.order.push('video');}else{e.base[task]='12:00';e.order.push('base:'+task);}}
 const order=JSON.stringify(e.order),s={first:when,today:when,syncedStart:when,startTargets:[7,7,7],startRecovery:[Array.from({length:debt},(_,i)=>when-i-1),[],[]],recoverySince:when,catalog:[[0,[menu,menu,menu]]],records:{[when]:[e,R.blank(),R.blank()]}};
 const v=R.createStats(s,()=> '07:10').info(0);assert.equal(JSON.stringify(e.order),order,'calculation must not reorder the journal');return v;
}
test('the cheapest completed tasks cover the norm and the highest value survives any tap order',()=>{
 const expensiveFirst=essentials.concat(['dish-out','trash','wash']);
 const v=calculate(expensiveFirst);assert.deepEqual([v.score,v.credit.minutes,v.credit.bats],[8,10,0]);assert.equal(v.credit.awards.get('base:trash'),'+10 мин');assert.equal(v.credit.awards.has('base:wash'),false);
 assert.equal(calculate(essentials.concat(['wash','dish-out','trash'])).credit.minutes,10);
 assert.equal(calculate(expensiveFirst,{when:day-1}).credit.minutes,5,'previous dates retain chronological allocation');
});
test('server and UI maximize reward value while preserving gates, remarks, parents and recovery',()=>{
 let seed=97;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed;},cases=[];
 for(let n=0;n<240;n++){
  const chores=Object.keys(rates).filter(()=>random()%3),parents=random()%6,remarks=random()%4,debt=random()%3;
  const tasks=essentials.concat(chores,Array(parents).fill('parent'),Array(remarks).fill('remark'));
  if(n%3===0)tasks.push('bonus:music');for(let v=0;v<n%4;v++)tasks.push('video:'+v);
  if(n%7===0)tasks.splice(tasks.indexOf('car'),1);
  const candidates=chores.map(id=>rates[id]).concat(Array(parents).fill(5)).sort((a,b)=>a-b);
  const score=essentials.filter(id=>tasks.includes(id)).length+chores.length+parents-remarks;
  const ready=essentials.every(id=>tasks.includes(id))&&score>=7+debt;
  const value=ready?candidates.slice(Math.max(0,7+debt+remarks-5)).reduce((a,b)=>a+b,0)+(tasks.includes('bonus:music')?15:0)+(n%4)*15:0;
  const expected=[Math.min(30,value),Math.max(0,value-30)];
  for(let i=tasks.length-1;i>0;i--){const j=random()%(i+1);[tasks[i],tasks[j]]=[tasks[j],tasks[i]];}
  const actual=calculate(tasks,{debt}).credit;assert.deepEqual([actual.minutes,actual.bats],expected,JSON.stringify({tasks,debt}));
  const reverse=calculate(tasks.slice().reverse(),{debt}).credit;assert.deepEqual([reverse.minutes,reverse.bats],expected);
  cases.push({tasks,debt,expected});
 }
 const program=`import sys,json;sys.path.insert(0,'sync');import family
payload=json.load(sys.stdin);menu=payload['menu'];out=[]
for c in payload['cases']:
 marks=[(payload['day']*family.DAY-family.OFFSET+12*3600000+i,str(i),task) for i,task in enumerate(c['tasks'])]
 required=set(payload['essentials']);eligible=required|{task for task,_ in menu['afternoon']}
 r=family.daily_reward(marks,menu,payload['day'],7,required,required,eligible,c['debt'])
 out.append([r[3],r[1]])
print(json.dumps(out))`;
 const r=spawnSync('python3',['-c',program],{cwd:root,input:JSON.stringify({cases,menu,day,essentials}),encoding:'utf8'});assert.equal(r.status,0,r.stderr);const actual=JSON.parse(r.stdout);cases.forEach((c,i)=>assert.deepEqual(actual[i],c.expected));
});
