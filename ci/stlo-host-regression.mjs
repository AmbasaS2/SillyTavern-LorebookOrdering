// Independent SillyTavern host regression. No operating account, files,
// credentials, third-party viewers or provider calls. Run only on a disposable
// host checkout with dependencies installed; every browser API reply is synthetic.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const host=path.resolve(process.env.STLO_HOST_DIR??'');
const pw=process.env.STLO_PLAYWRIGHT_MODULE;
if(!pw||!fs.existsSync(path.join(host,'server.js')))throw Error('Set STLO_HOST_DIR and STLO_PLAYWRIGHT_MODULE to disposable dependencies.');
const {chromium}=await import(pathToFileURL(pw));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'stlo-host-'));
const evidence=path.resolve(process.env.STLO_HOST_EVIDENCE??path.join(root,'evidence'));
fs.mkdirSync(evidence,{recursive:true});
const port=Number(process.env.STLO_HOST_PORT??18731);
const url='http://127.0.0.1:'+port;
const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const write=(f,v)=>fs.writeFileSync(f,JSON.stringify(v,null,2));
const digest=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const model='gpt-4o-mini', avatar='Mara.png',other='Nora.png';
const baseChat='Harbor',altChat='Alternate',groupId='900000000001',groupChat='Synthetic group';
const aBook='Synthetic Harbor Archive',bBook='Synthetic Alternate Archive';
const fakeId='00000000-0000-4000-8000-000000000001';
const profile={id:fakeId,name:'Offline fixture',api:'custom','api-url':'https://nano-gpt.com/api/subscription/v1','secret-id':'not-a-real-secret'};
const fixture=(uid,title,content,extra={})=>({uid,comment:title,content,key:[],keysecondary:[],constant:false,disable:false,vectorized:false,selective:false,selectiveLogic:0,addMemo:false,order:100,position:0,probability:100,useProbability:true,depth:4,group:'',groupWeight:100,groupOverride:false,outletName:'',cooldown:0,sticky:0,delay:0,delayUntilRecursion:0,excludeRecursion:false,preventRecursion:false,ignoreBudget:false,triggers:[],...extra});
const harbor=[fixture(1,'HARBOR_CORE','HARBOR_CORE: The brass seal belongs to Mara.',{constant:true,order:500}),fixture(2,'HARBOR_PROMISE','HARBOR_PROMISE: Ellis will wait for the eastern bell.',{order:300}),fixture(3,'HARBOR_DETAIL','HARBOR_DETAIL: The eastern lantern marks the gate. '+('A record of old dock repairs. ').repeat(25),{order:200})];
const alternate=[fixture(1,'AU_CORE','AU_CORE: The archive stands on a mountain.',{constant:true,order:500}),fixture(2,'AU_PROMISE','AU_PROMISE: Ellis will wait for the silver compass.',{order:300}),fixture(3,'AU_DETAIL','AU_DETAIL: The path crosses the observatory garden.',{order:200})];
const seed=read(path.join(host,'default/content/settings.json'));
const parser=await import(pathToFileURL(path.join(host,'src/character-card-parser.js')));
const png=fs.readFileSync(path.join(host,'default/content/user-default.png'));
function makeCard(name){
 const data={name,description:name+' is a fictional archivist.',personality:'Careful.',scenario:'A fictional archive.',first_mes:'The archive is open.',mes_example:'',creator_notes:'',system_prompt:'',post_history_instructions:'',alternate_greetings:[],tags:[],creator:'',character_version:'',extensions:{talkativeness:.5,fav:false,world:''}};
 return parser.write(png,JSON.stringify({spec:'chara_card_v2',spec_version:'2.0',...data,data,chat:baseChat,talkativeness:.5}));
}
function configure(caseId,home){
 for(const dir of ['characters','chats/Mara','chats/Nora','worlds','extensions','groups','group chats','OpenAI Settings','themes','User Avatars'])fs.mkdirSync(path.join(home,dir),{recursive:true});
 fs.writeFileSync(path.join(home,'characters',avatar),makeCard('Mara'));
 fs.writeFileSync(path.join(home,'characters',other),makeCard('Nora'));
 fs.copyFileSync(path.join(host,'default/content/user-default.png'),path.join(home,'User Avatars','user-default.png'));
 fs.copyFileSync(path.join(host,'default/content/presets/openai/Default.json'),path.join(home,'OpenAI Settings','Default.json'));
 fs.copyFileSync(path.join(host,'default/content/themes/Dark Lite.json'),path.join(home,'themes','Dark Lite.json'));
 const ext=path.join(home,'extensions','SillyTavern-LorebookOrdering');
 fs.mkdirSync(ext,{recursive:true});
 for(const item of fs.readdirSync(repo,{withFileTypes:true})){
   if(item.name.startsWith('.')||['ci','node_modules'].includes(item.name)||item.name.endsWith('.test.mjs'))continue;
   if(item.isFile()&&/\.(js|mjs|json|css|html)$/.test(item.name)||item.isDirectory()&&item.name==='locales')fs.cpSync(path.join(repo,item.name),path.join(ext,item.name),{recursive:true});
 }
 const s=structuredClone(seed);
 s.firstRun=false;s.currentVersion='1.19.1';s.accountStorage={__migrated:'1'};s.active_character=avatar;s.active_group=null;s.main_api='openai';s.username='Ellis';s.user_avatar='user-default.png';s.max_context=8192;s.amount_gen=128;
 Object.assign(s.oai_settings,{chat_completion_source:'nanogpt',nanogpt_model:model,stream_openai:false,openai_max_context:8192,openai_max_tokens:128});
 Object.assign(s.power_user,{persona_description_lorebook:'',auto_continue:{enabled:false,allow_chat_completions:false,target_length:400}});
 s.extension_settings={...seed.extension_settings,autoConnect:false,disabledExtensions:[],regex:[],connectionManager:{selectedProfile:fakeId,profiles:[profile]},vectors:{enabled_world_info:false,enabled_chats:false,enabled_files:false},stlo:{jevBudget:2000,protectAlwaysOn:true,jevProfileId:fakeId,jevOptions:{inputVersion:2,mode:'all',recent:20,messageLength:0,loreLength:0,preset:'balanced',prompt:''},jevPromptLibrary:{presets:[],selectedId:'builtin'},jevByCharacter:{[avatar]:true,[other]:true}}};
 s.world_info_settings={...s.world_info_settings,world_info_budget:50,world_info_recursive:false,world_info:{globalSelect:caseId==='group'?[aBook]:[],charLore:caseId==='group'||caseId==='au'?[]:[{name:'Mara',extraBooks:[aBook]}]}};
 const a={stlo:{jevRecall:true,budgetMode:'fixed',budget:500},entries:Object.fromEntries(harbor.map(e=>[e.uid,e]))};
 if(caseId==='group')a.stlo.characterOverrides={Mara:{budgetMode:'fixed',budget:45},Nora:{budgetMode:'fixed',budget:500}};
 write(path.join(home,'worlds',aBook+'.json'),a);
 write(path.join(home,'worlds',bBook+'.json'),{stlo:{jevRecall:true,budgetMode:'fixed',budget:500},entries:Object.fromEntries(alternate.map(e=>[e.uid,e]))});
 const rows=[{name:'Mara',is_user:false,is_system:false,mes:'The archive is open.',send_date:1700000200000,extra:{}},{name:'Ellis',is_user:true,is_system:false,mes:'What should we remember?',send_date:1700000200001,extra:{}},{name:'Mara',is_user:false,is_system:false,mes:'I examine the seal.',send_date:1700000200002,extra:{}}];
 const chat=(world,group=false)=>[{user_name:'Ellis',character_name:group?'unused':'Mara',chat_metadata:world?{world_info:world}:{}},...rows.map(row=>group&&!row.is_user?{...row,original_avatar:avatar,force_avatar:'/characters/'+avatar}:row)].map(x=>JSON.stringify(x)).join('\n')+'\n';
 fs.writeFileSync(path.join(home,'chats/Mara',baseChat+'.jsonl'),chat(caseId==='au'?aBook:null));
 fs.writeFileSync(path.join(home,'chats/Mara',altChat+'.jsonl'),chat(bBook));
 fs.writeFileSync(path.join(home,'chats/Nora',baseChat+'.jsonl'),chat(null));
 if(caseId==='group'){
   s.active_character=null;s.active_group=groupId;
   write(path.join(home,'groups',groupId+'.json'),{id:groupId,name:'Synthetic group',members:[avatar,other],allow_self_responses:true,activation_strategy:1,generation_mode:0,disabled_members:[],chat_id:groupChat,chats:[groupChat],auto_mode_delay:5,fav:false,date_last_chat:Date.now()});
   fs.writeFileSync(path.join(home,'group chats',groupChat+'.jsonl'),chat(null,true));
 }
 write(path.join(home,'settings.json'),s);
}
const cases=process.argv.slice(2).length?process.argv.slice(2):['group','au','cancel','stop','settings'];
const cfg=path.join(root,'config.yaml');
fs.copyFileSync(path.join(host,'default/config.yaml'),cfg);
let browser;
const failures=[];
try{
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 for(const caseId of cases){
   const data=path.join(root,caseId),home=path.join(data,'default-user');
   configure(caseId,home);
   const sf=path.join(home,'settings.json');
   const stlo=()=>read(sf).extension_settings.stlo;
   const baseline=JSON.stringify(stlo());
   const before=[aBook,bBook].map(n=>digest(path.join(home,'worlds',n+'.json')));
   const log=fs.openSync(path.join(evidence,caseId+'-host.log'),'w');
   const server=spawn(process.execPath,['server.js','--configPath',cfg,'--dataRoot',data,'--port',String(port),'--browserLaunchEnabled','false'],{cwd:host,stdio:['ignore',log,log]});
   const result={caseId,decisions:[],rp:[],errors:[]};
   const context=await browser.newContext({viewport:{width:caseId==='settings'?390:1280,height:900},locale:'en-US',serviceWorkers:'block'});
   const page=await context.newPage();page.setDefaultTimeout(15000);
   let fail=caseId==='cancel',delay=caseId==='stop',pending=false;
   try{
     let ready=false;
     for(let n=0;n<180;n++){if(await fetch(url+'/version',{signal:AbortSignal.timeout(1500)}).then(r=>r.ok).catch(()=>false)){ready=true;break;}if(server.exitCode!==null)break;await pause(500);}
     assert.ok(ready,'host startup');
     page.on('pageerror',e=>result.errors.push(e.message.slice(0,250)));
     await context.route('**/*',async route=>{
       const u=new URL(route.request().url());
       if(u.origin!==url)return route.abort();
       if(u.pathname.startsWith('/api/backends/')){
         if(u.pathname.endsWith('/status'))return route.fulfill({json:{data:[{id:model,object:'model',context_length:8192}]}});
         if(u.pathname!=='/api/backends/chat-completions/generate')return route.abort();
         const body=route.request().postDataJSON();
         if(String(body.model).includes('jev-')){
           const questions=JSON.parse(body.custom_include_body).response_format.questions;
           const state=JSON.parse(body.messages[0].content);
           const candidates=Object.entries(questions).filter(([key])=>key.startsWith('e')).map(([key,q])=>[key,state.excerptSources?.[key]??JSON.parse(q.instructions.slice(q.instructions.indexOf('{')))]);
           result.decisions.push({books:[...new Set(candidates.map(([,e])=>e.book))],titles:candidates.map(([,e])=>e.title),failed:fail});
           if(fail){fail=false;return route.fulfill({status:503,json:{error:{message:'Synthetic unavailable'}}});}
           if(delay){delay=false;pending=true;await pause(2500);}
           const answers=Object.fromEntries(candidates.map(([key])=>[key,{choice:'include',probabilities:{include:.95,skip:.05}}]));
           try{return await route.fulfill({json:{choices:[{message:{content:JSON.stringify({answers})},finish_reason:'stop'}]}});}catch{return;}
         }
         const content=(body.messages??[]).map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content??'')).join('\n');
         result.rp.push({markers:[...harbor,...alternate].filter(e=>content.includes(e.content)).map(e=>e.comment)});
         return route.fulfill({json:{choices:[{index:0,message:{role:'assistant',content:'Offline fixture reply.'},finish_reason:'stop'}]}});
       }
       if(u.pathname.startsWith('/api/vector/'))return route.fulfill({json:{}});
       return route.continue();
     });
     async function openPage(){
       await page.goto(url,{waitUntil:'domcontentloaded'});
       await page.waitForFunction(()=>typeof window.stlo_jevInterceptor==='function'&&SillyTavern.getContext().characters.some(c=>c.avatar==='Mara.png'),{},{timeout:90000});
       // Minimal test-only host for the optional top-bar button, no companion.
       await page.evaluate(async({caseId,groupId,baseChat,avatar})=>{
         const c=SillyTavern.getContext();
         if(!document.getElementById('extensionTopBar')){const bar=document.createElement('div');bar.id='extensionTopBar';document.body.append(bar);}
         if(caseId==='group'){const g=await import('/scripts/group-chats.js');if(c.groupId!==groupId)await g.openGroupById(groupId);}
         else{const i=c.characters.findIndex(x=>x.avatar===avatar);if(Number(c.characterId)!==i||c.groupId!=null)await c.selectCharacterById(i,{switchMenu:false});if(c.getCurrentChatId()!==baseChat)await c.openCharacterChat(baseChat);}
       },{caseId,groupId,baseChat,avatar});
       await pause(500);
       for(const close of await page.locator('dialog[open] .popup-button-cancel:visible').all())await close.evaluate(b=>b.click()).catch(()=>{});
     }
     await openPage();
     await page.evaluate(()=>{
       const c=SillyTavern.getContext();window.drafts=[];window.ends=[];
       c.eventSource.on(c.eventTypes.GROUP_MEMBER_DRAFTED,id=>window.drafts.push({avatar:c.characters[id]?.avatar,cleared:window.STLOMemoryMetrics.context()===null}));
       c.eventSource.on(c.eventTypes.GENERATION_ENDED,()=>window.ends.push(window.STLOMemoryMetrics.context()?.generation?.id??null));
     });
     const handle=()=>page.evaluate(()=>window.STLOMemoryMetrics.context()?.generation?.id??null);
     const send=()=>page.evaluate(async()=>{const h=await import('/script.js');h.setOnlineStatus('Connected');document.querySelector('#send_textarea').value='What should we remember before departure?';window.fixtureDone=false;window.fixtureError=null;h.Generate('normal').then(()=>window.fixtureDone=true,e=>{window.fixtureError=String(e?.message??e).slice(0,160);window.fixtureDone=true;});});
     const done=async()=>{await page.waitForFunction(()=>window.fixtureDone,{},{timeout:45000});await pause(400);};
     if(caseId==='group'){
       await send();await done();
       result.drafts=await page.evaluate(()=>window.drafts);result.ends=await page.evaluate(()=>window.ends);
       assert.equal(result.rp.length,2);assert.equal(result.decisions.length,2);
       assert.deepEqual(result.drafts,[{avatar,cleared:true},{avatar:other,cleared:true}]);
       assert.ok(result.rp[0].markers.includes('HARBOR_CORE'));
       assert.ok(!result.rp[0].markers.includes('HARBOR_DETAIL'));
       assert.equal(result.rp[1].markers.length,3);
     }else if(caseId==='au'){
       await send();await done();const a=await handle();
       const switchChat=name=>page.evaluate(async n=>{const c=SillyTavern.getContext();await c.openCharacterChat(n);return {world:c.chatMetadata.world_info,cleared:window.STLOMemoryMetrics.context()===null};},name);
       result.switch=await switchChat(altChat);
       await send();await done();const b=await handle();
       result.return=await switchChat(baseChat);
       await send();await done();result.handles=[a,b,await handle()];
       assert.deepEqual(result.switch,{world:bBook,cleared:true});assert.deepEqual(result.return,{world:aBook,cleared:true});
       assert.equal(result.rp.length,3);assert.equal(new Set(result.handles).size,3);assert.ok(result.handles.every(Boolean));
       for(let i=0;i<3;i++){const prefix=i===1?'AU_':'HARBOR_';assert.equal(result.rp[i].markers.length,3);assert.ok(result.rp[i].markers.every(n=>n.startsWith(prefix)));assert.deepEqual(result.decisions[i].books,[i===1?bBook:aBook]);}
     }else if(caseId==='cancel'||caseId==='stop'){
       await send();
       if(caseId==='cancel'){
         const dialog=page.locator('dialog[open]').filter({hasText:'Jev memory recall failed'}).last();await dialog.waitFor({state:'visible',timeout:20000});await dialog.locator('.popup-button-cancel').click();
       }else{
         for(let n=0;n<100&&!pending;n++)await pause(100);
         assert.ok(pending,'pending Jev request');
         await page.evaluate(async()=>{const h=await import('/script.js');h.stopGeneration();});
       }
       await done();result.cancel={rp:result.rp.length,handle:await handle(),decisions:result.decisions.length};
       assert.equal(result.cancel.rp,0);assert.equal(result.cancel.handle,null);
       await send();await done();assert.equal(result.rp.length,1);assert.equal(result.decisions.length,2);assert.ok(await handle());
     }else if(caseId==='settings'){
       const open=async()=>{await page.locator('#stlo_jev_settings_menu_item').evaluate(e=>e.click());await page.waitForFunction(()=>document.querySelector('#stlo-jev-prompt-choice')?.options.length>0);};
       const fill=async()=>{await page.locator('input[name="stlo-jev-mode"][value="adaptive"]').check();await page.locator('#stlo-jev-budget').fill('3210');await page.locator('#stlo-jev-adaptive-threshold').fill('43210');await page.locator('details.stlo-jev-advanced').first().evaluate(e=>e.open=true);await page.locator('#stlo-jev-partial').check();await page.locator('#stlo-jev-recent').fill('17');};
       const close=async save=>{await page.locator('dialog[open]').last().locator(save?'.popup-button-ok':'.popup-button-cancel').click();await page.waitForFunction(()=>!document.querySelector('dialog[open] .stlo-jev-settings'));};
       await open();await fill();await close(false);await pause(1200);
       assert.equal(JSON.stringify(stlo()),baseline,'cancel changed settings');
       await open();await fill();await close(true);
       for(let n=0;n<30&&stlo().jevBudget!==3210;n++)await pause(200);
       const saved=stlo();
       assert.equal(saved.jevBudget,3210);assert.equal(saved.jevOptions.mode,'adaptive');assert.equal(saved.jevOptions.adaptiveThreshold,43210);assert.equal(saved.jevOptions.recent,17);assert.equal(saved.jevOptions.partialInjection,true);
       await openPage();await open();
       result.reopened=await page.evaluate(()=>({mode:document.querySelector('input[name="stlo-jev-mode"]:checked')?.value,budget:document.querySelector('#stlo-jev-budget')?.value,threshold:document.querySelector('#stlo-jev-adaptive-threshold')?.value,partial:document.querySelector('#stlo-jev-partial')?.checked,recent:document.querySelector('#stlo-jev-recent')?.value}));
       assert.deepEqual(result.reopened,{mode:'adaptive',budget:'3210',threshold:'43210',partial:true,recent:'17'});
       await close(true);await pause(1500);assert.deepEqual(stlo(),saved,'unchanged save changed settings');result.savedBytes=Buffer.byteLength(JSON.stringify(saved));
       assert.equal(result.rp.length,0);assert.equal(result.decisions.length,0);
     }else throw Error('Unknown case '+caseId);
     result.booksSame=before.every((hash,i)=>hash===digest(path.join(home,'worlds',[aBook,bBook][i]+'.json')));
     assert.ok(result.booksSame,'stored book changed');
     if(caseId!=='settings')assert.equal(JSON.stringify(stlo()),baseline,'settings changed during generation');
     result.pass=true;
   }catch(error){result.pass=false;result.failure=String(error?.message??error).slice(0,500);failures.push(caseId);}
   finally{
     write(path.join(evidence,caseId+'.json'),result);
     console.log(JSON.stringify(result));
     await context.close();
     if(server.exitCode===null){server.kill();await Promise.race([new Promise(r=>server.once('exit',r)),pause(3500)]);}
     fs.closeSync(log);
   }
 }
}finally{await browser?.close();}
if(failures.length)throw Error('Host regression failed: '+failures.join(', '));
