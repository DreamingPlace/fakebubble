/**
 * Part 37a: 回复写法. 'v7' is 旧 (the writer of every reply before Part 37a), 'v8' is 新 (the plain-text writer).
 * Part 37b: 'v8p' is 新+档案: 新 plus the character's own 核心卡 and examples (the 多轮预演 column's path: same pins, same policy hash).
 */
export type WriterLine = 'v7' | 'v8';
export type WriterChoice = WriterLine | 'v8p';
export const WRITER_CHOICES: readonly WriterChoice[] = ['v7', 'v8', 'v8p'];
export const isWriterChoice = (value: unknown): value is WriterChoice =>
  value === 'v7' || value === 'v8' || value === 'v8p';
export interface WriterSettingView {
  writer: WriterChoice;
  /** Whether the game's data lets the console change it (false on a database without the table). */
  available: boolean;
}
export interface WriterSaveResult extends WriterSettingView {
  duplicate: boolean;
}
