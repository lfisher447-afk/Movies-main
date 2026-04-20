'use strict';
// ═══════════════════════════════════════════════════════════════════
//  BingeBox Omega — server.js  v3.0 (Full Monolithic Core)
//  Ultimate Cinematic Streaming Engine Backend
//  Deploy: mkdir public && cp BingeBox_Omega_v3_FINAL.html public/index.html
//          npm install && node server.js
//  Env vars: TMDB_API_KEY, PORT (default 3000), NODE_ENV, LOG_DIR
// ═══════════════════════════════════════════════════════════════════

const fs          = require('fs');
const path        = require('path');
const os          = require('os');
const https       = require('https');
const zlib        = require('zlib');
const express     = require('express');
const helmet      = require('helmet');
const cors        = require('cors');
const compression = require('compression');

// ── LOGGER ──────────────────────────────────────────────────────────
const Logger = (() => {
  const IS_PROD   = (process.env.NODE_ENV||'production')==='production';
  const LOG_DIR   = process.env.LOG_DIR||path.join(process.cwd(),'logs');
  const MIN_LEVEL = (process.env.LOG_LEVEL||(IS_PROD?'INFO':'DEBUG')).toUpperCase();
  const RING_MAX  = 300;
  const LEVELS    = {DEBUG:0,INFO:1,WARN:2,ERROR:3,FATAL:4};
  const C = IS_PROD?{}:{RESET:'\x1b[0m',BOLD:'\x1b[1m',DIM:'\x1b[2m',DEBUG:'\x1b[36m',INFO:'\x1b[32m',WARN:'\x1b[33m',ERROR:'\x1b[31m',FATAL:'\x1b[35m'};
  const c = k=>C[k]||'';
  const SENSITIVE = new Set(['api_key','apikey','authorization','password','token','secret','cookie','x-api-key']);
  function redact(obj,d=0){if(d>5||!obj||typeof obj!=='object')return obj;if(Array.isArray(obj))return obj.map(v=>redact(v,d+1));const o={};for(const[k,v]of Object.entries(obj))o[k]=SENSITIVE.has(k.toLowerCase())?'[REDACTED]':redact(v,d+1);return o;}
  const ring=[];
  function pushRing(e){ring.push(e);if(ring.length>RING_MAX)ring.shift();}
  let _s=null,_d='';
  function fileStream(){const t=new Date().toISOString().slice(0,10);if(t!==_d||!_s){try{_s?.end();}catch(_){}  _d=t;try{if(!fs.existsSync(LOG_DIR))fs.mkdirSync(LOG_DIR,{recursive:true});_s=fs.createWriteStream(path.join(LOG_DIR,`bingebox-${t}.log`),{flags:'a',encoding:'utf8'});}catch(_){_s=null;}}return _s;}
  function pruneOldLogs(){try{if(!fs.existsSync(LOG_DIR))return;const cut=Date.now()-14*86400000;fs.readdirSync(LOG_DIR).filter(f=>f.endsWith('.log')).map(f=>path.join(LOG_DIR,f)).filter(fp=>fs.statSync(fp).mtimeMs<cut).forEach(fp=>fs.unlinkSync(fp));}catch(_){}}
  setInterval(pruneOldLogs,6*3600000);pruneOldLogs();
  function write(level,ctx,msg,meta){
    if((LEVELS[level]??0)<(LEVELS[MIN_LEVEL]??0))return;
    const entry={level,ts:new Date().toISOString(),context:ctx,message:msg,pid:process.pid,host:os.hostname(),...(meta?{meta:redact(meta)}:{})};
    pushRing(entry);
    const line=JSON.stringify(entry)+'\n';
    if(IS_PROD){process.stdout.write(line);}else{const metaStr=meta?`\n  ${c('DIM')}${JSON.stringify(redact(meta),null,2).replace(/\n/g,'\n  ')}${c('RESET')}`:'';process.stdout.write(`${c('DIM')}${entry.ts}${c('RESET')} ${c(level)}${c('BOLD')}[${level.padEnd(5)}]${c('RESET')} ${c('DIM')}[${ctx}]${c('RESET')} ${msg}${metaStr}\n`);}
    fileStream()?.write(line);
  }
  function createLogger(ctx='APP'){return{debug:(m,meta)=>write('DEBUG',ctx,m,meta),info:(m,meta)=>write('INFO',ctx,m,meta),warn:(m,meta)=>write('WARN',ctx,m,meta),error:(m,meta)=>write('ERROR',ctx,m,meta),fatal:(m,meta)=>write('FATAL',ctx,m,meta),time(l){const t0=process.hrtime.bigint();return(ex={})=>{const ms=Number(process.hrtime.bigint()-t0)/1e6;write('DEBUG',ctx,`${l} — ${ms.toFixed(2)}ms`,ex);return ms;};},child(s){return createLogger(`${ctx}:${s}`);}};}
  const root=createLogger('BingeBox');
  function requestLogger(opts={}){const skip=opts.skip||(req=>/^\/(health|favicon\.ico|robots\.txt)/.test(req.path));const hLog=createLogger('HTTP');return function(req,res,next){if(skip(req))return next();const t0=process.hrtime.bigint();const id=req.headers['x-request-id']||'-';hLog.debug(`→ ${req.method} ${req.path}`,{id,ip:req.ip,ua:(req.headers['user-agent']||'').slice(0,80)});res.on('finish',()=>{const ms=Number(process.hrtime.bigint()-t0)/1e6;const lv=res.statusCode>=500?'ERROR':res.statusCode>=400?'WARN':'INFO';write(lv,'HTTP',`${req.method} ${req.path} ${res.statusCode} ${ms.toFixed(0)}ms`,{id,status:res.statusCode,ms:parseFloat(ms.toFixed(2)),ip:req.ip});});next();};}
  function logsHandler(req,res){if(IS_PROD&&req.ip!=='127.0.0.1'&&req.ip!=='::1')return res.status(403).json({error:'forbidden'});const fl=(req.query.level||'').toUpperCase();const lim=Math.min(parseInt(req.query.limit||'100',10),RING_MAX);const ent=fl&&LEVELS[fl]!=null?ring.filter(e=>LEVELS[e.level]>=LEVELS[fl]):ring;const sl=ent.slice(-lim);res.json({total:ring.length,returned:sl.length,entries:sl});}
  process.on('unhandledRejection',r=>root.error('Unhandled Rejection',{reason:String(r)}));
  process.on('uncaughtException',e=>{root.fatal('Uncaught Exception',{message:e.message,stack:e.stack?.split('\n').slice(0,4).join(' ← ')});setTimeout(()=>process.exit(1),500);});
  return{createLogger,root,requestLogger,logsHandler,getBuffer:()=>[...ring]};
})();
const log=Logger.createLogger('Server');

