"""Loopback-only planner fixture. Never records authorization or executes tasks."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json,re,time
ROOT=Path('/tmp/sc-p418')
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_POST(self):
  payload=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  system=payload['messages'][0]['content']; objective=payload['messages'][1]['content']
  agents=json.loads(re.search(r'Choose agent_id only from this JSON array: (\[[^\]]*\])',system)[1])
  with (ROOT/'model-requests.jsonl').open('a') as f:f.write(json.dumps({'objective':objective,'agents':agents},ensure_ascii=False)+'\n')
  mode=(ROOT/'mode').read_text().strip()
  if mode=='fail': self.send_error(503,'Synthetic unavailable'); return
  time.sleep(40 if mode=='slow' else .6)
  plan={'version':1,'objective':objective,'tasks':[{'id':'review','title':'审阅中文目标','agent_id':agents[0],'prompt':'只生成计划，等待用户确认。','depends_on':[]}]}
  raw=json.dumps({'choices':[{'finish_reason':'stop','message':{'role':'assistant','content':json.dumps(plan,ensure_ascii=False)}}]}).encode()
  self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();
  try: self.wfile.write(raw)
  except BrokenPipeError: pass
ThreadingHTTPServer(('127.0.0.1',18518),Handler).serve_forever()
