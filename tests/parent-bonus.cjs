const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {resolve}=require('node:path'),{spawnSync}=require('node:child_process');
const root=resolve(__dirname,'..'),box={window:{}};
for(const file of ['family-config.js','rules.js']){const p=resolve(root,'web',file);if(fs.existsSync(p))vm.runInNewContext(fs.readFileSync(p,'utf8'),box);}
const R=box.window.FamilyRules,day=Date.UTC(2026,10,19)/86400000;
const morning=[['bed','Bed'],['teeth','Teeth'],['dress','Dress'],['breakfast','Breakfast'],['car','Car']];
const ids=morning.map(([id])=>id),minimum=ids.concat(['wash','toys']);
const menu={morning,afternoon:[['wash','Wash'],['toys','Toys'],['extra','Extra']],afternoonMinutes:5,rewards:[['fill28','Fill',28],['fill30','Fill',30]],video:{title:'Video',minutes:15,bats:0}};
function calculate(tasks,when=day,debt=0){
 const entry=R.blank();for(const task of tasks){if(task==='parent'){entry.parentPoints++;entry.order.push(task);}else if(task==='remark')entry.remarks++;else if(task.startsWith('bonus:')){entry.rewards.push(task.slice(6));entry.order.push(task);}else if(task.startsWith('video:')){entry.videos++;entry.order.push('video');}else{entry.base[task]='12:00';entry.order.push('base:'+task);}}
 const state={first:when,today:when,syncedStart:when,startTargets:[7,7,7],startRecovery:[Array.from({length:debt},(_,i)=>when-i-1),[],[]],catalog:[[0,[menu,menu,menu]]],records:{[when]:[entry,R.blank(),R.blank()]},recoverySince:when};
 const result=R.createStats(state,()=> '07:10').info(0);return {minutes:result.credit.minutes,bats:result.credit.bats,score:result.score,met:result.met};
}
test('parent bonus follows the minimum, restoration, cap and remark recalculation',()=>{
 const cases=[
  [minimum.concat('parent'),0,[5,0]],
  [minimum.concat('bonus:fill28','parent'),0,[30,3]],
  [minimum.concat('bonus:fill30','parent'),0,[30,5]],
  [minimum.slice(0,6).concat('parent'),0,[0,0]],
  [Array(4).fill('parent').concat(ids),0,[10,0]],
  [Array(20).fill('parent').concat(ids.slice(0,4)),0,[0,0]],
  [minimum.concat('bonus:fill28','parent','remark'),0,[28,0]],
  [minimum.concat('parent','parent','parent'),2,[5,0]],
 ];
 for(const [tasks,debt,expected]of cases){const r=calculate(tasks,day,debt);assert.deepEqual([r.minutes,r.bats],expected,JSON.stringify(tasks));}
 const old=calculate(minimum.concat('parent','parent'),day-1);assert.deepEqual([old.minutes,old.bats],[0,0]);
 const restored=calculate(minimum.concat('parent','remark'));assert.equal(restored.score,7);assert.equal(restored.met,true);
 const missed=calculate(minimum.concat('remark'));assert.equal(missed.score,6);assert.equal(missed.met,false);
});
test('server and both shared UIs agree across early and late parental decisions',()=>{
 let seed=29;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed;};const cases=[];
 for(let index=0;index<140;index++){
  const tasks=minimum.concat(Array(random()%9).fill('parent'),Array(random()%3).fill('remark'),['extra','bonus:fill28','video:1']);
  for(let i=tasks.length-1;i>0;i--){const j=random()%(i+1);[tasks[i],tasks[j]]=[tasks[j],tasks[i]];}
  if(index%5===0)tasks.splice(tasks.indexOf('car'),1);
  const when=index%4===0?day-1:day,debt=index%4,actual=calculate(tasks,when,debt);
  cases.push({tasks,day:when,debt,menu,actual});
 }
 const program=`import sys,json;sys.path.insert(0,'sync');import family
out=[]
for c in json.load(sys.stdin):
 required=set(['bed','teeth','dress','breakfast','car']);eligible=required|{'wash','toys','extra'}
 marks=[(c['day']*family.DAY-family.OFFSET+12*3600000+i,str(i),task) for i,task in enumerate(c['tasks'])]
 r=family.daily_reward(marks,c['menu'],c['day'],7,required,required,eligible,c['debt'])
 out.append([r[3],r[1]])
print(json.dumps(out))`;
 const response=spawnSync('python3',['-c',program],{cwd:root,input:JSON.stringify(cases),encoding:'utf8'});assert.equal(response.status,0,response.stderr);
 const expected=JSON.parse(response.stdout);cases.forEach((c,i)=>assert.deepEqual([c.actual.minutes,c.actual.bats],expected[i],JSON.stringify(c)));
});
