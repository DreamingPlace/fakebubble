// Part 40: the HTTP fixture with 多轮预演 wired the way business.ts wires it (the judge through the generation Worker, the Grok / Gemini
// prices and the player-model ceiling), so a run can be started over HTTP and driven by the alarm alone. Never shipped.
import { fixtureRehearsal } from './cloudflare-http-worker.ts';
fixtureRehearsal.on = true;
export * from './cloudflare-http-worker.ts';
export { default } from './cloudflare-http-worker.ts';
