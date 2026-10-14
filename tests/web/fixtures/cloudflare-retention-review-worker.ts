import { fixtureOptions } from './cloudflare-business-worker.ts';
import { WebRetentionFixture } from './cloudflare-retention-worker.ts';

// Part 19: the retention fixture with CHAT_REVIEW_ENABLED on.
fixtureOptions.chatReview = true;
export class WebRetentionReviewFixture extends WebRetentionFixture {}
export { default } from './cloudflare-retention-worker.ts';
