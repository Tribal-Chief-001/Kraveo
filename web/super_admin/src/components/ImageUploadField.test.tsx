// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { ImageUploadField } from './ImageUploadField';
import { ApiError, apiService } from '../services/api';
import { Decoded, ImageEnv } from '../lib/imageCompress';
import { byText, click, flush, mount, type, unmount } from '../test/dom';

const blobOf = (size: number, type = 'image/webp') => ({ size, type }) as unknown as Blob;
/** A fake canvas: decode gives the stated size, encode gives a small WebP. */
const fakeEnv = (dims = { width: 2000, height: 1000 }, opts: { fail?: boolean } = {}): ImageEnv & { encode: ReturnType<typeof vi.fn> } => ({
  decode: async () => { if (opts.fail) throw new Error('cannot decode'); return { ...dims, source: {} } as Decoded; },
  encode: vi.fn(async (_d: Decoded, w: number, h: number, mime: string) => blobOf(w * h / 20, mime)),
  webpSupported: () => true,
});

const choose = async (file: File) => {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
};
const photo = (name = 'dosa.jpg', type = 'image/jpeg') => new File([new Uint8Array(3000)], name, { type });

const Harness: React.FC<{ env: ImageEnv; start?: string; onBusy?: (b: boolean) => void; purpose?: 'banner' | 'dish' }> = ({ env, start = '', onBusy, purpose = 'dish' }) => {
  const [value, setValue] = React.useState(start);
  return <ImageUploadField id="img" label="Photo web address" purpose={purpose} value={value} onChange={setValue} previewAlt="Photo of the dish" env={env} onBusyChange={onBusy} onAuthError={(e) => (window as any).__authErr?.(e)} />;
};

afterEach(async () => { vi.restoreAllMocks(); await unmount(); });

