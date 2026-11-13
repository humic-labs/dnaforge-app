import { app } from 'electron';
import { enforcesStartupPhases, markStartupPhase } from './features/startup-phases';

const worktreeCwd = process.env.DNAFORGE_BACKGROUND_WORKTREE_CWD;
if (!app.isPackaged && process.env.DNAFORGE_BACKGROUND_LAUNCH_SAFE === '1' && worktreeCwd) {
  process.chdir(worktreeCwd);
}
if (enforcesStartupPhases()) markStartupPhase('working-directory');
