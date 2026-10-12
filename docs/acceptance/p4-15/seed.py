import sqlite3,json,uuid
from pathlib import Path
# Only use the disposable fixture DB, after launching the App once to migrate it.
c=sqlite3.connect('/tmp/sc-p415/fixture.db')
c.execute('delete from commander_runs')
for name,prompts,state in [ ('并行与依赖', [('a','slow',[]),('b','fast',[]),('c','fast',['a','b'])],'draft'),('失败与跳过',[('a','fail',[]),('b','fast',['a'])],'draft'),('取消验收',[('a','hang',[]),('b','fast',['a'])],'draft'),('失活记录',[('a','hang',[])],'running') ]:
 tasks=[dict(id=i,title=name+' '+i,agent_id='opencode',prompt=p,depends_on=d) for i,p,d in prompts]
 plan=dict(version=1,objective=name,tasks=tasks)
 states=[dict(id=t['id'],status='running' if state=='running' else 'pending',session_id=None) for t in tasks]
 c.execute('insert into commander_runs values(?,?,?,?,?,?,?,?)',(str(uuid.uuid4()),json.dumps(plan,ensure_ascii=False),'/tmp/sc-p415/project',state,json.dumps(states),0,'2026-10-12T00:00:00Z','2026-10-12T00:00:00Z'))
c.commit()
