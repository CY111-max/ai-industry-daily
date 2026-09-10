const http=require('http'),fs=require('fs'),path=require('path');
const root=__dirname;
const types={'.html':'text/html; charset=utf-8','.json':'application/json; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png'};
http.createServer((req,res)=>{
  let p=decodeURIComponent((req.url||'/').split('?')[0]);
  if(p==='/')p='/index.html';
  const f=path.join(root,p);
  if(!f.startsWith(root)){res.writeHead(403);res.end();return}
  fs.readFile(f,(e,buf)=>{
    if(e){res.writeHead(404,{'Content-Type':'text/plain'});res.end('404');return}
    res.writeHead(200,{'Content-Type':types[path.extname(f)]||'application/octet-stream','Cache-Control':'no-store'});
    res.end(buf);
  });
}).listen(8777,'127.0.0.1',()=>console.log('serving http://127.0.0.1:8777'));
