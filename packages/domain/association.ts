import type { RelationshipPreset } from '../contracts/index.ts';
import type { Association } from '../contracts/profile.ts';

// Versioned product tuning, not a claim about how real people feel. No message-count growth.
export function associationBaseline(relationship: RelationshipPreset, association: Association) {
  const base = { new: [10, 5], friend: [35, 40], close_friend: [65, 70], lover: [70, 75] }[relationship]!;
  const offset = { online_stranger: [0, 0], classmate: [2, 12], friend: [5, 10], fan: [0, 1],
    intrusive_fan: [-8, 0], staff: [0, 8], boss: [0, 6], patron: [0, 4] }[association]!;
  return { initialTrust: Math.max(0, Math.min(100, base[0]! + offset[0]!)),
    initialFamiliarity: Math.max(0, Math.min(100, base[1]! + offset[1]!)), policyVersion: 1 as const };
}
