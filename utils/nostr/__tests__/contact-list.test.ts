import {
  buildContactListUpdate,
  contactPubkeys,
  latestContactList,
} from "../contact-list";

const sellerA = "a".repeat(64);
const sellerB = "b".repeat(64);

describe("NIP-02 contact list updates", () => {
  it("preserves unrelated contacts and non-contact tags when following", () => {
    const update = buildContactListUpdate(
      [
        ["p", sellerA, "wss://relay.example", "Local farm"],
        ["t", "food"],
        ["r", "wss://relay.example"],
      ],
      sellerB,
      true
    );

    expect(update.kind).toBe(3);
    expect(update.content).toBe("");
    expect(update.tags).toEqual([
      ["p", sellerA, "wss://relay.example", "Local farm"],
      ["t", "food"],
      ["r", "wss://relay.example"],
      ["p", sellerB],
    ]);
  });

  it("only removes the selected seller when unfollowing", () => {
    const update = buildContactListUpdate(
      [
        ["p", sellerA],
        ["p", sellerB, "wss://relay.example"],
        ["t", "food"],
      ],
      sellerB,
      false
    );

    expect(update.tags).toEqual([
      ["p", sellerA],
      ["t", "food"],
    ]);
    expect(contactPubkeys(update.tags)).toEqual([sellerA]);
  });

  it("selects the newest replaceable contact-list event", () => {
    const latest = latestContactList([
      {
        id: "old",
        kind: 3,
        created_at: 1,
        tags: [],
        content: "",
        pubkey: "x",
        sig: "",
      },
      {
        id: "new",
        kind: 3,
        created_at: 2,
        tags: [],
        content: "",
        pubkey: "x",
        sig: "",
      },
    ]);

    expect(latest?.id).toBe("new");
  });

  it("uses the lowest event id when contact lists share a timestamp", () => {
    const latest = latestContactList([
      {
        id: "f".repeat(64),
        kind: 3,
        created_at: 2,
        tags: [["p", sellerA]],
        content: "",
        pubkey: "x",
        sig: "",
      },
      {
        id: "0".repeat(64),
        kind: 3,
        created_at: 2,
        tags: [["p", sellerB]],
        content: "",
        pubkey: "x",
        sig: "",
      },
    ]);

    expect(latest?.id).toBe("0".repeat(64));
    expect(contactPubkeys(latest?.tags ?? [])).toEqual([sellerB]);
  });

  it("timestamps an update after the contact list it replaces", () => {
    const update = buildContactListUpdate([], sellerA, true, 4_000_000_000);

    expect(update.created_at).toBe(4_000_000_001);
  });
});
