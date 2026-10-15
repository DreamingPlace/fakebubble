import { fixtureOptions } from './cloudflare-business-worker.ts';
import { WebHTTPFixture } from './cloudflare-http-worker.ts';

// Part 17f: the real-HTTP fixture with the free tier (SIGNUP_BONUS_ENABLED) AND the chat review (CHAT_REVIEW_ENABLED) both
// on, as in production. The other public switches are set through /fixture/players.
fixtureOptions.publicFreeTier = true;
fixtureOptions.chatReview = true;
export class WebHTTPAllFixture extends WebHTTPFixture {}
export { default } from './cloudflare-http-worker.ts';
