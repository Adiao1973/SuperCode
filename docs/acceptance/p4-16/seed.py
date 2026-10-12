import sqlite3,json,uuid
from pathlib import Path
# Launch the App once with this disposable SUPERCODE_DB to migrate, then close it.
c=sqlite3.connect('/tmp/sc-p416/fixture.db')
c.execute('delete from commander_runs')
for name in ['同名审批并发','取消审批验收','退出审批验收']:
 tasks=[dict(id='command',title=name+' 命令任务',agent_id='opencode',prompt='command',depends_on=[]),dict(id='edit',title=name+' 编辑任务',agent_id='opencode',prompt='edit',depends_on=[])]
 plan=dict(version=1,objective=name,tasks=tasks)
 states=[dict(id=t['id'],status='pending',session_id=None) for t in tasks]
 c.execute('insert into commander_runs values(?,?,?,?,?,?,?,?)',(str(uuid.uuid4()),json.dumps(plan,ensure_ascii=False),'/tmp/sc-p416/project','draft',json.dumps(states),0,'2026-10-13T00:00:00Z','2026-10-13T00:00:00Z'))
c.commit()
