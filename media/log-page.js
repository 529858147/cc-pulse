// Editor tab: the request log at full width.
(function () {
  const api = acquireVsCodeApi();
  const log = window.RequestLog(api, api.getState(), (q) => api.setState(q), { size: 50, scope: 'session', compact: false });
  log.attach(document.getElementById('app'));
  window.addEventListener('message', ({ data }) => log.onMessage(data));
  log.start();
})();
