/** Part 31: the owner's operations: the home arc order, deleting test records, and closed accounts' chats. */
export type ArcCharacter = { characterId: string; name: string; color: string | null; position: number };
export type ClosedAccounts = { policy: 'retention' | 'immediate'; rows: { playerNumber: string; closedOn: string }[] };
export type DeleteTarget = { characterId: string; code: string; archived: boolean };

const invalid = () => new Error('ADMIN_OWNER_PROTOCOL_INVALID');
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid();
  return v as Record<string, unknown>;
};
const string = (v: unknown) => {
  if (typeof v !== 'string') throw invalid();
  return v;
};
const count = (v: unknown) => {
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw invalid();
  return v as number;
};
const array = (v: unknown) => {
  if (!Array.isArray(v)) throw invalid();
  return v as unknown[];
};
const arc = (v: unknown): ArcCharacter[] =>
  array(object(v).characters).map((c) => {
    const o = object(c);
    return {
      characterId: string(o.characterId),
      name: string(o.name),
      color: o.color === null ? null : string(o.color),
      position: count(o.position),
    };
  });
const closed = (v: unknown): ClosedAccounts => {
  const r = object(v);
  if (r.policy !== 'retention' && r.policy !== 'immediate') throw invalid();
  return {
    policy: r.policy,
    rows: array(r.rows).map((row) => {
      const o = object(row);
      return { playerNumber: string(o.playerNumber), closedOn: string(o.closedOn) };
    }),
  };
};

export class OwnerAdminClient {
  private readonly call: (path: string, body: Record<string, unknown>) => Promise<unknown>;
  private readonly id: () => string;
  constructor(
    call: (path: string, body: Record<string, unknown>) => Promise<unknown>,
    id: () => string = () => globalThis.crypto.randomUUID(),
  ) {
    this.call = call;
    this.id = id;
  }
  async arcRead() {
    return arc(await this.call('arc-read', {}));
  }
  /** `ids` = every character on the arc, in the order they should have. */
  async arcSave(ids: readonly string[]) {
    return arc(await this.call('arc-save', { requestId: this.id(), ids }));
  }
  async deletePreviews(input: { runIds: readonly string[]; previewIds: readonly string[] }) {
    const r = object(await this.call('previews-delete', { requestId: this.id(), ...input }));
    return { previews: count(r.previews), runs: count(r.runs) };
  }
  async deleteConversations(items: readonly DeleteTarget[]) {
    const r = object(await this.call('conversations-delete', { requestId: this.id(), items }));
    return { deleted: count(r.deleted), skipped: count(r.skipped) };
  }
  async closedRead() {
    return closed(await this.call('closed-read', {}));
  }
  async closedPolicy(policy: 'retention' | 'immediate') {
    return closed(await this.call('closed-policy', { requestId: this.id(), policy }));
  }
  async closedDelete(playerNumber: string) {
    const r = object(await this.call('closed-delete', { requestId: this.id(), playerNumber }));
    return { accounts: count(r.accounts), lines: count(r.lines) };
  }
}
