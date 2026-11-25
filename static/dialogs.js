'use strict';

const DialogUI = (() => {
  const dialog = document.querySelector('#action-dialog');
  const title = document.querySelector('#action-title');
  const message = document.querySelector('#action-message');
  const field = document.querySelector('#action-value');
  const yes = document.querySelector('#action-confirm');
  const no = document.querySelector('#action-cancel');
  let pending = null, context = null, valid = null;
  const key = s => s ? `${s.code}:${s.me.id}:${s.stage}` : '';

  function dismiss(accepted = false) {
    const resolve = pending;
    pending = null; context = null; valid = null;
    if (dialog.open) dialog.close();
    field.value = '';
    if (resolve) resolve(accepted);
  }

  function open(options, confirmation) {
    dismiss();
    context = key(state);
    valid = options.valid || null;
    title.textContent = options.title;
    message.textContent = options.message;
    field.hidden = options.value === undefined;
    field.value = options.value ?? '';
    yes.hidden = !confirmation;
    yes.textContent = options.confirmLabel || 'Подтвердить';
    yes.classList.toggle('danger-button', Boolean(options.danger));
    no.textContent = confirmation ? 'Отмена' : 'Закрыть';
    dialog.showModal();
    // The safe action receives focus, including for destructive confirmations.
    if (field.hidden) no.focus();
    else { field.focus(); field.select(); }
  }

  function ask(options) {
    open(options, true);
    return new Promise(resolve => { pending = resolve; });
  }
  function showText(options) { open(options, false); }
  function receive(next) {
    if (dialog.open && (context !== key(next) || (valid && !valid(next)))) dismiss();
  }
  yes.addEventListener('click', () => {
    const accepted = context === key(state) && (!valid || valid(state));
    dismiss(accepted);
  });
  no.addEventListener('click', () => dismiss());
  document.querySelector('#action-close').addEventListener('click', () => dismiss());
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
  dialog.addEventListener('click', event => { if (event.target === dialog) {
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dismiss();
  } });
  dialog.addEventListener('close', () => { if (!dialog.open) dismiss(); });
  return {ask, showText, receive, dismiss, key};
})();
