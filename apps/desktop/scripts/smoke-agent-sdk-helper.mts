
import { detectAgentSdk } from '../src/main/agent-sdk/detect';
import { queryClaudeCode, queryCodex } from '../src/main/agent-sdk/query';

const prompt = process.argv[2] ?? 'Reply with the literal three-character string: ok.';

async function main(): Promise<void> {
  console.log('[smoke] Detecting installed CLIs…');
  const detection = await detectAgentSdk();
  console.log('[smoke] Detection:', JSON.stringify(detection, null, 2));

  let oneWorked = false;

  if (detection.claudeCode.cli === 'installed') {
    console.log('\n[smoke] Calling Claude Agent SDK via claude CLI…');
    const result = await queryClaudeCode(prompt);
    console.log(`[smoke] claude-agent-sdk ok=${result.ok} duration=${result.durationMs}ms`);
    console.log(`[smoke] text: ${JSON.stringify(result.text)}`);
    if (result.error) console.log(`[smoke] error: ${result.error}`);
    if (result.ok) oneWorked = true;
  } else {
    console.log('[smoke] Claude Code CLI not installed; skipping claude-agent-sdk smoke.');
  }

  if (detection.codex.cli === 'installed' && detection.codex.auth === 'authenticated') {
    console.log('\n[smoke] Calling Codex SDK via codex CLI…');
    const result = await queryCodex(prompt);
    console.log(`[smoke] codex-sdk ok=${result.ok} duration=${result.durationMs}ms`);
    console.log(`[smoke] text: ${JSON.stringify(result.text)}`);
    if (result.error) console.log(`[smoke] error: ${result.error}`);
    if (result.ok) oneWorked = true;
  } else {
    console.log(
      '\n[smoke] Codex not ready (not installed or not signed in); skipping codex-sdk smoke.'
    );
  }

  console.log(`\n[smoke] Final verdict: oneWorked=${oneWorked}`);
  process.exit(oneWorked ? 0 : 1);
}

main().catch((err) => {
  console.error('[smoke] Fatal:', err);
  process.exit(2);
});
