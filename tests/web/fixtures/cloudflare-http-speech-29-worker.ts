// Part 29: the HTTP fixture with the admin speech path enabled the way the production business object enables it.
import { fixtureSpeech } from './cloudflare-http-worker.ts';
fixtureSpeech.on = true;
export * from './cloudflare-http-worker.ts';
export { default } from './cloudflare-http-worker.ts';
