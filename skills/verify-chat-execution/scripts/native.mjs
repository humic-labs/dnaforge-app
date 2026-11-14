#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
const { values } = parseArgs({ options: { out: { type: 'string' } } });
assert.ok(values.out, 'Provide --out /absolute/external/evidence');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const out = resolve(values.out);
assert.ok(!out.startsWith(root + '/'));
mkdirSync(out, { recursive: false });
mkdirSync(join(out, 'frames'));
const receipt = { sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), steps: [], requests: [], frames: [], errors: [] };
let browser, cdp;
const held = [];
const fixture = text => [
 ['message_start', {type:'message_start',message:{id:'fixture-message',type:'message',role:'assistant',content:[],model:'claude-sonnet-4-6',stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:1}}}],
 ['content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}}],
 ['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text}}],
 ['content_block_stop',{type:'content_block_stop',index:0}],
 ['message_delta',{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:10}}],
 ['message_stop',{type:'message_stop'}],
].map(([event,data])=>`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
try {
 const status=execFileSync(process.execPath,['apps/desktop/scripts/dev-single-instance-guard.cjs','--status'],{cwd:root,encoding:'utf8'});
 assert.match(status,/^ELECTRON_DEV_(?:HEALTHY|ATTACHED)$/mu);
 const endpoint=status.match(/DevTools\/CDP:\s*(http:\/\/127\.0\.0\.1:\d+)/u)?.[1];
 const renderer=status.match(/Desktop renderer:\s*(http:\/\/[^\s]+)/u)?.[1];
 browser=await chromium.connectOverCDP(endpoint);
 const page=browser.contexts().flatMap(c=>c.pages()).find(p=>new URL(p.url()).port===new URL(renderer).port);
 assert.ok(page);
 receipt.renderer=page.url();
 await page.route('https://api.anthropic.com/**',async route=>{
  const body=route.request().postDataJSON();
  receipt.requests.push({url:route.request().url(),stream:body?.stream,messages:body?.messages});
  if(body?.stream && JSON.stringify(body.messages).includes('User request:')) await route.fulfill({status:200,contentType:'text/event-stream',body:fixture('Lifecycle fixture')});
  else if(body?.stream) held.push(route);
  else await route.fulfill({json:{id:'fixture-title',type:'message',role:'assistant',content:[{type:'text',text:'Lifecycle fixture'}],model:'claude-sonnet-4-6',stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1}}});
 });
 await page.evaluate(async()=>{
  for(const [key,value] of [['ai_provider','anthropic'],['ai_model','claude-sonnet-4-6'],['ai_assistant_route',JSON.stringify({kind:'provider',provider:'anthropic',model:'claude-sonnet-4-6'})]])
   await window.electronAPI.db.execute('INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES (?,?,?)',[key,value,Date.now()]);
 });
 await page.reload();
 page.on('pageerror',error=>receipt.errors.push(error.message));
 cdp=await page.context().newCDPSession(page);
 cdp.on('Page.screencastFrame',frame=>{
  const file=`frames/${String(receipt.frames.length).padStart(6,'0')}.jpg`;
  writeFileSync(join(out,file),Buffer.from(frame.data,'base64'));
  receipt.frames.push({file,timestamp:frame.metadata.timestamp});
  void cdp.send('Page.screencastFrameAck',{sessionId:frame.sessionId}).catch(()=>{});
 });
 await cdp.send('Page.startScreencast',{format:'jpeg',quality:85,everyNthFrame:1});
 const rows=()=>page.evaluate(async()=>({turns:await window.electronAPI.db.select('SELECT id,conversation_id,status,terminal_reason FROM chat_turns ORDER BY started_at'),messages:await window.electronAPI.db.select('SELECT id,conversation_id,turn_id,role,content FROM messages ORDER BY created_at')}));
 const step=async name=>{const file=`${receipt.steps.length+1}.png`;await page.screenshot({path:join(out,file)});receipt.steps.push({name,file,at:new Date().toISOString(),rows:await rows()});};
 if(await page.getByText('DEV SCENARIOS',{exact:true}).isVisible()) await page.keyboard.press('Meta+Shift+L');
 await page.getByRole('button',{name:'Ask AI',exact:true}).click();
 if(!await page.getByTestId('ai-input').isVisible().catch(()=>false)) {
  await page.getByRole('button',{name:/AI|Chat/}).first().click();
 }
 if(await page.getByTestId('ai-new-conversation-button').isVisible()) await page.getByTestId('ai-new-conversation-button').click();
 const input=page.getByTestId('ai-input').last();
 await expect(input).toBeVisible();
 const marker=`Lifecycle ${Date.now()}`;
 await input.fill(`${marker} first`);await input.press('Enter');
 await expect.poll(()=>held.length).toBe(1);await step('first request active');
 await input.fill(`${marker} queued`);await input.press('Enter');
 await expect(page.getByTestId('queued-chat-message')).toHaveCount(1);await step('follow-up queued');
 await held.shift().fulfill({status:200,contentType:'text/event-stream',body:fixture('First fixture answer.')});
 await expect.poll(()=>held.length).toBe(1);await step('queued request advanced');
 await page.getByTestId('ai-stop-button').last().click();
 await expect.poll(async()=>{const r=await rows();return r.turns.filter(t=>t.status==='stopped').length;}).toBeGreaterThan(0);
 await step('second request stopped and persisted');
 await held.shift().fulfill({status:200,contentType:'text/event-stream',body:fixture('Late fixture answer must not replace stop.')}).catch(()=>{});
 const observed=await rows();
 const own=observed.messages.filter(m=>m.role==='user'&&m.content.startsWith(marker));
 assert.equal(own.length,2);assert.equal(own[0].conversation_id,own[1].conversation_id);
 const turns=own.map(m=>observed.turns.find(t=>t.id===m.turn_id));
 assert.deepEqual(turns.map(t=>t.status),['completed','stopped']);
 assert.ok(!observed.messages.some(m=>m.content.includes('Late fixture answer')));
 assert.equal(receipt.errors.length,0);
 receipt.passed=true;
} catch(error) {receipt.failure=String(error.stack??error);process.exitCode=1;} finally {
 await cdp?.send('Page.stopScreencast').catch(()=>{});
 for(const route of held) await route.abort().catch(()=>{});
 await browser?.close();
 writeFileSync(join(out,'receipt.json'),JSON.stringify(receipt,null,2));
 if(receipt.frames.length>1){
  const lines=receipt.frames.flatMap((f,i)=>[`file '${resolve(out,f.file)}'`,`duration ${Math.max(.01,(receipt.frames[i+1]?.timestamp??f.timestamp+.1)-f.timestamp)}`]);
  writeFileSync(join(out,'frames.txt'),lines.join('\n')+'\n');
  const video=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','concat','-safe','0','-i',join(out,'frames.txt'),'-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2','-pix_fmt','yuv420p',join(out,'journey.mp4')]);
  assert.equal(video.status,0,video.stderr?.toString());
 }
 console.log(JSON.stringify({out,passed:receipt.passed,failure:receipt.failure}));
}
