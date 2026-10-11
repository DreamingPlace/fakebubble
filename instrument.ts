import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
const root=process.argv[2]!;
const manifest=JSON.parse(readFileSync(join(root,'player-manifest.json'),'utf8'));
const name=Object.keys(manifest.files).find(x=>x.endsWith('/main.js') || /\/main-[A-Z0-9]+\.js$/.test(x))!;
const prefix=`const observer = new MutationObserver(() => { if (!document.querySelector('.page-shell .invite-entry')) return; observer.disconnect(); requestAnimationFrame(()=>requestAnimationFrame(()=>{ const entries=[...performance.getEntriesByType('navigation'),...performance.getEntriesByType('resource')]; document.querySelector('.page-shell').setAttribute('data-measurement',JSON.stringify({requests:entries.length,bytes:entries.reduce((n,e)=>n+e.encodedBodySize,0),interactiveMs:performance.now(),resources:entries.map(e=>e.name)})); })); }); observer.observe(document.documentElement,{subtree:true,childList:true});\n`;
const bytes=prefix+readFileSync(join(root,name),'utf8'); writeFileSync(join(root,name),bytes); manifest.files[name]=createHash('sha256').update(bytes).digest('hex'); writeFileSync(join(root,'player-manifest.json'),JSON.stringify(manifest));
