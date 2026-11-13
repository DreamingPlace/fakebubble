// Part 30: the HTTP fixture with the admin speech path AND 按反馈重录 enabled the way the production business object enables them.
import { fixtureSpeech } from './cloudflare-http-worker.ts';
fixtureSpeech.on = true;
fixtureSpeech.direction = true;
export * from './cloudflare-http-worker.ts';
export { default } from './cloudflare-http-worker.ts';