// ── CACHE MANAGER (L1/L2 LRU + Zlib + SWR) ─────────────────────────
const CacheManager=(()=>{
  const cLog=Logger.createLogger('Cache');
  const CFG={L1_MAX:300,L2_MAX:2000,DEFAULT_TTL:5*60000,MAX_TTL:60*60000,MIN_TTL:30000,COMPRESS_BYTES:4096,MEM_THRESHOLD:0.85,SWR_WINDOW:30000,METRICS_RESET:60*60000,ADAPTIVE_CAP:8};
  const m={hits:0,misses:0,staleHits:0,evictions:0,compressions:0,decompressions:0,errors:0,inflight:0,reset(){this.hits=this.misses=this.staleHits=this.evictions=this.compressions=this.decompressions=this.errors=this.inflight=0;},snapshot(){const t=this.hits+this.misses;return{...this,hitRate:t?+(this.hits/t).toFixed(4):0,total:t};}};
  setInterval(()=>m.reset(),CFG.METRICS_RESET);
  function tryCompress(s){if(!s||s.length<CFG.COMPRESS_BYTES)return{raw:s,compressed:false};try{const b=zlib.gzipSync(Buffer.from(s,'utf8'));m.compressions++;return{raw:b,compressed:true};}catch(_){return{raw:s,compressed:false};}}
  function tryDecompress(e){if(!e.compressed)return e.raw;try{m.decompressions++;return zlib.gunzipSync(e.raw).toString('utf8');}catch(_){return null;}}
  class LRUTier{constructor(max,name){this._map=new Map();this._max=max;this.name=name;this.evictions=0;}_evictOldest(){const k=this._map.keys().next().value;if(k!==undefined){this._map.delete(k);this.evictions++;m.evictions++;}}
  get(k){const e=this._map.get(k);if(!e)return null;this._map.delete(k);this._map.set(k,e);const now=Date.now(),exp=now>e.expires,stale=!exp&&now>(e.expires-CFG.SWR_WINDOW);if(exp&&!e.allowStale)return null;try{const r=tryDecompress(e);if(r===null){this._map.delete(k);return null;}return{value:JSON.parse(r),stale:exp||stale,ttlMs:Math.max(0,e.expires-now)};}catch(_){this._map.delete(k);return null;}}
  set(k,v,ttl,tags=[]){if(this._map.size>=this._max)this._evictOldest();const s=JSON.stringify(v);const{raw,compressed}=tryCompress(s);this._map.set(k,{raw,compressed,expires:Date.now()+ttl,ttlMs:ttl,tags,allowStale:true,setAt:Date.now()});return true;}
  delete(k){return this._map.delete(k);}clear(){const n=this._map.size;this._map.clear();return n;}get size(){return this._map.size;}keys(){return[...this._map.keys()];}invalidateByTag(t){let n=0;for(const[k,v]of this._map)if(v.tags?.includes(t)){this._map.delete(k);n++;}return n;}info(){return{name:this.name,size:this._map.size,maxSize:this._max,evictions:this.evictions,utilization:+((this._map.size/this._max)*100).toFixed(1)+'%'};}}
  const L1=new LRUTier(CFG.L1_MAX,'L1-Hot'),L2=new LRUTier(CFG.L2_MAX,'L2-Warm');
  const _hc=new Map();setInterval(()=>_hc.clear(),CFG.METRICS_RESET);
  function adaptiveTTL(k,b){const h=(_hc.get(k)||0)+1;_hc.set(k,h);return Math.min(Math.max(b*Math.pow(1.3,Math.min(h-1,CFG.ADAPTIVE_CAP)),CFG.MIN_TTL),CFG.MAX_TTL);}
  function get(k){const l1=L1.get(k);if(l1){m.hits++;if(l1.stale)m.staleHits++;return{...l1,source:'L1'};}const l2=L2.get(k);if(l2){m.hits++;if(l2.stale)m.staleHits++;L1.set(k,l2.value,Math.min(l2.ttlMs,CFG.DEFAULT_TTL*2));return{...l2,source:'L2'};}m.misses++;return null;}
  function set(k,v,b=CFG.DEFAULT_TTL,tags=[]){const t=adaptiveTTL(k,b);L1.set(k,v,Math.min(t,CFG.DEFAULT_TTL*2),tags);L2.set(k,v,t,tags);}
  function del(k){L1.delete(k);L2.delete(k);}
  function invalidateTag(t){const n=L1.invalidateByTag(t)+L2.invalidateByTag(t);cLog.info(`Tag invalidation: "${t}" — ${n} entries removed`);return n;}
  const inflight=new Map();
  async function getOrFetch(k,fn,b=CFG.DEFAULT_TTL,tags=[]){const c=get(k);if(c&&!c.stale)return c.value;if(c&&c.stale){if(!inflight.has(k)){m.inflight++;const p=fn().then(f=>{set(k,f,b,tags);return f;}).catch(e=>{m.errors++;cLog.warn(`BG refresh failed: ${k}`,{msg:e.message});}).finally(()=>{inflight.delete(k);m.inflight--;});inflight.set(k,p);}return c.value;}if(inflight.has(k))return inflight.get(k);m.inflight++;const p=fn().then(f=>{set(k,f,b,tags);return f;}).catch(e=>{m.errors++;inflight.delete(k);m.inflight--;throw e;}).finally(()=>{inflight.delete(k);m.inflight--;});inflight.set(k,p);return p;}
  setInterval(()=>{const r=process.memoryUsage().rss/os.totalmem();if(r>CFG.MEM_THRESHOLD){const n=Math.ceil(L2.size*0.20);L2.keys().slice(0,n).forEach(k=>L2.delete(k));cLog.warn(`Memory pressure (${(r*100).toFixed(1)}%) — evicted ${n} L2 entries`);}},30000);
  const router=express.Router();
  router.get('/stats',(req,res)=>{const mm=process.memoryUsage();res.json({metrics:m.snapshot(),l1:L1.info(),l2:L2.info(),inflight:inflight.size,memory:{rssMB:+(mm.rss/1048576).toFixed(1),heapMB:+(mm.heapUsed/1048576).toFixed(1),totalMB:+(os.totalmem()/1048576).toFixed(0),pressure:+((mm.rss/os.totalmem())*100).toFixed(1)+'%'},config:CFG});});
  router.delete('/all',(req,res)=>{const l1=L1.clear(),l2=L2.clear();inflight.clear();_hc.clear();cLog.info('Full cache clear',{l1,l2});res.json({cleared:{l1,l2},message:'Cache cleared'});});
  router.delete('/tag/:tag',(req,res)=>{const n=invalidateTag(req.params.tag);res.json({invalidated:n,tag:req.params.tag});});
  router.delete('/key/:key',(req,res)=>{del(decodeURIComponent(req.params.key));res.json({deleted:req.params.key});});
  router.get('/keys',(req,res)=>{const lim=Math.min(parseInt(req.query.limit||'50',10),500);res.json({l1:L1.keys().slice(0,lim),l2:L2.keys().slice(0,lim)});});
  return{get,set,del,invalidateTag,getOrFetch,metrics:m,L1,L2,router,CFG};
})();

