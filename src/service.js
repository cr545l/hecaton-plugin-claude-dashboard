// One hook/state owner per plugin. Requests start it after a UI is attached so
// permission prompts have a window to target. Closing a UI only detaches it.
let serviceStart = null;
let serviceQueue = Promise.resolve();
let controller;
const serviceHost = hecaton.serviceHost({
  protocol: 1,
  onRequest: async (_link, method, params) => {
    if (!serviceStart) serviceStart = (async () => {
      await ensureNotificationPermission('permission.reason.startup');
      await controller.start();
    })();
    await serviceStart;
    const work = serviceQueue.then(async () => {
      if (method === 'action') await controller.action(params?.action);
      else if (method !== 'status') throw new Error('Unknown service request: ' + method);
      return controller.snapshot();
    });
    serviceQueue = work.catch(() => {});
    return work;
  },
});
controller = createClaudeState(hecaton, {
  service: true,
  onChange: (snapshot) => serviceHost.broadcast('state', snapshot).catch(() => {}),
});
hecaton.onShutdown(async () => {
  // Dispose now so a late serve/subscribe reply is released as well.
  await controller.dispose();
  await Promise.allSettled([serviceStart, serviceQueue]);
}, { graceMs: 4000 });
await serviceHost.listen();
