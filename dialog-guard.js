// dialog-guard.js — runs in the page's MAIN world on every frame.
// Native alert()/confirm()/prompt() block the page's JS thread, which is the
// same thread content.js runs on — so a dialog triggered mid-flow would
// otherwise freeze recording/replay forever. While Flowcraft is armed
// (recording or replaying on this tab), these calls are intercepted instead
// of shown: alert() is swallowed, confirm() auto-accepts, prompt() returns
// its default value. Outside of recording/replay it's a transparent
// pass-through so normal browsing is unaffected.
(() => {
  if (window.__flowRecorderGuardInstalled) return;
  window.__flowRecorderGuardInstalled = true;

  let active = false;
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const data = e.data;
    if (data && data.__flowRecorderGuard === true) active = !!data.active;
  });

  const nativeAlert = window.alert ? window.alert.bind(window) : null;
  const nativeConfirm = window.confirm ? window.confirm.bind(window) : null;
  const nativePrompt = window.prompt ? window.prompt.bind(window) : null;

  function report(dialogType, message, answer) {
    window.postMessage({
      __flowRecorderDialog: true,
      dialogType,
      message: message == null ? '' : String(message),
      answer
    }, '*');
  }

  if (nativeAlert) {
    window.alert = function (message) {
      if (!active) return nativeAlert(message);
      report('alert', message, null);
    };
  }

  if (nativeConfirm) {
    window.confirm = function (message) {
      if (!active) return nativeConfirm(message);
      report('confirm', message, true);
      return true;
    };
  }

  if (nativePrompt) {
    window.prompt = function (message, defaultValue) {
      if (!active) return nativePrompt(message, defaultValue);
      const answer = defaultValue != null ? defaultValue : '';
      report('prompt', message, answer);
      return answer;
    };
  }
})();
