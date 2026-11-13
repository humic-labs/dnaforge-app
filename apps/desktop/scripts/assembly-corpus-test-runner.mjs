import { VitestTestRunner } from 'vitest/runners';

export default class AssemblyCorpusTestRunner extends VitestTestRunner {
  async onBeforeTryTask(test) {
    await super.onBeforeTryTask(test);
    const file = test.file.filepath.replaceAll('\\', '/');
    if (!file.includes('/src/features/assembly-graph/__tests__/inference/')) return;

    await this.onTaskUpdate([], []);
  }
}
