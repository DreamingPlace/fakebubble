import { fixtureOptions } from './cloudflare-business-worker.ts';
import { WebHTTPFixture } from './cloudflare-http-worker.ts';

// Part 19: the same real-HTTP fixture with CHAT_REVIEW_ENABLED on (pseudonymous transcript review and the anonymous archive).
fixtureOptions.chatReview = true;
export class WebHTTPReviewFixture extends WebHTTPFixture {}
export { default } from './cloudflare-http-worker.ts';
