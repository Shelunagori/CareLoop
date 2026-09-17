/**
 * The shape of a demo fixture.
 *
 * DATA, not behaviour. The seeder in `server/services/demo-fixture.ts` is
 * driven entirely by one of these and contains no name, no offset and no
 * relationship kind of its own - which is the whole point. "George", "John"
 * and "Simba" are a fixture; they are not a code path, and production policy
 * stays entity-id based and generic (this milestone's section 1).
 *
 * Offsets are DAYS BEFORE the fixture's anchor `now`, never absolute dates, so
 * the same fixture produces the same baseline whenever it is run.
 */
export type EntityType = "person" | "pet" | "place" | "org";
/**
 * Narrower than the database enum on purpose: V1 extracts `visit` and `call`,
 * and those are the two the cadence engine keeps a series for. A fixture that
 * could name an event type the baseline engine will not accept is a fixture
 * that compiles and then fails at run time.
 */
export type SeriesEventType = "visit" | "call";

export type DemoEntitySpec = {
  /** Stable within the fixture; how relationships and events refer to it. */
  key: string;
  displayName: string;
  type: EntityType;
  subtype: string | null;
  aliases?: readonly string[];
};

export type DemoRelationshipSpec = {
  /** null = the user themself, exactly as the frozen schema means it. */
  fromKey: string | null;
  toKey: string;
  kind: string;
  labelRaw: string;
  confidence: number;
};

export type DemoEventSeriesSpec = {
  entityKey: string;
  eventType: SeriesEventType;
  /** Days before the anchor. One positive event each. */
  dayOffsets: readonly number[];
  certainty: number;
};

export type DemoEpisodeSpec = {
  summary: string;
  dayOffset: number;
  precision: "exact" | "day" | "week" | "unknown";
  salience: number;
  entityKeys: readonly string[];
};

export type DemoFactSpec = {
  /** null = a fact about the user themself. */
  subjectKey: string | null;
  key: string;
  value: string;
  confidence: number;
};

export type DemoFixtureSpec = {
  /** Namespaces every ingest fingerprint this fixture writes. */
  id: string;
  profile: { displayName: string; familyDisplayName: string };
  entities: readonly DemoEntitySpec[];
  relationships: readonly DemoRelationshipSpec[];
  eventSeries: readonly DemoEventSeriesSpec[];
  episodes: readonly DemoEpisodeSpec[];
  facts: readonly DemoFactSpec[];
};
