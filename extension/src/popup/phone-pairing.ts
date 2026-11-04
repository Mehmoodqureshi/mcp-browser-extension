import QRCode from 'qrcode';
import { PHONE_INVITATION_MS, type PhoneAction, type PhonePairingState, type PhoneReply } from '../../../shared/phone-pairing';
import { ACCESS_STOPPED_KEY } from '../../../shared/activity';
import { renderList } from '../ui-controls';

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const dialog = element<HTMLDialogElement>('phone-dialog');
const qr = element<HTMLCanvasElement>('phone-qr');
const generate = element<HTMLButtonElement>('phone-generate');
const cancel = element<HTMLButtonElement>('phone-cancel');
const error = element('phone-error');
const status = element('phone-status');
const expiry = element('phone-expiry');
const list = element('phone-devices');
let state: PhonePairingState | undefined;
let renderedPayload = '';
let busy = false;
let polling = false;
let stopped = false;
let timer: ReturnType<typeof setInterval> | undefined;
let generation = 0;

function message(text: string): void { error.textContent = text; error.hidden = !text; }

async function send(action: PhoneAction, id?: string): Promise<void> {
  if (busy || (action === 'state' && polling)) return;
  const changesAccess = action !== 'state';
  if (changesAccess) busy = true;
  else polling = true;
  const version = ++generation;
  if (changesAccess) refreshControls();
  try {
    // Send while the trusted click still carries the permission gesture.
    const replyPromise = chrome.runtime.sendMessage({ type: 'phone_pairing', action, id }) as Promise<PhoneReply>;
    const [reply, saved] = await Promise.all([replyPromise, chrome.storage.local.get(ACCESS_STOPPED_KEY)]);
    const access = saved[ACCESS_STOPPED_KEY];
    stopped = access !== undefined && access !== false;
    if (version !== generation || !dialog.open) return;
    if (!reply?.ok) {
      state = undefined;
      message(reply && !reply.ok ? reply.message : 'Could not reach phone pairing. Try again.');
    } else {
      state = reply.state;
      message('');
    }
    await render();
  } catch {
    if (version === generation && dialog.open) {
      state = undefined;
      message('Could not reach phone pairing. Reopen the extension and try again.');
      await render();
    }
  } finally {
    if (changesAccess) busy = false;
    else polling = false;
    if (dialog.open) refreshControls();
  }
}

function refreshControls(): void {
  generate.disabled = busy || stopped || state?.online === false;
  cancel.disabled = busy;
  list.querySelectorAll<HTMLButtonElement>('button').forEach((b) => { b.disabled = busy || (stopped && b.dataset.allow === 'true'); });
}

function tick(): void {
  const left = Math.max(0, (state?.invitation?.expiresAt ?? 0) - Date.now());
  if (left > 0) {
    const seconds = Math.ceil(left / 1000);
    expiry.textContent = `Code expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  } else if (state?.invitation) {
    qr.hidden = true;
    qr.getContext('2d')?.clearRect(0, 0, qr.width, qr.height);
    renderedPayload = '';
    expiry.textContent = 'Code expired. Generate a new QR code.';
  }
}

function actionButton(label: string, action: PhoneAction, id: string, primary = false): HTMLButtonElement {
  const button = document.createElement('button');
  button.textContent = label;
  if (primary) button.className = 'primary';
  button.dataset.allow = String(action === 'approve');
  button.addEventListener('click', (event) => { if (event.isTrusted) void send(action, id); });
  return button;
}

async function render(): Promise<void> {
  const invitation = state?.invitation;
  const usable = invitation && invitation.expiresAt > Date.now() && invitation.expiresAt <= Date.now() + PHONE_INVITATION_MS + 5_000;
  qr.hidden = !usable;
  expiry.hidden = !invitation;
  cancel.hidden = !invitation && !state?.devices.some((d) => d.state === 'pending');
  generate.textContent = invitation ? 'New QR code' : 'Generate QR code';
  status.textContent = stopped ? 'Browser access is stopped. Resume it before pairing a phone.'
    : state?.online === false ? 'Remote connection is offline. Pairing resumes when this computer reconnects.'
    : usable ? 'Scan this code. It can be used once.'
    : state?.devices.some((d) => d.state === 'pending') ? 'Check the number on your phone before approving.'
    : state ? `Ready to pair with ${state.profile}.` : '';
  if (usable && renderedPayload !== invitation.payload) {
    renderedPayload = invitation.payload;
    await QRCode.toCanvas(qr, invitation.payload, { width: 264, margin: 4, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
  } else if (!usable) {
    renderedPayload = '';
    qr.getContext('2d')?.clearRect(0, 0, qr.width, qr.height);
  }
  renderList(list, state?.devices ?? [], (d) => d.id, (d) => JSON.stringify(d), (phone) => {
    const row = document.createElement('li');
    row.dataset.phoneId = phone.id;
    const name = document.createElement('strong');
    name.textContent = phone.name;
    const detail = document.createElement('p');
    detail.className = 'note';
    detail.textContent = phone.state === 'pending' ? 'Requests access to this browser.'
      : phone.browserApproved === false ? 'Browser access was stopped. Remove this phone and pair it again.'
      : `Paired until ${new Date(phone.expiresAt).toLocaleDateString()}`;
    const actions = document.createElement('div');
    actions.className = 'phone-actions';
    row.append(name, detail);
    if (phone.state === 'pending') {
      const code = document.createElement('p');
      code.className = 'phone-code';
      code.textContent = `${phone.confirmation.slice(0, 3)} ${phone.confirmation.slice(3)}`;
      code.setAttribute('aria-label', `Confirmation number ${phone.confirmation.split('').join(' ')}`);
      row.append(code);
      actions.append(actionButton('Allow this phone', 'approve', phone.id, true), actionButton('Deny', 'deny', phone.id));
    } else actions.append(actionButton('Remove access', 'remove', phone.id));
    row.append(actions);
    return row;
  });
  tick();
  refreshControls();
}

element('phone-open').addEventListener('click', (event) => {
  if (!event.isTrusted) return;
  dialog.showModal();
  message('');
  status.textContent = 'Checking remote connection...';
  void send('state');
  timer = setInterval(() => { tick(); void send('state'); }, 2_000);
});
element('phone-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => {
  generation++;
  clearInterval(timer);
  qr.hidden = true;
  qr.getContext('2d')?.clearRect(0, 0, qr.width, qr.height);
  renderedPayload = '';
});
generate.addEventListener('click', (event) => { if (event.isTrusted) void send('create'); });
cancel.addEventListener('click', (event) => { if (event.isTrusted) void send('cancel'); });
