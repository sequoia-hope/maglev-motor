const list=await (await fetch('http://127.0.0.1:9223/json')).json();
const pg=list.find(t=>t.type==='page')||list[0];
const sock=new WebSocket(pg.webSocketDebuggerUrl); let id=0; const pend=new Map();
const send=(m,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);sock.send(JSON.stringify({id:i,method:m,params:p}));});
await new Promise(r=>sock.addEventListener('open',r));
sock.addEventListener('message',e=>{const d=JSON.parse(e.data);if(d.id&&pend.has(d.id)){pend.get(d.id)(d);pend.delete(d.id);}});
await send('Runtime.enable');
const evl=async(x)=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true});return r.result?.result?.value;};
await send('Page.navigate',{url:'http://127.0.0.1:8000/'});
await new Promise(r=>setTimeout(r,1500));
for (const key of ['pcbmini','amz316','pcb']){
  await evl(`(()=>{const s=document.getElementById('presetSelect');s.value=${JSON.stringify(key)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await new Promise(r=>setTimeout(r,700));
  const t=await evl(`(()=>{const el=[...document.querySelectorAll('#magnetOrderCard div')].find(d=>/Order list/.test(d.textContent));return el?el.textContent.replace(/\\s+/g,' ').trim():'NO ORDER CARD (generic only)';})()`);
  console.log(`\n[${key}] ${t}`);
}
sock.close();