// ── SECURITY CONFIG ──────────────────────────────────────────────────
const SecurityConfig=(()=>{
  const EMBED=['vidsrc.pro','*.vidsrc.pro','vidsrc.me','*.vidsrc.me','vidsrc.cc','*.vidsrc.cc','vidlink.pro','*.vidlink.pro','videasy.net','player.videasy.net','multiembed.mov','*.multiembed.mov','autoembed.cc','*.autoembed.cc','2embed.cc','*.2embed.cc','www.youtube.com'];
  const hMw=helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'","cdn.tailwindcss.com","cdn.jsdelivr.net","cdnjs.cloudflare.com","unpkg.com","'unsafe-inline'","'unsafe-eval'"],styleSrc:["'self'","'unsafe-inline'","fonts.googleapis.com","cdn.jsdelivr.net","cdnjs.cloudflare.com"],fontSrc:["'self'","fonts.gstatic.com","cdnjs.cloudflare.com","data:"],imgSrc:["'self'","image.tmdb.org","media.themoviedb.org","api.dicebear.com","secure.gravatar.com","data:","blob:"],mediaSrc:["'self'","blob:",...EMBED],connectSrc:["'self'","api.themoviedb.org","https://api.themoviedb.org","wss://echo.websocket.events"],frameSrc:["'self'",...EMBED],frameAncestors:["'none'"],workerSrc:["'self'","blob:"],childSrc:["'self'","blob:",...EMBED],objectSrc:["'none'"],baseUri:["'self'"],formAction:["'self'"],upgradeInsecureRequests:[]}},strictTransportSecurity:{maxAge:31536000,includeSubDomains:true,preload:true},referrerPolicy:{policy:'strict-origin-when-cross-origin'},frameguard:{action:'deny'},hidePoweredBy:true,noSniff:true,ieNoOpen:true,xssFilter:true,dnsPrefetchControl:{allow:true},crossOriginEmbedderPolicy:false});
  function additionalHeaders(req,res,next){res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-BingeBox-Server',`Omega/${process.env.npm_package_version||'3.0.0'}`);if(!res.getHeader('X-BingeBox-Cache'))res.setHeader('X-BingeBox-Cache','MISS');res.setHeader('Permissions-Policy',['camera=()','microphone=(self)','geolocation=()','payment=()','usb=()','bluetooth=()','fullscreen=(self)','picture-in-picture=(self)','autoplay=(self)','encrypted-media=(self)'].join(', '));res.setHeader('Cross-Origin-Opener-Policy','same-origin-allow-popups');res.setHeader('Cross-Origin-Resource-Policy','same-origin');res.removeHeader('X-Powered-By');res.removeHeader('Server');next();}
  const BOT=[/scrapy/i,/python-requests/i,/go-http-client/i,/java\//i,/zgrab/i,/masscan/i,/nmap/i];
  function botDetection(req,res,next){const ua=(req.headers['user-agent']||'').trim();if(!ua){res.setHeader('X-BingeBox-Client-Type','headless');return next();}if(BOT.some(rx=>rx.test(ua)))return res.status(403).json({error:'forbidden',message:'Automated clients are not permitted.'});next();}
  const RATE={windowMs:60000,maxHits:200,blockMs:5*60000,skip:new Set(['/health','/health/ready','/favicon.ico','/robots.txt'])};
  const _store=new Map();
  setInterval(()=>{const now=Date.now();for(const[ip,e]of _store)if(!e.hits.length||now-e.hits[e.hits.length-1]>RATE.blockMs*2)_store.delete(ip);},10*60000);
  function rateLimiter(req,res,next){if(RATE.skip.has(req.path))return next();const ip=req.ip||req.socket?.remoteAddress||'unknown';const now=Date.now();let e=_store.get(ip);if(!e){e={hits:[],blocked:false,blockedUntil:0};_store.set(ip,e);}if(e.blocked){if(now<e.blockedUntil){const r=Math.ceil((e.blockedUntil-now)/1000);res.setHeader('Retry-After',r);return res.status(429).json({error:'rate_limited',message:'Too many requests.',retryAfter:r});}e.blocked=false;e.blockedUntil=0;e.hits=[];}e.hits=e.hits.filter(t=>now-t<RATE.windowMs);e.hits.push(now);const rem=Math.max(0,RATE.maxHits-e.hits.length);res.setHeader('X-RateLimit-Limit',RATE.maxHits);res.setHeader('X-RateLimit-Remaining',rem);res.setHeader('X-RateLimit-Reset',Math.ceil((now+RATE.windowMs)/1000));if(e.hits.length>RATE.maxHits){e.blocked=true;e.blockedUntil=now+RATE.blockMs;return res.status(429).json({error:'rate_limited',message:'Rate limit exceeded.',retryAfter:RATE.blockMs/1000});}next();}
  return[hMw,additionalHeaders,botDetection,rateLimiter];
})();

// ── CORS CONFIG ──────────────────────────────────────────────────────
const CorsConfig=(()=>{
  const cLog=Logger.createLogger('CORS');const IS_DEV=process.env.NODE_ENV!=='production';
  const STATIC=['http://localhost:3000','http://localhost:5000','http://localhost:8080','http://127.0.0.1:3000','http://127.0.0.1:5000'];
  function buildAllow(){const env=[];if(process.env.CLIENT_URL)env.push(...process.env.CLIENT_URL.split(',').map(s=>s.trim()).filter(Boolean));if(process.env.STAGING_URL)env.push(process.env.STAGING_URL.trim());if(process.env.PREVIEW_URL)env.push(process.env.PREVIEW_URL.trim());return[...new Set([...STATIC,...env])];}
  const TP=[/^https:\/\/([\w-]+\.)?bingebox\.(tv|app|io)$/,/^https:\/\/[\w-]+-bingebox\.vercel\.app$/,/^https:\/\/[\w-]+-bingebox\.netlify\.app$/,/^https:\/\/[\w-]+\.up\.railway\.app$/,/^https:\/\/[\w-]+\.railway\.app$/];
  const _rej=new Map();
  function isAllowed(o){if(!o)return true;if(buildAllow().includes(o))return true;if(TP.some(rx=>rx.test(o)))return true;return false;}
  const opts={origin(o,cb){if(isAllowed(o)){if(IS_DEV)cLog.debug('ALLOW',{origin:o||'<same>'});cb(null,true);}else{const e=_rej.get(o)||{count:0,first:Date.now()};e.count++;_rej.set(o,e);cLog.warn('BLOCK',{origin:o});cb(new Error(`CORS: origin "${o}" not permitted`));}},methods:['GET','POST','PUT','PATCH','DELETE','OPTIONS','HEAD'],allowedHeaders:['Content-Type','Authorization','X-Requested-With','Accept','Accept-Language','Cache-Control','X-BingeBox-Client','X-BingeBox-Version'],exposedHeaders:['X-RateLimit-Limit','X-RateLimit-Remaining','X-RateLimit-Reset','X-BingeBox-Cache','X-BingeBox-Server','Content-Length','Content-Range','ETag'],credentials:true,maxAge:7200,optionsSuccessStatus:204,preflightContinue:false};
  const _ch=cors(opts);
  function safeCors(req,res,next){_ch(req,res,err=>{if(!err)return next();cLog.error('CORS err',{message:err.message,origin:req.headers.origin});res.setHeader('Content-Type','application/json');res.status(403).json({error:'cors_blocked',message:err.message,origin:req.headers.origin||null});});}
  return{safeCors,getCorsStats:()=>({allowList:buildAllow(),trustedPatterns:TP.map(rx=>rx.source),rejections:Object.fromEntries(_rej)})};
})();

// ── API PROXY (TMDB + Batch + Circuit Breaker) ───────────────────────
const ApiProxy=(()=>{
  const router=express.Router();const pLog=Logger.createLogger('Proxy');
  const TMDB_BASE='https://api.themoviedb.org/3';
  const TMDB_KEY=process.env.TMDB_API_KEY||'15d2ea6d0dc1d476efbca3eba2b9bbfb';
  const REQ_TIMEOUT=8000,MAX_RETRIES=2,BACKOFF=300;
  const TTL_MAP=[['/trending',60000],['/search',90000],['/discover',3*60000],['/movie',10*60000],['/tv',10*60000],['/genre',60*60000],['/person',30*60000]];
  function getTTL(p){for(const[pre,t]of TTL_MAP)if(p.startsWith(pre))return t;return 5*60000;}
  const circuit={failures:0,lastFail:0,threshold:10,resetAfter:60000,isOpen(){if(this.failures<this.threshold)return false;if(Date.now()-this.lastFail>this.resetAfter){this.failures=0;return false;}return true;},record(ok){if(ok)this.failures=0;else{this.failures++;this.lastFail=Date.now();}}};
  function tmdbFetch(rawPath,params={},customKey=null,attempt=0){return new Promise((resolve,reject)=>{const cp='/'+rawPath.replace(/^\/+/,'');const key=customKey||TMDB_KEY;const qs=new URLSearchParams({api_key:key,...params}).toString();const url=`${TMDB_BASE}${cp}?${qs}`;pLog.debug(`→ TMDB ${cp}`,{attempt});const req=https.get(url,{headers:{Accept:'application/json','User-Agent':'BingeBox-Omega/3.0'},timeout:REQ_TIMEOUT},res=>{let body='';res.setEncoding('utf8');res.on('data',d=>{body+=d;});res.on('end',()=>{if(res.statusCode===429&&attempt<MAX_RETRIES){const w=BACKOFF*Math.pow(2,attempt);return setTimeout(()=>tmdbFetch(rawPath,params,customKey,attempt+1).then(resolve).catch(reject),w);}if(res.statusCode>=400){circuit.record(false);return reject(Object.assign(new Error(`TMDB ${res.statusCode}: ${cp}`),{status:res.statusCode}));}try{const d=JSON.parse(body);circuit.record(true);resolve(d);}catch(e){circuit.record(false);reject(Object.assign(new Error('TMDB JSON parse error'),{status:502}));}});});req.on('timeout',()=>{req.destroy();circuit.record(false);reject(Object.assign(new Error(`TMDB timeout: ${cp}`),{status:504}));});req.on('error',err=>{circuit.record(false);if((err.code==='ECONNRESET'||err.message==='socket hang up')&&attempt<MAX_RETRIES)return setTimeout(()=>tmdbFetch(rawPath,params,customKey,attempt+1).then(resolve).catch(reject),BACKOFF*Math.pow(2,attempt));reject(Object.assign(err,{status:502}));});});}
  async function proxiedFetch(p,params={},customKey=null){if(circuit.isOpen())throw Object.assign(new Error('TMDB circuit breaker OPEN'),{status:503});const ck=`tmdb:${p}:${customKey||'sys'}:${new URLSearchParams(params).toString()}`;return CacheManager.getOrFetch(ck,()=>tmdbFetch(p,params,customKey),getTTL(p),['tmdb']);}
  router.get('/tmdb/*',async(req,res)=>{const tp='/'+req.params[0];const params={...req.query};const ck=params.api_key;delete params.api_key;try{const data=await proxiedFetch(tp,params,ck);const ts=Math.floor(getTTL(tp)/1000);const ckey=`tmdb:${tp}:${ck||'sys'}:${new URLSearchParams(params).toString()}`;const hit=CacheManager.get(ckey);res.setHeader('Cache-Control',`public, max-age=${ts}`);res.setHeader('X-BingeBox-Cache',hit?hit.source:'FETCH');res.json(data);}catch(err){pLog.error(`Proxy error ${tp}`,{msg:err.message,status:err.status});res.status(err.status||502).json({error:'tmdb_error',message:err.message,path:tp});}});
  router.post('/tmdb/batch',express.json({limit:'64kb'}),async(req,res)=>{const{requests}=req.body||{};if(!Array.isArray(requests)||!requests.length||requests.length>10)return res.status(400).json({error:'bad_request',message:'Send 1–10 requests.'});const s=await Promise.allSettled(requests.map(({path:p,params})=>proxiedFetch(p,params||{})));res.json({results:s.map((r,i)=>({path:requests[i].path,status:r.status==='fulfilled'?'ok':'error',data:r.status==='fulfilled'?r.value:null,error:r.status==='rejected'?r.reason.message:null}))});});
  router.get('/tmdb/cache-info',(req,res)=>res.json({cache:{l1:CacheManager.L1.info(),l2:CacheManager.L2.info()},circuit:{failures:circuit.failures,threshold:circuit.threshold,isOpen:circuit.isOpen()}}));
  router.delete('/tmdb/cache',(req,res)=>{const n=CacheManager.invalidateTag('tmdb');pLog.info('TMDB cache flushed',{invalidated:n});res.json({invalidated:n,message:'TMDB cache flushed'});});
  return router;
})();

// ── HEALTH MONITOR ───────────────────────────────────────────────────
const HealthMonitor=(()=>{
  const router=express.Router();const hLog=Logger.createLogger('Health');
  const BOOT=Date.now();const PROBE='https://api.themoviedb.org/3/configuration';const KEY=process.env.TMDB_API_KEY||'15d2ea6d0dc1d476efbca3eba2b9bbfb';const PUB=path.join(__dirname,'public');
  let VER='3.0.0';try{VER=require('./package.json').version;}catch(_){}
  const TH={CPU_WARN:70,CPU_CRIT:90,MEM_WARN:75,MEM_CRIT:90,HEAP_WARN_MB:400,HEAP_CRIT_MB:700,EL_WARN_MS:50,EL_CRIT_MS:200,PROBE_TIMEOUT:5000};
  const state={cpu:{current:0,avg5s:0,samples:[]},memory:{},heap:{},eventLoop:{lagMs:0,samples:[]},checks:new Map(),incidents:[],sla:{downtimeMs:0,lastDown:null}};
  let _os='ok',_lcs=os.cpus()||[];
  function sampleCPU(){const cpus=os.cpus()||[];if(!cpus.length)return;const d=cpus.map((c,i)=>{const p=_lcs[i]||c;const idle=c.times.idle-(p.times?.idle||0);const total=Object.values(c.times).reduce((a,b)=>a+b,0)-Object.values(p.times||{}).reduce((a,b)=>a+b,0);return total>0?(1-idle/total)*100:0;});_lcs=cpus;const avg=d.reduce((a,b)=>a+b,0)/d.length;state.cpu.current=+avg.toFixed(1);state.cpu.samples.push(avg);if(state.cpu.samples.length>30)state.cpu.samples.shift();state.cpu.avg5s=+(state.cpu.samples.reduce((a,b)=>a+b,0)/state.cpu.samples.length).toFixed(1);}
  function sampleMem(){const t=os.totalmem(),f=os.freemem(),u=t-f,pp=state.memory.pct||0,p=(u/t)*100;state.memory={usedMB:+(u/1048576).toFixed(1),freeMB:+(f/1048576).toFixed(1),totalMB:+(t/1048576).toFixed(0),pct:+p.toFixed(1),trend:p>pp+2?'rising':p<pp-2?'falling':'stable'};}
  function sampleHeap(){const m=process.memoryUsage();state.heap={usedMB:+(m.heapUsed/1048576).toFixed(1),totalMB:+(m.heapTotal/1048576).toFixed(1),externalMB:+(m.external/1048576).toFixed(1),rssMB:+(m.rss/1048576).toFixed(1)};}
  function sampleEL(){const s=process.hrtime.bigint();setImmediate(()=>{const l=Number(process.hrtime.bigint()-s)/1e6;state.eventLoop.samples.push(l);if(state.eventLoop.samples.length>10)state.eventLoop.samples.shift();state.eventLoop.lagMs=+(state.eventLoop.samples.reduce((a,b)=>a+b,0)/state.eventLoop.samples.length).toFixed(2);});}
  setInterval(()=>{sampleCPU();sampleMem();sampleHeap();sampleEL();},1000);
  function registerCheck(name,fn,ms=30000){const entry={status:'unknown',lastCheck:null,latencyMs:0,message:'',history:[]};state.checks.set(name,entry);async function run(){const t0=Date.now();try{const r=await fn();entry.latencyMs=Date.now()-t0;entry.status=r.status||'ok';entry.message=r.message||'';entry.lastCheck=new Date().toISOString();}catch(e){entry.latencyMs=Date.now()-t0;entry.status='error';entry.message=e.message;entry.lastCheck=new Date().toISOString();state.incidents.push({ts:entry.lastCheck,check:name,message:e.message});if(state.incidents.length>50)state.incidents.shift();hLog.warn(`Health FAIL: ${name}`,{msg:e.message});}entry.history.push(entry.status);if(entry.history.length>10)entry.history.shift();}run();setInterval(run,ms);}
  registerCheck('tmdb-api',()=>new Promise((res,rej)=>{const req=https.get(`${PROBE}?api_key=${KEY}`,{timeout:TH.PROBE_TIMEOUT},r=>{res({status:r.statusCode===200?'ok':'degraded',message:`HTTP ${r.statusCode}`});r.resume();});req.on('error',rej);req.on('timeout',()=>{req.destroy(new Error('Probe timeout'));});}),60000);
  registerCheck('static-files',async()=>{const idx=path.join(PUB,'index.html');if(!fs.existsSync(idx))throw new Error('public/index.html missing');const{size}=fs.statSync(idx);return{status:'ok',message:`${(size/1024).toFixed(0)}KB`};},120000);
  function calcStatus(){let s='ok';for(const[,c]of state.checks){if(c.status==='error'){s='down';break;}if(c.status==='degraded')s='degraded';}if(state.cpu.avg5s>TH.CPU_CRIT||state.memory.pct>TH.MEM_CRIT||state.heap.usedMB>TH.HEAP_CRIT_MB||state.eventLoop.lagMs>TH.EL_CRIT_MS)s='degraded';if(s!=='ok'&&_os==='ok')state.sla.lastDown=Date.now();if(s==='ok'&&_os!=='ok'&&state.sla.lastDown){state.sla.downtimeMs+=Date.now()-state.sla.lastDown;state.sla.lastDown=null;}_os=s;return s;}
  function fmtUp(ms){const s=Math.floor(ms/1000);return`${Math.floor(s/86400)}d ${Math.floor((s%86400)/3600)}h ${Math.floor((s%3600)/60)}m ${s%60}s`;}
  function buildReport(){const up=Date.now()-BOOT;const sla=up>0?((1-state.sla.downtimeMs/up)*100).toFixed(3):'100.000';const co={};for(const[n,c]of state.checks)co[n]=c;return{status:calcStatus(),version:VER,uptime:{ms:up,human:fmtUp(up)},sla:{uptime:`${sla}%`,downtimeMs:state.sla.downtimeMs},ts:new Date().toISOString(),cpu:{current:`${state.cpu.current}%`,avg5s:`${state.cpu.avg5s}%`,warn:state.cpu.avg5s>TH.CPU_WARN,cores:(os.cpus()||[]).length,load:os.loadavg().map(l=>+l.toFixed(2))},memory:state.memory,heap:state.heap,eventLoop:state.eventLoop,node:{version:process.version,pid:process.pid,platform:os.platform(),arch:os.arch(),hostname:os.hostname()},cache:{l1:CacheManager.L1.info(),l2:CacheManager.L2.info(),metrics:CacheManager.metrics.snapshot()},checks:co,incidents:state.incidents.slice(-10),thresholds:TH};}
  router.get('/',(req,res)=>{const s=calcStatus();res.status(s==='down'?503:200).json({status:s,version:VER,uptime:fmtUp(Date.now()-BOOT)});});
  router.get('/detailed',(req,res)=>res.json(buildReport()));
  router.get('/ready',(req,res)=>{let r=true;for(const[,c]of state.checks)if(c.status==='error'){r=false;break;}res.status(r?200:503).json({ready:r,ts:new Date().toISOString()});});
  router.get('/metrics',(req,res)=>{const rp=buildReport();const lines=[`# HELP bb_uptime_seconds Total server uptime\n# TYPE bb_uptime_seconds gauge\nbb_uptime_seconds ${Math.floor(rp.uptime.ms/1000)}`,`# HELP bb_cpu_avg5s CPU 5s avg %\n# TYPE bb_cpu_avg5s gauge\nbb_cpu_avg5s ${state.cpu.avg5s}`,`# HELP bb_memory_pct Sys memory used %\n# TYPE bb_memory_pct gauge\nbb_memory_pct ${state.memory.pct}`,`# HELP bb_heap_used_mb Heap used MB\n# TYPE bb_heap_used_mb gauge\nbb_heap_used_mb ${state.heap.usedMB}`,`# HELP bb_eventloop_lag_ms Event loop lag ms\n# TYPE bb_eventloop_lag_ms gauge\nbb_eventloop_lag_ms ${state.eventLoop.lagMs}`,`# HELP bb_cache_hits Cache hits\n# TYPE bb_cache_hits counter\nbb_cache_hits ${CacheManager.metrics.hits}`,`# HELP bb_cache_misses Cache misses\n# TYPE bb_cache_misses counter\nbb_cache_misses ${CacheManager.metrics.misses}`,`# HELP bb_incidents_total Total incidents\n# TYPE bb_incidents_total counter\nbb_incidents_total ${state.incidents.length}\n`];res.setHeader('Content-Type','text/plain; version=0.0.4');res.send(lines.join('\n'));});
  return router;
})();

// ── EXPRESS APP ──────────────────────────────────────────────────────
const app=express();
const PORT=parseInt(process.env.PORT||'3000',10);
const IS_PROD=(process.env.NODE_ENV||'production')==='production';
const PUBLIC_DIR=path.join(__dirname,'public');

app.set('trust proxy',1);
app.use(SecurityConfig);
app.use(CorsConfig.safeCors);
app.use(compression({threshold:1024,filter:(req,res)=>{if(req.headers['x-no-compression'])return false;return compression.filter(req,res);}}));
app.use(Logger.requestLogger());
app.use(express.static(PUBLIC_DIR,{maxAge:IS_PROD?'1d':0,etag:true,lastModified:true,index:'index.html',redirect:false}));
app.use('/health',HealthMonitor);
app.use('/api/v1',ApiProxy);
app.use('/api/v1/cache',CacheManager.router);
app.get('/api/v1/logs',Logger.logsHandler);
app.get('/api/v1/cors-stats',(req,res)=>res.json(CorsConfig.getCorsStats()));
app.get('*',(req,res,next)=>{if(req.path.startsWith('/api/')||req.path.startsWith('/health'))return next();res.sendFile(path.join(PUBLIC_DIR,'index.html'),err=>{if(err)next(err);});});
app.use((req,res)=>res.status(404).json({error:'not_found',message:`${req.method} ${req.path} does not exist`,ts:new Date().toISOString()}));
app.use((err,req,res,next)=>{const st=err.status||err.statusCode||500;const msg=IS_PROD&&st===500?'Internal server error':err.message;log.error(`Unhandled: ${req.method} ${req.path}`,{status:st,message:err.message});if(!res.headersSent)res.status(st).json({error:'server_error',message:msg,ts:new Date().toISOString()});});

const server=app.listen(PORT,'0.0.0.0',()=>{
  log.info('BingeBox Omega server started',{port:PORT,env:process.env.NODE_ENV||'production',public:PUBLIC_DIR,pid:process.pid,node:process.version});
  if(!process.env.TMDB_API_KEY)log.warn('TMDB_API_KEY not set — using fallback key. Set it in Railway env vars.');
});

function shutdown(sig){log.info(`${sig} received — shutting down gracefully`);server.close(()=>{log.info('HTTP server closed');process.exit(0);});setTimeout(()=>{log.warn('Forced exit');process.exit(1);},10000);}
process.on('SIGTERM',()=>shutdown('SIGTERM'));
process.on('SIGINT',()=>shutdown('SIGINT'));
module.exports=app;
const server=app.listen(PORT,'0.0.0.0',()=>{
  log.info('BingeBox Omega server started'...
});
