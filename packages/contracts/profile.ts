export const ASSOCIATIONS = [
  'online_stranger',
  'classmate',
  'friend',
  'fan',
  'intrusive_fan',
  'staff',
  'boss',
  'patron',
] as const;
export type Association = (typeof ASSOCIATIONS)[number];

/** A player-authored fictional-world identity, not verified real-world personal data. */
export interface PlayerProfile {
  name: string;
  age: number | null;
  city: string;
  occupation: string;
  familyBackground: string;
  sharedCharacterIds: string[];
}
export interface PlayerProfileState {
  revision: number;
  profile: PlayerProfile;
  updatedAt: number;
}
export interface AssociationSelection {
  characterId: string;
  association: Association;
}
export interface CharacterAssociation {
  association: Association;
  revision: number;
  initialTrust: number;
  initialFamiliarity: number;
  policyVersion: 1;
}
export interface SavePlayerProfileInput {
  requestId: string;
  expectedRevision: number;
  profile: PlayerProfile;
  /** Only used to complete missing associations on legacy worlds; never overwrites an established one. */
  associations?: AssociationSelection[];
}
export interface PlayerProfileReceipt {
  worldId: string;
  revision: number;
  updatedAt: number;
  duplicate: boolean;
}
export interface PlayerIntroductionContext {
  source: 'player_setup';
  revision: number;
  name: string | null;
  age: number | null;
  details?: { city: string; occupation: string; familyBackground: string };
  association?: CharacterAssociation;
}
