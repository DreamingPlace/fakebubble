/** Part 37a: 回复写法. 'v7' is 现行 (the writer of every reply before Part 37a), 'v8' is 新 (the plain-text writer). */
export type WriterChoice = 'v7' | 'v8';
export const WRITER_CHOICES: readonly WriterChoice[] = ['v7', 'v8'];
export const isWriterChoice = (value: unknown): value is WriterChoice => value === 'v7' || value === 'v8';
export interface WriterSettingView {
  writer: WriterChoice;
  /** Whether the game's data lets the console change it (false on a database without the table). */
  available: boolean;
}
export interface WriterSaveResult extends WriterSettingView {
  duplicate: boolean;
}
