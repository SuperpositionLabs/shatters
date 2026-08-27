/**
 * Group membership state.
 *
 * There is no server to arbitrate, so every member must reach the same
 * membership list from the same set of changes, whatever order they arrive in.
 * That rules out anything sequence-numbered: a member who was offline for two
 * changes must converge on rejoining without replaying them in order.
 *
 * Membership is therefore a last-writer-wins element set. Each account carries
 * the time it was last added and last removed; it is a member when the add is
 * more recent. Both operations commute and are idempotent, so any order of any
 * subset converges to the same answer.
 *
 * Pure and free of I/O, so the convergence rules can be tested directly.
 */

export class GroupError extends Error {}

/** A single account's add/remove history within a group. */
export interface MemberRecord {
  /** Milliseconds since the epoch; 0 means never. */
  addedAt: number;
  removedAt: number;
  /** Author of the most recent change, used only to break exact ties. */
  addedBy?: string;
  removedBy?: string;
}

export interface GroupState {
  id: string;
  name: string;
  nameUpdatedAt: number;
  /** Author of the current name, used only to break exact ties. */
  nameUpdatedBy?: string;
  createdBy: string;
  createdAt: number;
  members: Record<string, MemberRecord>;
}

export interface MembershipChange {
  accountId: string;
  /** Adding or removing. */
  added: boolean;
  timestamp: number;
  by: string;
}

/**
 * Breaks an exact timestamp tie deterministically.
 *
 * Two devices can genuinely stamp the same millisecond, and "whichever arrived
 * first" is not a rule every member can agree on. Comparing the author id is
 * arbitrary but identical everywhere, which is the only property that matters.
 */
function wins(
  candidateAt: number,
  candidateBy: string | undefined,
  currentAt: number,
  currentBy: string | undefined,
): boolean {
  if (candidateAt !== currentAt) return candidateAt > currentAt;
  return (candidateBy ?? "") > (currentBy ?? "");
}

/**
 * The most recent timestamp anywhere in a group's state.
 *
 * Used to keep authored changes causally ordered - see `nextTimestamp`.
 */
export function latestTimestamp(state: GroupState): number {
  let latest = Math.max(state.nameUpdatedAt, state.createdAt);
  for (const record of Object.values(state.members)) {
    latest = Math.max(latest, record.addedAt, record.removedAt);
  }
  return latest;
}

/**
 * The timestamp to stamp a new change with.
 *
 * Wall clocks on two devices are not comparable, and last-writer-wins compares
 * them directly. A member whose clock lags behind the group's latest change
 * would lose every edit they made - not once, but permanently, with no
 * feedback explaining why.
 *
 * So a change is stamped one past the newest thing its author has already
 * seen, whenever that is ahead of the local clock. A change therefore always
 * supersedes the state it was made against, which is the property that matters,
 * while staying close to real time when clocks agree.
 */
export function nextTimestamp(state: GroupState, now: number): number {
  return Math.max(now, latestTimestamp(state) + 1);
}

/** Creates a group. The id must be random, never derived from membership. */
export function createGroup(
  id: string,
  name: string,
  createdBy: string,
  members: string[],
  timestamp: number,
): GroupState {
  if (!id) throw new GroupError("group id is required");

  const state: GroupState = {
    id,
    name,
    nameUpdatedAt: timestamp,
    nameUpdatedBy: createdBy,
    createdBy,
    createdAt: timestamp,
    members: {},
  };

  // The creator is a member by construction; a group nobody belongs to has no
  // one to converge it.
  for (const accountId of new Set([createdBy, ...members])) {
    state.members[accountId] = {
      addedAt: timestamp,
      removedAt: 0,
      addedBy: createdBy,
    };
  }
  return state;
}

/** Applies one membership change, returning the converged state. */
export function applyMembershipChange(
  state: GroupState,
  change: MembershipChange,
): GroupState {
  const existing = state.members[change.accountId] ?? {
    addedAt: 0,
    removedAt: 0,
  };

  const updated: MemberRecord = { ...existing };
  if (change.added) {
    if (wins(change.timestamp, change.by, existing.addedAt, existing.addedBy)) {
      updated.addedAt = change.timestamp;
      updated.addedBy = change.by;
    }
  } else if (
    wins(change.timestamp, change.by, existing.removedAt, existing.removedBy)
  ) {
    updated.removedAt = change.timestamp;
    updated.removedBy = change.by;
  }

  return {
    ...state,
    members: { ...state.members, [change.accountId]: updated },
  };
}

/** Applies a rename, last writer wins. */
export function applyRename(
  state: GroupState,
  name: string,
  timestamp: number,
  by: string,
): GroupState {
  if (!wins(timestamp, by, state.nameUpdatedAt, state.nameUpdatedBy)) {
    return state;
  }
  return { ...state, name, nameUpdatedAt: timestamp, nameUpdatedBy: by };
}

/** Accounts currently in the group, sorted so every member sees one order. */
export function currentMembers(state: GroupState): string[] {
  return Object.entries(state.members)
    .filter(([, record]) => record.addedAt > record.removedAt)
    .map(([accountId]) => accountId)
    .sort();
}

export function isMember(state: GroupState, accountId: string): boolean {
  const record = state.members[accountId];
  return record !== undefined && record.addedAt > record.removedAt;
}

/**
 * Merges a peer's view of a group into the local one.
 *
 * Needed when a member rejoins after missing changes: rather than replaying
 * history, both sides exchange state and merge. Because every field is
 * last-writer-wins, merging is just the pairwise maximum.
 */
export function mergeGroups(local: GroupState, remote: GroupState): GroupState {
  if (local.id !== remote.id) {
    throw new GroupError("cannot merge different groups");
  }

  const members: Record<string, MemberRecord> = { ...local.members };
  for (const [accountId, remoteRecord] of Object.entries(remote.members)) {
    const localRecord = members[accountId] ?? { addedAt: 0, removedAt: 0 };
    members[accountId] = {
      addedAt: Math.max(localRecord.addedAt, remoteRecord.addedAt),
      addedBy:
        remoteRecord.addedAt > localRecord.addedAt
          ? remoteRecord.addedBy
          : localRecord.addedBy,
      removedAt: Math.max(localRecord.removedAt, remoteRecord.removedAt),
      removedBy:
        remoteRecord.removedAt > localRecord.removedAt
          ? remoteRecord.removedBy
          : localRecord.removedBy,
    };
  }

  const renamed = wins(
    remote.nameUpdatedAt,
    remote.nameUpdatedBy,
    local.nameUpdatedAt,
    local.nameUpdatedBy,
  );

  return {
    ...local,
    name: renamed ? remote.name : local.name,
    nameUpdatedAt: Math.max(local.nameUpdatedAt, remote.nameUpdatedAt),
    nameUpdatedBy: renamed ? remote.nameUpdatedBy : local.nameUpdatedBy,
    // The earliest creation wins: a peer that learned of the group later must
    // not overwrite its origin.
    createdAt: Math.min(local.createdAt, remote.createdAt),
    members,
  };
}
