"""Create a disposable released-v1 database. Synthetic records only; refuses overwrite."""
import hashlib,json,sqlite3,sys,uuid
from pathlib import Path
path=Path(sys.argv[1]);project=str(Path(sys.argv[2]).resolve())
if path.exists(): raise SystemExit('Refusing to overwrite database')
path.parent.mkdir(parents=True,exist_ok=True)
c=sqlite3.connect(path)
c.execute('CREATE TABLE _sqlx_migrations(version BIGINT PRIMARY KEY,description TEXT NOT NULL,installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,success BOOLEAN NOT NULL,checksum BLOB NOT NULL,execution_time BIGINT NOT NULL)')
for migration in sorted((Path(__file__).resolve().parents[3]/'crates/core/migrations').glob('*.sql')):
 version=int(migration.name.split('_')[0])
 if version>7: continue
 raw=migration.read_bytes();c.executescript(raw.decode())
 c.execute('INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(?,?,1,?,0)',(version,migration.stem.split('_',1)[1].replace('_',' '),hashlib.sha384(raw).digest()))
now='2026-10-17T00:00:00Z';session=str(uuid.uuid4())
c.execute("INSERT INTO agents VALUES('opencode','OpenCode','acp','{}','{}','synthetic',?)",(now,))
for ident,name,directory,kind in [('default','默认空间',None,'default'),('project','升级项目',project,'project')]:c.execute('INSERT INTO workspaces VALUES(?,?,?,?,?)',(ident,name,directory,kind,now))
c.execute('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?)',(session,'opencode','historical-acp',project,'1.0 中文历史','completed',now,now,'project'))
c.execute('INSERT INTO messages VALUES(?,?,?,?,?)',(str(uuid.uuid4()),session,'agent',json.dumps([{'type':'text','text':'P423 历史中文与代码 `保留`'}]),now))
c.execute('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)',(str(uuid.uuid4()),'1.0 保留任务',project,'review',now,now,'project','historical-acp'))
c.execute("INSERT INTO permission_rules VALUES('fixture-rule','synthetic:never','ask',?)",(now,))
for title in ['并发审批验收','取消与依赖阻断验收']:
 tasks=[{'id':'a','title':'审批 A','agent_id':'opencode','prompt':'permission','depends_on':[]},{'id':'b','title':'审批 B','agent_id':'codex','prompt':'permission','depends_on':[]},{'id':'c','title':'依赖任务','agent_id':'opencode','prompt':'child','depends_on':['a','b']}]
 plan={'version':1,'objective':title,'tasks':tasks}
 states=[{'id':t['id'],'status':'pending','session_id':None} for t in tasks]
 c.execute('INSERT INTO commander_runs VALUES(?,?,?,?,?,?,?,?)',(str(uuid.uuid4()),json.dumps(plan),project,'draft',json.dumps(states),0,now,now))
c.commit();c.close();print('Synthetic v1 fixture created (7 migrations, 1 historical session, 2 draft plans).')
