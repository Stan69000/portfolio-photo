import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),yaml=require('js-yaml');
test('parallel migration verifies each version before publishing metadata and resumes without reuploading',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'photo-kdrive-migration-'));
 try {
  for(const dir of ['scripts','src/content/photos','src/content/series','src/content/settings'])await fs.mkdir(path.join(root,dir),{recursive:true});
  await fs.writeFile(path.join(root,'package.json'),'{}');
  for(const file of ['migrate-kdrive.js','kdrive-storage.js'])await fs.copyFile(new URL('../scripts/'+file,import.meta.url),path.join(root,'scripts',file));
  for(const slug of ['one','two','three'])await fs.writeFile(path.join(root,'src/content/photos',slug+'.yaml'),JSON.stringify({slug,title:slug,series:'',status:'published',date:'2026-10-11',url:`https://stan-bouchet.eu/${slug}/web.webp`,...Object.fromEntries(['thumb','web','zoom'].map(v=>['url_'+v,`https://stan-bouchet.eu/${slug}/${v}.webp`]))}));
  await fs.writeFile(path.join(root,'mock.mjs'),`import fs from 'node:fs';const uploaded=new Map();let next=100,firstSource=true;globalThis.fetch=async(url,options={})=>{url=new URL(url);if(url.hostname==='stan-bouchet.eu'){if(firstSource){firstSource=false;return new Response('',{status:503})}return new Response('RIFF0000WEBP'+url.pathname);}if(url.pathname.endsWith('/upload')){const id=String(next++);uploaded.set(id,options.body);fs.appendFileSync(process.env.TEST_LOG,url.searchParams.get('file_name')+'\\n');return Response.json({result:'success',data:{id}})}if(url.pathname.endsWith('/download'))return new Response(uploaded.get(url.pathname.split('/').at(-2)));return Response.json({result:'success',data:{id:'426358',type:'dir'}})};`);
  const env={...process.env,NODE_PATH:path.resolve('node_modules'),KDRIVE_TOKEN:'test-token',KDRIVE_ID:'620855',KDRIVE_ROOT_ID:'426358',KDRIVE_RELAY_ORIGIN:'https://admin.stan-bouchet.fr',KDRIVE_RELAY_PATH:'/api/public/kdrive',TEST_LOG:path.join(root,'uploads.log')};
  const args=['--import',path.join(root,'mock.mjs'),path.join(root,'scripts/migrate-kdrive.js'),'--apply','--flat','--concurrency','3'];
  execFileSync(process.execPath,args,{env,cwd:root,stdio:'pipe'});
  for(const slug of ['one','two','three']){const doc=yaml.load(await fs.readFile(path.join(root,'src/content/photos',slug+'.yaml'),'utf8'));assert.equal(Object.keys(doc.kdrive.files).length,3);assert.match(doc.url,/^https:\/\/admin.stan-bouchet.fr\/api\/public\/kdrive\?/);}
  const log=await fs.readFile(env.TEST_LOG,'utf8');assert.equal(log.trim().split('\n').length,9);
  execFileSync(process.execPath,args,{env,cwd:root,stdio:'pipe'});assert.equal(await fs.readFile(env.TEST_LOG,'utf8'),log);
 }finally{await fs.rm(root,{recursive:true,force:true})}
});
