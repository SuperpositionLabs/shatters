import { describe, expect, it } from "vitest";

import {
  GroupError,
  type GroupState,
  type MembershipChange,
  applyMembershipChange,
  applyRename,
  createGroup,
  currentMembers,
  isMember,
  mergeGroups,
  nextTimestamp,
} from "./state";

const alice = "alice";
const bob = "bob";
const carol = "carol";

function group(): GroupState {
  return createGroup("g1", "Team", alice, [bob], 1000);
}

/** Applies changes in the given order, from a fresh group each time. */
function applyAll(base: GroupState, changes: MembershipChange[]): GroupState {
  return changes.reduce(applyMembershipChange, base);
}

/** Every ordering of the input, for convergence checks. */
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  );
}

describe("createGroup", () => {
  it("includes the creator and the named members", () => {
    expect(currentMembers(group())).toEqual([alice, bob]);
  });

  it("always includes the creator", () => {
    // A group nobody belongs to has no one to converge it.
    const state = createGroup("g1", "Solo", alice, [], 1000);
    expect(isMember(state, alice)).toBe(true);
  });

  it("does not duplicate a creator listed as a member", () => {
    const state = createGroup("g1", "Team", alice, [alice, bob], 1000);
    expect(currentMembers(state)).toEqual([alice, bob]);
  });

  it("requires an id", () => {
    expect(() => createGroup("", "Team", alice, [], 1)).toThrow(GroupError);
  });
});

describe("membership convergence", () => {
  it("adds and removes members", () => {
    let state = group();
    state = applyMembershipChange(state, {
      accountId: carol,
      added: true,
      timestamp: 2000,
      by: alice,
    });
    expect(currentMembers(state)).toEqual([alice, bob, carol]);

    state = applyMembershipChange(state, {
      accountId: bob,
      added: false,
      timestamp: 3000,
      by: alice,
    });
    expect(currentMembers(state)).toEqual([alice, carol]);
  });

  it("converges regardless of the order changes arrive in", () => {
    const changes: MembershipChange[] = [
      { accountId: carol, added: true, timestamp: 2000, by: alice },
      { accountId: bob, added: false, timestamp: 3000, by: alice },
      { accountId: bob, added: true, timestamp: 4000, by: carol },
      { accountId: carol, added: false, timestamp: 5000, by: bob },
    ];

    // A member offline for two changes must converge on rejoining without
    // replaying them in order.
    const results = permutations(changes).map((order) =>
      currentMembers(applyAll(group(), order)),
    );

    for (const result of results) {
      expect(result).toEqual(results[0]);
    }
    expect(results[0]).toEqual([alice, bob]);
  });

  it("is idempotent", () => {
    const change: MembershipChange = {
      accountId: carol,
      added: true,
      timestamp: 2000,
      by: alice,
    };

    // A redelivered envelope must not change the answer.
    const once = applyMembershipChange(group(), change);
    const twice = applyMembershipChange(once, change);
    expect(currentMembers(twice)).toEqual(currentMembers(once));
  });

  it("ignores a change older than what it already knows", () => {
    let state = applyMembershipChange(group(), {
      accountId: bob,
      added: false,
      timestamp: 5000,
      by: alice,
    });
    // A late-arriving stale add must not resurrect a removed member.
    state = applyMembershipChange(state, {
      accountId: bob,
      added: true,
      timestamp: 2000,
      by: carol,
    });

    expect(isMember(state, bob)).toBe(false);
  });

  it("breaks an exact tie the same way on every device", () => {
    // Two devices can genuinely stamp the same millisecond, and "whichever
    // arrived first" is not a rule everyone can agree on.
    const add: MembershipChange = {
      accountId: carol,
      added: true,
      timestamp: 2000,
      by: "zoe",
    };
    const remove: MembershipChange = {
      accountId: carol,
      added: false,
      timestamp: 2000,
      by: "adam",
    };

    const forwards = applyAll(group(), [add, remove]);
    const backwards = applyAll(group(), [remove, add]);
    expect(isMember(forwards, carol)).toBe(isMember(backwards, carol));
  });

  it("lets a removed member be added back", () => {
    let state = applyMembershipChange(group(), {
      accountId: bob,
      added: false,
      timestamp: 2000,
      by: alice,
    });
    state = applyMembershipChange(state, {
      accountId: bob,
      added: true,
      timestamp: 3000,
      by: alice,
    });

    expect(isMember(state, bob)).toBe(true);
  });

  it("orders members identically everywhere", () => {
    const state = applyAll(group(), [
      { accountId: carol, added: true, timestamp: 2000, by: alice },
      { accountId: "aaron", added: true, timestamp: 2001, by: alice },
    ]);

    // Insertion order differs between members; the rendered list must not.
    expect(currentMembers(state)).toEqual(["aaron", alice, bob, carol]);
  });

  it("reports a never-seen account as not a member", () => {
    expect(isMember(group(), "stranger")).toBe(false);
  });
});

