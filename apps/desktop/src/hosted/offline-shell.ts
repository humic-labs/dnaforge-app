export async function prepareHostedOfflineShell(): Promise<void> {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.register(
    `${import.meta.env.BASE_URL}offline-worker.js`,
    { scope: '/' }
  );
  const installing = registration.installing ?? registration.waiting;
  if (installing && installing.state !== 'activated') {
    await new Promise<void>((resolve, reject) => {
      installing.addEventListener('statechange', () => {
        if (installing.state === 'activated') resolve();
        if (installing.state === 'redundant')
          reject(new Error('The current offline shell did not finish installing.'));
      });
    });
  }
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((resolve) =>
      navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true })
    );
  }
  document.documentElement.dataset.hostedOfflineReady = 'true';
  await navigator.storage?.persist?.().catch(() => false);
}
