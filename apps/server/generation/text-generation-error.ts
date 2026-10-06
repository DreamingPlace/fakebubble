import type { TextGenerationResult } from '../../../packages/contracts/index.ts';
import { DomainError } from '../../../packages/domain/errors.ts';

/** Safe provider metadata only; never carries the response body, reasoning or credentials. */
export class TextGenerationFailure extends DomainError {
  readonly generation: Omit<TextGenerationResult, 'reply'>;
  constructor(code: string, generation: Omit<TextGenerationResult, 'reply'>) {
    super(code);
    this.generation = generation;
  }
}