describe("rename", () => {
  it("takes the most recent name", () => {
    const state = applyRename(group(), "Renamed", 2000, bob);
    expect(state.name).toBe("Renamed");
  });

  it("ignores a stale rename", () => {
    const state = applyRename(group(), "Old", 500, bob);
    expect(state.name).toBe("Team");
  });

  it("breaks a tie deterministically", () => {
    const a = applyRename(group(), "From Zoe", 1000, "zoe");
    const b = applyRename(group(), "From Adam", 1000, "adam");
    // Both start from the same state stamped 1000 by alice.
    expect(a.name).not.toBe(b.name);
    expect(a.name).toBe("From Zoe");
    expect(b.name).toBe("Team");
  });
});

describe("mergeGroups", () => {
  it("converges two divergent views", () => {
    const base = group();

    const local = applyMembershipChange(base, {
      accountId: carol,
      added: true,
      timestamp: 2000,
      by: alice,
    });
    const remote = applyRename(
      applyMembershipChange(base, {
        accountId: bob,
        added: false,
        timestamp: 3000,
        by: bob,
      }),
      "Renamed",
      4000,
      bob,
    );

    const merged = mergeGroups(local, remote);
    expect(currentMembers(merged)).toEqual([alice, carol]);
    expect(merged.name).toBe("Renamed");
  });

  it("is commutative", () => {
    const base = group();
    const local = applyMembershipChange(base, {
      accountId: carol,
      added: true,
      timestamp: 2000,
      by: alice,
    });
    const remote = applyMembershipChange(base, {
      accountId: bob,
      added: false,
      timestamp: 3000,
      by: bob,
    });

    // Merging must not depend on which side initiated it.
    expect(currentMembers(mergeGroups(local, remote))).toEqual(
      currentMembers(mergeGroups(remote, local)),
    );
  });

  it("keeps the earliest creation time", () => {
    const early = { ...group(), createdAt: 500 };
    const late = { ...group(), createdAt: 9000 };

    // A peer that learned of the group later must not overwrite its origin.
    expect(mergeGroups(late, early).createdAt).toBe(500);
    expect(mergeGroups(early, late).createdAt).toBe(500);
  });

  it("refuses to merge different groups", () => {
    const other = createGroup("g2", "Other", bob, [], 1000);
    expect(() => mergeGroups(group(), other)).toThrow(/different groups/);
  });

  it("is idempotent", () => {
    const state = applyMembershipChange(group(), {
      accountId: carol,
      added: true,
      timestamp: 2000,
      by: alice,
    });
    expect(mergeGroups(state, state)).toEqual(state);
  });
});

describe("nextTimestamp", () => {
  it("uses the local clock when it is already ahead", () => {
    expect(nextTimestamp(group(), 5000)).toBe(5000);
  });

  it("steps past the newest change when the local clock lags", () => {
    const state = applyMembershipChange(group(), {
      accountId: carol,
      added: true,
      timestamp: 9000,
      by: alice,
    });

    // A member whose clock lags would otherwise lose every edit, permanently
    // and with no feedback explaining why.
    expect(nextTimestamp(state, 500)).toBe(9001);
  });

  it("lets a lagging member's change actually take effect", () => {
    const state = applyRename(group(), "Named by a fast device", 9000, bob);

    const stamped = nextTimestamp(state, 100);
    const renamed = applyRename(state, "Named by a slow device", stamped, carol);

    expect(renamed.name).toBe("Named by a slow device");
  });

  it("accounts for every field, not just the newest member change", () => {
    const state = applyRename(group(), "Renamed", 8000, bob);
    expect(nextTimestamp(state, 100)).toBe(8001);
  });
});