describe('ImageUploadField', () => {
  it('shrinks the chosen photo, uploads the small version, puts the returned link in the field and previews it', async () => {
    const env = fakeEnv();
    const upload = vi.spyOn(apiService, 'uploadImage').mockResolvedValue({ url: 'https://api.kraveo.site/uploads/dish/2026/aaaa.webp', width: 1200, height: 600, bytes: 36000 });
    const busy = vi.fn();
    const host = await mount(<Harness env={env} onBusy={busy} />);
    await choose(photo());
    await flush();
    // the canvas was asked for the 1200 px version, not the original
    expect(env.encode).toHaveBeenCalledWith(expect.anything(), 1200, 600, 'image/webp', 0.82);
    expect(upload).toHaveBeenCalledTimes(1);
    const sent = upload.mock.calls[0];
    expect(sent[1]).toBe('dish');
    expect((sent[0] as Blob).type).toBe('image/webp');
    expect((document.getElementById('img') as HTMLInputElement).value).toBe('https://api.kraveo.site/uploads/dish/2026/aaaa.webp');
    expect(host.querySelector('img')!.getAttribute('src')).toBe('https://api.kraveo.site/uploads/dish/2026/aaaa.webp');
    expect(host.querySelector('img')!.getAttribute('alt')).toBe('Photo of the dish');
    expect(host.textContent).toContain('Photo uploaded (1200 x 600, 35 KB).');
    expect(byText('button', 'Replace photo', host)).toBeTruthy();
    expect(busy.mock.calls.map((c) => c[0])).toEqual([true, true, false]); // preparing, uploading, done
  });

  it('shows Preparing and then Uploading while it works, and locks the controls', async () => {
    const env = fakeEnv();
    let release: (v: any) => void = () => {};
    vi.spyOn(apiService, 'uploadImage').mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const host = await mount(<Harness env={env} />);
    await choose(photo());
    await flush();
    expect(host.textContent).toContain('Uploading…');
    expect((document.getElementById('img') as HTMLInputElement).disabled).toBe(true);
    expect(byText('button', 'Uploading…', host)!.getAttribute('aria-busy')).toBe('true');
    await act(async () => { release({ url: 'https://api.kraveo.site/uploads/dish/2026/b.webp', width: 1200, height: 600, bytes: 100 }); });
    await flush();
    expect((document.getElementById('img') as HTMLInputElement).disabled).toBe(false);
  });

  it('a file that is not a picture is refused in plain words and nothing is uploaded', async () => {
    const env = fakeEnv();
    const upload = vi.spyOn(apiService, 'uploadImage');
    const host = await mount(<Harness env={env} />);
    await choose(new File(['hello'], 'menu.pdf', { type: 'application/pdf' }));
    await flush();
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('That file is not a picture. Choose a JPG, PNG or WebP photo.');
    expect(upload).not.toHaveBeenCalled();
  });

  it('a picture the browser cannot decode is a plain error', async () => {
    const host = await mount(<Harness env={fakeEnv({ width: 1, height: 1 }, { fail: true })} />);
    await choose(photo('broken.jpg'));
    await flush();
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('could not be opened');
  });

  it('a picture that is too small is refused before upload', async () => {
    const upload = vi.spyOn(apiService, 'uploadImage');
    const host = await mount(<Harness env={fakeEnv({ width: 100, height: 100 })} />);
    await choose(photo('tiny.png', 'image/png'));
    await flush();
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('too small (100 x 100)');
    expect(upload).not.toHaveBeenCalled();
  });

  it('a server refusal keeps the old link and shows the server words; an auth failure is reported', async () => {
    const authErr = vi.fn();
    (window as any).__authErr = authErr;
    const failure = new ApiError(429, 'Too many uploads. Try again later.', 'RATE_LIMITED');
    vi.spyOn(apiService, 'uploadImage').mockRejectedValue(failure);
    const host = await mount(<Harness env={fakeEnv()} start="https://old.example/a.jpg" />);
    await choose(photo());
    await flush();
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('Too many uploads. Try again later.');
    expect((document.getElementById('img') as HTMLInputElement).value).toBe('https://old.example/a.jpg');
    expect(authErr).toHaveBeenCalledWith(failure);
    delete (window as any).__authErr;
  });

  it('Remove clears the link; Replace is offered while a link is set; the field can be typed in', async () => {
    const host = await mount(<Harness env={fakeEnv()} start="https://x.test/a.jpg" />);
    expect(byText('button', 'Replace photo', host)).toBeTruthy();
    await click(byText('button', 'Remove photo', host));
    expect((document.getElementById('img') as HTMLInputElement).value).toBe('');
    expect(byText('button', 'Upload photo', host)).toBeTruthy();
    expect(host.querySelector('img')).toBeNull();
    await type(document.getElementById('img'), 'https://y.test/b.png');
    expect(host.querySelector('img')!.getAttribute('src')).toBe('https://y.test/b.png');
  });

  it('a preview that fails to load says so without calling the link wrong', async () => {
    const host = await mount(<Harness env={fakeEnv()} start="https://blocked.test/a.jpg" />);
    await act(async () => { host.querySelector('img')!.dispatchEvent(new Event('error')); });
    expect(host.textContent).toContain('The preview could not be loaded here. The link may still work in the app.');
  });

  it('the upload button opens the hidden file chooser; the file input has an accessible name', async () => {
    const host = await mount(<Harness env={fakeEnv()} />);
    const input = host.querySelector('input[type="file"]') as HTMLInputElement;
    const clicked = vi.spyOn(input, 'click');
    await click(byText('button', 'Upload photo', host));
    expect(clicked).toHaveBeenCalled();
    expect(input.getAttribute('aria-label')).toBe('Photo web address: choose a photo file');
    expect(input.accept).toBe('image/*');
  });

  it('uses the real compress path with a mocked canvas (jsdom has none): no crash, plain error', async () => {
    // no env injected -> browserEnv(): jsdom cannot decode, so the admin gets the plain "could not be opened" sentence
    vi.spyOn(apiService, 'uploadImage');
    const host = await mount(<ImageUploadField id="img2" label="Banner" purpose="banner" value="" onChange={() => {}} previewAlt="x" />);
    await choose(photo());
    await flush();
    expect(host.querySelector('[role="alert"]')!.textContent).toMatch(/could not be opened|could not prepare/);
  });
});
