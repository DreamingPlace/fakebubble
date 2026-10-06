import type { MemoryCorrection } from './memory.ts';
import type { AutonomyPolicy } from './autonomy.ts';
import type { VoiceBinding } from './media.ts';
import type { Association, PlayerIntroductionContext } from './profile.ts';
import type { ProviderDeclaration, ProviderMeter } from './provider-calls.ts';
export type { AutonomyPolicy } from './autonomy.ts';
export const CONTRACT_VERSION = 1 as const;
export type RelationshipPreset = 'new' | 'friend' | 'close_friend' | 'lover';
export interface CharacterSelection {
  characterId: string;
  relationship: RelationshipPreset;
  association?: Association;
}
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export interface ScheduleSlot {
  startMinute: number;
  endMinute: number;
  probability: number;
  catchUp: boolean;
}
export interface WeeklySchedule {
  timeZone: string;
  days: Record<Weekday, ScheduleSlot[]>;
}
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export interface CharacterTemplate {
  id: string;
  name: string;
  version: number;
  fictional: true;
  persona: string;
  schedule: WeeklySchedule;
  // Absent on legacy templates: no automatic private-contact opportunities.
  autonomy?: AutonomyPolicy;
  // Only an explicitly approved, immutable voice version enables voice delivery.
  voice?: VoiceBinding;
  birthDate?: string;
  authorCanon?: { kind: 'author_canon'; settings: Record<string, JsonValue> };
}
// Trusted application context, resolved from credentials by the future HTTP layer.
export interface PlayerContext {
  playerId: string;
  worldId: string;
}
export interface CharacterScope extends PlayerContext {
  conversationId: string;
  characterId: string;
}
export interface MessageQuote {
  expired?: true;
  id: string;
  authorKind: 'player' | 'character';
  authorId: string;
  text: string;
  delivery: 'text' | 'voice';
}
export interface MessageDTO {
  id: string;
  worldId: string;
  conversationId: string;
  authorKind: 'player' | 'character';
  authorId: string;
  text: string;
  createdAt: number;
  delivery: 'text' | 'voice';
  voiceFallback: boolean;
  mediaId: string | null;
  proactive: boolean;
  mentionedCharacterIds?: string[];
  replyTo?: MessageQuote;
}
export interface MemoryCandidate {
  kind: 'public_fact' | 'fictional_day' | 'shared_experience' | 'relationship' | 'emotion';
  text: string;
  evidenceMessageIds: string[];
  occurredAt: number;
}
export interface ReplyCandidate {
  text: string;
  coveredMessageIds: string[];
  delivery: 'text' | 'voice';
  voiceFallback?: boolean;
  mediaId?: string;
  endsSession?: boolean;
}
export const EXPRESSIONS = [
  'neutral',
  'upbeat',
  'soft',
  'hesitant',
  'serious',
  'playful',
  'mock_annoyed',
  'excited',
  'sad',
  'surprised',
] as const;
export type Expression = (typeof EXPRESSIONS)[number];
export interface DialogueBubble {
  text: string;
  expression: Expression;
}
export interface TopicCandidate {
  key: string;
  // Set only after resolving an authorized existing memory in the reviewed request.
  linkedMemoryId?: string;
  summary: string;
  sourceKind: 'fictional_daily' | 'player_statement' | 'conversation';
  evidenceMessageIds: string[];
  sourceEvidenceIds?: string[];
  // The review's 1–10 importance; absent in candidates stored before it existed.
  importance?: number;
}
/** A stable fact the player stated about themselves; written only from player-authored messages of the request. */
export interface FactOp {
  op: 'add' | 'update' | 'retire';
  factKey: string;
  statement: string;
  importance: number;
  evidenceMessageIds: string[];
}
export interface DialogueCandidate extends ReplyCandidate {
  sceneUpdate?: import('./scenes.ts').SceneUpdate | null;
  relationshipEvents?: import('./relationships.ts').RelationshipEventCandidate[];
  bubbles: DialogueBubble[];
  mode: 'casual' | 'conflict_apology';
  deferredMessageIds: string[];
  awaitingPlayerMessageIds: string[];
  topics: TopicCandidate[];
  factOps?: FactOp[];
  endsSession: boolean;
  // Set by the review step, never by the model's draft: true when the review replaced the draft's bubbles.
  reviewChanged?: boolean;
}
export interface TopicMemory {
  // Only the deferred memory-link experiment adds a catalog ID to model recall.
  id?: string;
  key: string;
  tier: 'short' | 'long';
  playerMentions: number;
  recallWeight: number;
  // 1 (small talk) to 10 (identity, relationships, health, major life events); absent in older fixtures.
  importance?: number;
  lastSeenAt: number;
  episodes: {
    summary: string;
    sourceKind: TopicCandidate['sourceKind'];
    messageIds: string[];
    at: number;
    sources?: ContextEvidence[];
    excerpts: { id: string; authorKind: 'player' | 'character'; authorId?: string; text: string; at: number }[];
  }[];
}
export interface ContextEvidence {
  id: string;
  kind: string;
  text: string;
  observedAt: number;
}
export interface ShortTermTurn {
  id: string;
  at: number;
  messages: { id: string; text: string; expression: Expression }[];
}
export interface TextGenerationRequest {
  jobId: string;
  scope: Pick<CharacterScope, 'worldId' | 'conversationId' | 'characterId'>;
  now: number;
  // Earlier failed attempts for these covered inputs, not a character's fictional reason for replying late.
  priorServiceFailure?: boolean;
  relationship: RelationshipPreset;
  sceneContext?: import('./scenes.ts').SceneState;
  relationshipContext?: import('./relationships.ts').RelationshipContext;
  playerIntroduction?: PlayerIntroductionContext;
  // Speech still returns text for review, but each bubble must form a complete spoken unit.
  deliveryMode?: 'text' | 'voice';
  requiredMessageIds: string[];
  character: CharacterTemplate;
  conversation?: ({ kind: 'group' } | { kind: 'moment'; postMessageId: string } | { kind: 'moment_post' }) & {
    name: string;
    members: { id: string; name: string }[];
  };
  messages: MessageDTO[];
  mustClose: boolean;
  // Untrusted source/memory records, never interpolated as developer instructions.
  evidence: ContextEvidence[];
  memories?: TopicMemory[];
  memoryCorrections?: MemoryCorrection[];
  shortTermTurns?: ShortTermTurn[];
  clarifications?: { messageId: string; messages: { id: string; text: string }[] }[];
  // Present only for an authorized proactive job; null key means a fresh topic.
  proactiveTopic?: { key: string | null };
}
export interface TextGenerationResult {
  reply: DialogueCandidate;
  provider: 'deepseek';
  model: string;
  // Provider-reported alias, not a verified immutable model version.
  reportedModel?: string;
  requestId: string | null;
  elapsedMs: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheHitInputTokens?: number;
    cacheMissInputTokens?: number;
  } | null;
  stages?: TextGenerationStage[];
}
export interface TextGenerationStage {
  stage: 'draft' | 'review';
  // Optional only for historical records written before per-stage model selection.
  model?: string;
  reportedModel?: string;
  status: 'succeeded' | 'failed';
  requestId: string | null;
  elapsedMs: number;
  usage: TextGenerationResult['usage'];
  errorCode?: string;
  // Shape/count diagnostics only, never draft text or an untrusted expression string.
  presentation?: BubblePresentationCheck;
}
/** Opt-in accepted-v7 handoff; never included in generic results or safe failure metadata. */
export interface AcceptedV7StageOutput {
  jobId: string;
  requestDigest: string;
  policyHash: string;
  wireRequestHash: string;
  stage: 'draft' | 'review';
  payload: unknown;
  metadata: TextGenerationStage;
}
export interface BubblePresentationCheck {
  bubbleCount: number | null;
  charactersPerBubble: (number | null)[];
  totalCharacters: number | null;
  issues: {
    code:
      | 'not_array'
      | 'bubble_count'
      | 'bubble_shape'
      | 'text_type'
      | 'empty_text'
      | 'text_length'
      | 'line_break'
      | 'control_character'
      | 'expression'
      | 'total_length';
    bubbleIndex?: number;
  }[];
}
export interface TextGenerator extends ProviderDeclaration {
  readonly policyHash?: string;
  readonly textProtocol?: 'accepted-v7';
  generate(request: TextGenerationRequest, signal: AbortSignal, meter?: ProviderMeter): Promise<TextGenerationResult>;
}
export interface AudioRequest {
  jobId: string;
  text: string;
  voiceProfileId: string;
  voiceVersion: number;
  expression: string;
}
export type AudioResult =
  | { jobId: string; status: 'ready'; mediaId: string; mime: string; durationMs: number }
  | { jobId: string; status: 'failed'; code: string };
export interface Clock {
  now(): number;
}
export interface RandomSource {
  next(): number;
}
