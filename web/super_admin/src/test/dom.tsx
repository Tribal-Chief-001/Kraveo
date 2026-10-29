// Small helpers shared by the catalog / settings component tests (jsdom + React act).
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { ToastProvider } from '../components/ui/Toast';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

export const mount = async (ui: React.ReactElement) => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<ToastProvider>{ui}</ToastProvider>); });
  return host;
};

export const unmount = async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null;
  document.body.innerHTML = '';
};

export const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
export const click = (el: Element | null | undefined) => act(async () => { (el as HTMLElement).click(); });

/** Sets an input / textarea / select value the way a user typing would (fires React's onChange). */
export const type = (el: Element | null, value: string) => act(async () => {
  const input = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
});

export const byText = (selector: string, text: string | RegExp, scope: ParentNode = document) =>
  Array.from(scope.querySelectorAll(selector)).find((el) => (typeof text === 'string' ? el.textContent?.trim() === text : text.test(el.textContent ?? ''))) as HTMLElement | undefined;

export const byId = (id: string) => document.getElementById(id);

/** Presses a key on the focused element (bubbles through window's capture phase, like a real key press). */
export const press = (key: string, init: KeyboardEventInit = {}) => act(async () => {
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
});

/** Waits (real time) until `check` is true; for debounced inputs. */
export const waitFor = async (check: () => boolean, ms = 1500) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
};

export const dialogs = () => Array.from(document.querySelectorAll('[role="dialog"],[role="alertdialog"]')) as HTMLElement[];
export const topDialog = () => dialogs()[dialogs().length - 1] as HTMLElement | undefined;
