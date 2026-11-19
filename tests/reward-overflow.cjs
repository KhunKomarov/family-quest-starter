const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {resolve}=require('node:path'),{spawnSync}=require('node:child_process');
const root=resolve(__dirname,'..'),sandbox={window:{}};
for(const file of ['family-config.js','rules.js']){const path=resolve(root,'web',file);if(fs.existsSync(path))vm.runInNewContext(fs.readFileSync(path,'utf8'),sandbox);}
const R=sandbox.window.FamilyRules,day=Date.UTC(2026,10,19)/86400000;
function python(program,data){const r=spawnSync('python3',['-c',program],{cwd:root,input:JSON.stringify(data),encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
test('server and shared UI preserve reward value for every remaining minute',()=>{
 const cases=[];for(const when of [day-1,day])for(let minutes=0;minutes<=30;minutes++)for(const rate of [1,5,10,15,30,60,120])cases.push([rate,minutes,when]);
 const expected=python("import sys,json;sys.path.insert(0,'sync');import family;print(json.dumps([family.split_reward(*case) for case in json.load(sys.stdin)]))",cases);
 cases.forEach(([rate,minutes,when],i)=>{const a=R.splitReward(rate,minutes,when);assert.deepEqual([a.minutes,a.bats],expected[i]);if(when===day)assert.equal(a.minutes+a.bats,rate);});
 assert.match(R.offer(15,25,day),/^\+5 мин · \+10 /);assert.equal(R.offer(15,25,day-1),'+5 мин');
});
test('daily tasks, super tasks and repeated videos split only after the same gates',()=>{
 const morning=[['bed','Bed'],['teeth','Teeth'],['dress','Dress'],['breakfast','Breakfast'],['car','Car']];
 const menu={morning,afternoon:[['wash','Wash'],['toys','Toys'],['dish-out','Разобрать посудомойку']],afternoonMinutes:10,rewards:[['fill','Fill',25],['reward','Reward',15],['big','Big',60]],video:{title:'Video',minutes:15,bats:0}};
 const minimum=morning.map(([id])=>id).concat(['wash','toys']);
 const streams=[['bonus:fill','bonus:reward'],['bonus:big'],['bonus:fill','video:1'],['bonus:fill','dish-out'],['bonus:reward','bonus:big'],['video:1','video:2','video:3']],cases=[];
 for(const when of [day-1,day])for(const stream of streams)for(const ready of [false,true]){
  const tasks=(ready?minimum:minimum.slice(1)).concat(stream),entry=R.blank();
  for(const task of tasks){if(task.startsWith('bonus:')){entry.rewards.push(task.slice(6));entry.order.push(task);}else if(task.startsWith('video:')){entry.videos++;entry.order.push('video');}else{entry.base[task]='12:00';entry.order.push('base:'+task);}}
  const state={first:when,today:when,catalog:[[0,[menu,menu,menu]]],records:{[when]:[entry,R.blank(),R.blank()]},recoverySince:when};
  const c=R.createStats(state,()=> '07:10').info(0).credit;cases.push({day:when,menu,tasks,eligible:minimum.concat(['dish-out']),minutes:c.minutes,bats:c.bats});
 }
 const expected=python(`import json,sys;sys.path.insert(0,'sync');import family
out=[]
for c in json.load(sys.stdin):
 marks=[(c['day']*family.DAY-family.OFFSET+12*3600000+i,str(i),t) for i,t in enumerate(c['tasks'])]
 required=set(['bed','teeth','dress','breakfast','car'])
 r=family.daily_reward(marks,c['menu'],c['day'],7,required,required,set(c['eligible']))
 out.append([r[3],r[1]])
print(json.dumps(out))`,cases);
 cases.forEach((c,i)=>assert.deepEqual([c.minutes,c.bats],expected[i],JSON.stringify(c.tasks)));
 assert.deepEqual([cases[13].minutes,cases[13].bats],[30,10]);
});
