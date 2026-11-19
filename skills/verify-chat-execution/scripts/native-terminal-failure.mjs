#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { finalizeJourneyRecording } from '../../../apps/desktop/scripts/lib/native-journey-recording.mjs';
const { values } = parseArgs({ options: { out: { type: 'string' }, database: { type: 'string' } } });
assert.ok(values.out && values.database, 'Provide --out /absolute/external/evidence --database /absolute/owned-profile/dnaforge.db');
const database = resolve(values.database);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const out = resolve(values.out);
assert.ok(!out.startsWith(root + '/'));
mkdirSync(out, { recursive: false });
mkdirSync(join(out, 'frames'));
const receipt = { sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), steps: [], requests: [], frames: [], errors: [] };
let browser, cdp, page, trigger;
const held = [];
const fixture = text => [
 ['message_start', {type:'message_start',message:{id:'fixture-message',type:'message',role:'assistant',content:[],model:'claude-sonnet-4-6',stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:1}}}],
 ['content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}}],
 ['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text}}],
 ['content_block_stop',{type:'content_block_stop',index:0}],
 ['message_delta',{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:10}}],
 ['message_stop',{type:'message_stop'}],
].map(([event,data])=>`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
function changeTrigger(action, turnId) {
 return execFileSync('python3', ['-c', `import pathlib,sqlite3,sys
path,action,trigger,turn_id=sys.argv[1:]
assert pathlib.Path(path).is_file()
assert trigger.replace('_','').isalnum()
with sqlite3.connect(path,timeout=10) as db:
 if action=='create':
  row=db.execute('SELECT status FROM chat_turns WHERE id=?',(turn_id,)).fetchone()
  assert row==('running',), row
  assert turn_id.replace('-','').isalnum()
  db.execute("CREATE TRIGGER "+trigger+" BEFORE UPDATE OF status ON chat_turns WHEN OLD.id='"+turn_id+"' AND NEW.status<>'running' BEGIN SELECT RAISE(ABORT, 'acceptance terminal write rejected'); END")
 else:
  db.execute('DROP TRIGGER IF EXISTS '+trigger)
 print(action+' '+trigger)
`, database, action, trigger, turnId ?? ''], { encoding: 'utf8' });
}
try {
 const status=execFileSync(process.execPath,['apps/desktop/scripts/dev-single-instance-guard.cjs','--status'],{cwd:root,encoding:'utf8'});
 assert.match(status,/^ELECTRON_DEV_(?:HEALTHY|ATTACHED)$/mu);
 const endpoint=status.match(/DevTools\/CDP:\s*(http:\/\/127\.0\.0\.1:\d+)/u)?.[1];
 const renderer=status.match(/Desktop renderer:\s*(http:\/\/[^\s]+)/u)?.[1];
 browser=await chromium.connectOverCDP(endpoint);
 page=browser.contexts().flatMap(c=>c.pages()).find(p=>new URL(p.url()).port===new URL(renderer).port);
 assert.ok(page);
 receipt.renderer=page.url();
 assert.ok(database.includes(`DNAForge-dev-${new URL(renderer).port}/`), 'Database must belong to this exact owned development profile');
 receipt.database=database;
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
 const first=await rows();
 const message=first.messages.find(m=>m.role==='user'&&m.content===`${marker} first`);
 assert.ok(message?.turn_id);
 assert.match(message.turn_id,/^[a-zA-Z0-9-]+$/u);
 trigger=`acceptance_terminal_failure_${Date.now()}`;
 receipt.triggerInstalled=changeTrigger('create',message.turn_id);
 receipt.turnId=message.turn_id;
 await step('terminal commit fault installed for this turn only');
 await held.shift().fulfill({status:200,contentType:'text/event-stream',body:fixture('Answer whose terminal commit is rejected.')});
 const state=()=>page.evaluate(async()=>{const {useChatStore}=await import('/src/features/ai/hooks/useChat.ts');const s=useChatStore.getState();return {isLoading:s.isLoading,error:s.error,activeTurn:s.activeTurn};});
 await expect.poll(async()=>Boolean((await state()).error)||receipt.errors.some(e=>e.includes('acceptance terminal write rejected')),{timeout:15000}).toBe(true);
 await step('native terminal write rejected and orchestration settled');
 receipt.failureState=await state();
 assert.equal((await rows()).turns.find(t=>t.id===message.turn_id)?.status,'running');
 assert.equal(receipt.failureState.isLoading,true,'Uncommitted terminal state must retain busy ownership');
 await expect(page.getByTestId('ai-stop-button').last()).toBeVisible();
 await input.fill(`${marker} queued after failure`);await input.press('Enter');
 await expect(page.getByTestId('queued-chat-message')).toHaveCount(1);
 assert.equal(held.length,0,'A second provider must not start before the first turn is durably terminal');
 await step('follow-up queued behind the uncommitted turn');
 assert.ok(receipt.errors.every(error=>error.includes('acceptance terminal write rejected')));
 receipt.passed=true;
} catch(error) {receipt.failure=String(error.stack??error);process.exitCode=1;} finally {
 if(trigger) {try {receipt.triggerRemoved=changeTrigger('drop');} catch(error) {receipt.triggerCleanupError=String(error);process.exitCode=1;}}
 await cdp?.send('Page.stopScreencast').catch(()=>{});
 for(const route of held) await route.abort().catch(()=>{});
 try {
  if(receipt.triggerCleanupError) receipt.passed=false;
  finalizeJourneyRecording(out,receipt,{video:'journey.mp4'});
  if(receipt.status!=='passed') process.exitCode=1;
  if(receipt.mediaError) console.error(receipt.mediaError);
 } finally {
  await browser?.close();
 }
 console.log(JSON.stringify({out,passed:receipt.passed,failure:receipt.failure}));
}
