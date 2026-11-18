const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {resolve}=require('node:path');
const {spawnSync}=require('node:child_process');
const root=resolve(__dirname,'..');

test('Python and JavaScript agree on recurring periods, custom deadlines, skips and saved history',()=>{
  const program=`
import json,sys,datetime
sys.path.insert(0,'sync')
import goals
cases=[]
for offset in [-720,0,420,840]:
 for anchor_text in ['2026-11-18T08:30:00','2028-01-31T09:15:00']:
  anchor=int(datetime.datetime.fromisoformat(anchor_text).replace(tzinfo=datetime.timezone.utc).timestamp()*1000)
  for elapsed in [3,7,29,31,62]:
   now=anchor+elapsed*goals.DAY+1234
   assigned=[dict(id=str(i+1)*32,kind=kind,startedAt=anchor,durationDays=9 if kind=='individual' else 30 if kind=='monthly' else 7,title=kind,reward='test',points=7+i,days=5+i,allowedSkips=i,allowOneSkip=bool(i)) for i,kind in enumerate(['weekly','monthly','individual'])]
   config=dict(utcOffsetMinutes=offset,childGoals=[assigned])
   first=(anchor+offset*60000)//goals.DAY
   def score(day,child,begin,end):
    n=(day-first)%7
    return dict(score=n*3,morningMet=n>=2,extra=n%3)
   result=goals.evaluate(config,now,first,score)
   cases.append(dict(config=config,now=now,first=first,result=result))
print(json.dumps(cases))
`;
  const response=spawnSync('python3',['-c',program],{cwd:root,encoding:'utf8',maxBuffer:5*1024*1024});assert.equal(response.status,0,response.stderr);
  const sandbox={window:{}};vm.runInNewContext(fs.readFileSync(resolve(root,'web/period-goals.js'),'utf8'),sandbox);
  const engine=sandbox.window.FamilyPeriodGoals;
  for(const [index,scenario]of JSON.parse(response.stdout).entries()){
    const score=day=>{const n=(day-scenario.first)%7;return{score:n*3,morningMet:n>=2,extra:n%3};};
    const actual=engine.evaluate(scenario.config,scenario.now,scenario.first,score);
    assert.deepEqual(JSON.parse(JSON.stringify(actual)),scenario.result,'case '+index);
    const today=Math.floor((scenario.now+scenario.config.utcOffsetMinutes*60000)/86400000);
    const restored=engine.evaluate(scenario.config,scenario.now,scenario.first,day=>{assert.equal(day,today,'old history must use server checkpoint');return score(day);},scenario.result);
    assert.deepEqual(JSON.parse(JSON.stringify(restored)),scenario.result,'checkpoint '+index);
  }
});

test('two allowed misses survive and a third miss resets the legacy series',()=>{
  const sandbox={window:{}};for(const file of ['family-config.js','rules.js'])vm.runInNewContext(fs.readFileSync(resolve(root,'web',file),'utf8'),sandbox);
  const api=sandbox.window.FamilyRules,first=Date.UTC(2026,10,18)/86400000,today=first+4;
  const menu=api.menuFor(0,first),ids=menu.morning.concat(menu.afternoon).slice(0,10).map(([id])=>id);
  function progress(allowed){const records={};for(let day=first;day<=today;day++){records[day]=[api.blank(),api.blank(),api.blank()];if(day===first||day===first+3)for(const id of ids){records[day][0].base[id]='06:40';records[day][0].order.push('base:'+id);}}const state={first,today,records,longGoal:{start:first,skipSince:first,points:10,days:10,allowedSkips:allowed,carry:[0,1,2].map(()=>({streak:0,earned:false,missCount:0,surplus:0}))}};return api.createStats(state,()=> '07:10').longGoalProgress(0);}
  assert.equal(progress(2).streak,2);assert.equal(progress(2).missCount,2);assert.equal(progress(1).streak,1);assert.equal(progress(1).missCount,0);
});
