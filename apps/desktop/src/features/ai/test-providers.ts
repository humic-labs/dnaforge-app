#!/usr/bin/env npx tsx

import { createModel, type ProviderName } from './providers/index';
import { generateText } from 'ai';

const TEST_PROMPT = 'Say "Hello from [provider]!" where [provider] is your model name.';

async function testProvider(name: ProviderName, apiKey: string, model?: string) {
  try {
    console.log(`\n=== Testing ${name} ===`);
    const modelInstance = await createModel(name, apiKey, model);

    const result = await generateText({
      model: modelInstance,
      prompt: TEST_PROMPT,
      maxOutputTokens: 50,
    });

    console.log(`✅ ${name} works!`);
    console.log(`Response: ${result.text}`);
    console.log(`Tokens used: ${result.usage?.totalTokens || 'unknown'}`);
  } catch (error: unknown) {
    console.log(`❌ ${name} failed:`, (error as Error).message);
  }
}

async function main() {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const googleKey = process.env.GOOGLE_API_KEY;
  const xaiKey = process.env.XAI_API_KEY;
  const deepseekKey = process.env.DEEPSEEK_API_KEY;

  console.log('Testing all providers...\n');
  console.log('Make sure you have the following env vars set:');
  console.log('- ANTHROPIC_API_KEY');
  console.log('- OPENAI_API_KEY');
  console.log('- GOOGLE_API_KEY');
  console.log('- XAI_API_KEY');
  console.log('- DEEPSEEK_API_KEY');

  if (anthropicKey) await testProvider('anthropic', anthropicKey);
  if (openaiKey) await testProvider('openai', openaiKey);
  if (googleKey) await testProvider('google', googleKey);
  if (xaiKey) await testProvider('xai', xaiKey);
  if (deepseekKey) await testProvider('deepseek', deepseekKey);

  console.log('\n=== Testing custom models ===');
  if (anthropicKey) await testProvider('anthropic', anthropicKey, 'claude-3-opus-20240229');
  if (openaiKey) await testProvider('openai', openaiKey, 'gpt-3.5-turbo');
}

main().catch(console.error);
