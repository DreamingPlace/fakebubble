/** Which provider/model writes (draft) and reviews a reply, best first. Routing data only: never part of a prompt. */
export type TextProviderId = 'deepseek' | 'xai' | 'gemini';
export interface ModelRef {
  readonly provider: TextProviderId;
  readonly model: string;
}
/** Draft and review model chains for one reply. A later entry is used only after a definitely-not-billed failure. */
export interface TextRoute {
  readonly draft: readonly ModelRef[];
  readonly review: readonly ModelRef[];
}
