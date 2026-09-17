import type { DemoFixtureSpec } from "./types";

/**
 * The canonical CareLoop demo: George, John and Simba.
 *
 * SYNTHETIC DEMO DATA. Nothing in production branches on any name here; this
 * module is imported only by the development-only demo routes and by tests.
 *
 * What the history is built to demonstrate, and why each number is what it is:
 *
 *   - Six visits from John, seven days apart, the most recent 13 days ago.
 *     Through the real baseline engine that is ACTIVE, median 7, MAD 0, and a
 *     derived threshold of 11. The current gap of 13 clears it by two days -
 *     a deliberate margin, so a threshold regression breaks the demo loudly
 *     rather than quietly (the same reasoning as the M3 `cadence-gap` preset).
 *
 *   - Simba is relational memory, NOT a pattern. He has no event series and no
 *     baseline, because nothing observable has been recorded about seeing him
 *     on a rhythm. What CareLoop knows about Simba it knows from confirmed
 *     relationships, which is exactly the distinction the demo should land.
 *
 *   - The episodes are observable statements about what happened. No feelings,
 *     no interpretation, and nothing that reads as a judgement about George.
 */
export const DEMO_GEORGE: DemoFixtureSpec = {
  id: "demo-george.v1",

  profile: {
    displayName: "George",
    // What family see him called. SharePayload.fromDisplayName (docs/04 11.4).
    familyDisplayName: "Dad",
  },

  entities: [
// A recorded alias, kept on purpose. The stronger acceptance case is a
    // person who HAS one: asked about "John", the companion must still say
    // John (or "him"), and may reach for "Johnny" only after George does.
    // Deleting real fixture data to avoid the symptom would have tested a
    // world the product does not live in.
    { key: "john", displayName: "John", type: "person", subtype: null, aliases: ["Johnny"] },
    // `subtype` is freeform and descriptive; nothing branches on it.
    { key: "simba", displayName: "Simba", type: "pet", subtype: "dog" },
  ],

  relationships: [
    // null = the user themself, as the frozen schema specifies.
    { fromKey: null, toKey: "john", kind: "son", labelRaw: "my son", confidence: 0.95 },
    { fromKey: "john", toKey: "simba", kind: "pet", labelRaw: "John's dog", confidence: 0.9 },
    {
      fromKey: null,
      toKey: "simba",
      kind: "family_pet",
      labelRaw: "the family dog",
      confidence: 0.85,
    },
  ],

  eventSeries: [
    {
      entityKey: "john",
      eventType: "visit",
      // Weekly. Most recent 13 days ago -> a live 13-day gap against an
      // 11-day threshold.
      dayOffsets: [48, 41, 34, 27, 20, 13],
      certainty: 0.9,
    },
  ],

  episodes: [
    {
      summary: "John came round with Simba and they sat in the garden.",
      dayOffset: 13,
      precision: "day",
      salience: 0.6,
      entityKeys: ["john", "simba"],
    },
    {
      summary: "John usually comes round at the weekend.",
      dayOffset: 20,
      precision: "week",
      salience: 0.5,
      entityKeys: ["john"],
    },
    {
      // Observable: what happened, not what it means. The fact that Simba is
      // John's dog is a RELATIONSHIP, and lives on the edge, not in prose.
      summary: "Simba came along when John visited and slept by the fire.",
      dayOffset: 27,
      precision: "week",
      salience: 0.5,
      entityKeys: ["john", "simba"],
    },
  ],

  facts: [
    // About the user themself (subject null), and observable.
    { subjectKey: null, key: "occupation_former", value: "retired police officer", confidence: 0.9 },
    { subjectKey: null, key: "living_situation", value: "lives at home", confidence: 0.9 },
    { subjectKey: null, key: "age", value: "87", confidence: 0.9 },
  ],
};
