import { fixtureOptions } from './cloudflare-business-worker.ts';
import { WebHTTPFixture } from './cloudflare-http-worker.ts';

// Part 17b: the same real-HTTP fixture with SIGNUP_BONUS_ENABLED on (5-reply trial, 10-reply signup bonus, 3 signups per IP per day).
fixtureOptions.publicFreeTier = true;
export class WebHTTPBonusFixture extends WebHTTPFixture {}
export { default } from './cloudflare-http-worker.ts';
