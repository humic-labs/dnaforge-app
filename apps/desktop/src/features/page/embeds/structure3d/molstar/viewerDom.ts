import { toUserMessage, userMessage, type UserMessage } from '@waypoint/user-messages';
const MOLSTAR_LOADING_STYLE_ID = 'waypoint-molstar-loading-styles';
export const MOLSTAR_VIEWER_GENERIC_LOADING_ERROR = userMessage('structure.failed');

export type ViewerDom = {
  container: HTMLDivElement;
  canvas: HTMLCanvasElement;
  loadingDiv: HTMLDivElement;
};

export function formatMolstarLoadingErrorText(error: string): UserMessage {
  return toUserMessage(error, 'structure.failed');
}

function ensureMolstarLoadingAnimationStyles(): void {
  if (document.getElementById(MOLSTAR_LOADING_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = MOLSTAR_LOADING_STYLE_ID;
  style.textContent = `
    @keyframes waypoint-molstar-spin {
      to { transform: rotate(360deg); }
    }

    @keyframes waypoint-molstar-loading-sweep {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(260%); }
    }
  `;
  document.head.appendChild(style);
}

export function createMolstarLoadingIndicator(): HTMLDivElement {
  ensureMolstarLoadingAnimationStyles();

  const loadingDiv = document.createElement('div');
  loadingDiv.className = 'molstar-loading';
  loadingDiv.setAttribute('role', 'status');
  loadingDiv.setAttribute('aria-live', 'polite');
  loadingDiv.style.cssText = `
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.82);
    color: #4b5563;
    font-size: 12px;
    pointer-events: none;
  `;

  const panel = document.createElement('div');
  panel.style.cssText = `
    display: flex;
    min-width: 220px;
    max-width: min(320px, calc(100% - 32px));
    flex-direction: column;
    gap: 8px;
    border: 1px solid rgba(148, 163, 184, 0.38);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.92);
    padding: 12px 14px;
    box-shadow: 0 12px 32px rgba(15, 23, 42, 0.12);
  `;

  const row = document.createElement('div');
  row.style.cssText = `
    display: flex;
    align-items: center;
    gap: 9px;
  `;

  const spinner = document.createElement('span');
  spinner.dataset.testid = 'molstar-loading-spinner';
  spinner.setAttribute('aria-hidden', 'true');
  spinner.style.cssText = `
    width: 16px;
    height: 16px;
    flex: 0 0 auto;
    border: 2px solid #d1d5db;
    border-top-color: #2563eb;
    border-radius: 999px;
    animation: waypoint-molstar-spin 800ms linear infinite;
  `;

  const copy = document.createElement('div');
  copy.style.cssText = 'min-width: 0;';

  const title = document.createElement('div');
  title.dataset.testid = 'molstar-loading-title';
  title.style.cssText = 'font-size: 13px; font-weight: 600; color: #111827;';
  title.textContent = 'Preparing 3D structure...';

  const subtitle = document.createElement('div');
  subtitle.dataset.testid = 'molstar-loading-detail';
  subtitle.style.cssText = 'margin-top: 2px; color: #6b7280;';
  subtitle.textContent = 'Fetching, parsing, and drawing the preview.';

  const rail = document.createElement('div');
  rail.dataset.testid = 'molstar-loading-progress';
  rail.style.cssText = `
    position: relative;
    height: 3px;
    overflow: hidden;
    border-radius: 999px;
    background: #e5e7eb;
  `;

  const sweep = document.createElement('div');
  sweep.style.cssText = `
    position: absolute;
    inset: 0 auto 0 0;
    width: 38%;
    border-radius: inherit;
    background: linear-gradient(90deg, rgba(37, 99, 235, 0), #2563eb, rgba(37, 99, 235, 0));
    animation: waypoint-molstar-loading-sweep 1400ms ease-in-out infinite;
  `;

  copy.append(title, subtitle);
  row.append(spinner, copy);
  rail.appendChild(sweep);
  panel.append(row, rail);
  loadingDiv.appendChild(panel);
  return loadingDiv;
}

export function createViewerDOM(): ViewerDom {
  const container = document.createElement('div');
  container.className = 'molstar-viewer-inner';
  container.style.cssText = `
    width: 100%;
    height: 100%;
    position: relative;
  `;

  const canvas = document.createElement('canvas');
  canvas.style.cssText = `
    width: 100%;
    height: 100%;
    visibility: hidden;
  `;
  container.appendChild(canvas);

  const loadingDiv = createMolstarLoadingIndicator();
  container.appendChild(loadingDiv);

  return { container, canvas, loadingDiv };
}
