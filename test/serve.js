const http=require("http"),fs=require("fs"),path=require("path");
const ROOT=path.resolve(__dirname,"..");
const T={".html":"text/html",".js":"text/javascript",".css":"text/css",".png":"image/png",
         ".woff2":"font/woff2",".json":"application/json"};
http.createServer((q,s)=>{
  if(q.method==="POST"&&q.url.startsWith("/upload/")){
    const name=path.basename(decodeURIComponent(q.url.slice(8)));
    const dest=path.join(ROOT,"fixtures","live",name);
    let body=""; q.on("data",c=>body+=c);
    q.on("end",()=>{fs.writeFileSync(dest,body);
      s.writeHead(200,{"Access-Control-Allow-Origin":"*"});s.end("saved "+body.length);});
    return;
  }
  if(q.method==="OPTIONS"){s.writeHead(204,{"Access-Control-Allow-Origin":"*",
    "Access-Control-Allow-Methods":"POST,GET","Access-Control-Allow-Headers":"content-type"});return s.end();}
  const rel=decodeURIComponent(q.url.split("?")[0]).replace(/^\/+/,"")||"test/extract.html";
  const f=path.join(ROOT,rel);
  if(!f.startsWith(ROOT)){s.writeHead(403);return s.end();}
  fs.readFile(f,(e,b)=>{
    if(e){s.writeHead(404);return s.end("404 "+rel);}
    // CORS on GET so a live product page can pull the extractor in and run it
    // against its own rendered DOM — see test/live-rendered.md.
    s.writeHead(200,{"Content-Type":T[path.extname(f)]||"application/octet-stream",
                     "Access-Control-Allow-Origin":"*"});
    s.end(b);
  });
}).listen(8731,()=>console.log("serving on http://localhost:8731"));
