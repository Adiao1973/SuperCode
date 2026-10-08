import http from 'node:http';
const mode=process.argv[2] ?? 'ok';
const server=http.createServer(async(req,res)=>{
  let text='';for await(const chunk of req) text+=chunk;
  process.stdout.write('request\n');
  let request;try{request=JSON.parse(text)}catch{res.writeHead(400).end();return}
  if(req.headers.authorization!=='Bearer local-fixture-key' || request.model!=='fixture-model' || request.stream!==false){res.writeHead(401).end('local-fixture-key');return}
  if(mode==='slow' || (mode==='desktop' && request.messages[1].content.includes('slow-generation'))){return}
  if(mode==='error'){res.writeHead(403).end('local-fixture-key');return}
  let plan={version:1,objective:request.messages[1].content,tasks:[{id:'design',title:'Design',agent_id:'codex',prompt:'Design only',depends_on:[]}]};
  if(mode.startsWith('cli-') || mode==='desktop') plan={version:1,objective:request.messages[1].content,tasks:[
    {id:'a',title:'A',agent_id:'opencode',prompt:mode==='desktop'?(request.messages[1].content.includes('fail')?'fail':request.messages[1].content.includes('hang')?'hang':'permission'):mode==='cli-fail'?'fail':mode==='cli-hang'?'hang':'slow',depends_on:[]},
    {id:'b',title:'B',agent_id:'codex',prompt:mode==='desktop' && request.messages[1].content.includes('parallel')?'permission':'fast',depends_on:[]},
    {id:'c',title:'C',agent_id:'opencode',prompt:'fast',depends_on:['a']}
  ]};
  res.setHeader('Content-Type' ,'application/json');
  res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(plan)}}]}));
});
server.listen(0,'127.0.0.1',()=>process.stdout.write(`http://127.0.0.1:${server.address().port}/v1/chat/completions\n`));

setTimeout(()=>process.exit(0),mode==='desktop'?1800000:10000).unref();
