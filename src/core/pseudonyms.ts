import { randomInt } from "node:crypto";

const ADJECTIVES = [
  "Curious", "Quiet", "Patient", "Restless", "Careful", "Idle", "Bright", "Distant",
  "Gentle", "Steady", "Clever", "Drowsy", "Polite", "Wandering", "Cheerful", "Solemn",
  "Nimble", "Amber", "Velvet", "Copper", "Silent", "Wistful", "Brisk", "Mellow",
];

const NOUNS = [
  "Otter", "Fern", "Heron", "Moth", "Willow", "Sparrow", "Pebble", "Lantern",
  "Comet", "Thistle", "Badger", "Marten", "Cedar", "Finch", "Harbor", "Meadow",
  "Puffin", "Quartz", "Raven", "Sable", "Tulip", "Vixen", "Wren", "Yarrow",
];

/**
 * Per session, per link. Never derived from the IP, the session id, the user
 * agent, or anything else observable, so two links cannot be correlated
 * through a pseudonym.
 */
export function newPseudonym(taken?: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 24; attempt++) {
    const name = `${ADJECTIVES[randomInt(ADJECTIVES.length)]} ${NOUNS[randomInt(NOUNS.length)]}`;
    if (!taken || !taken.has(name)) return name;
  }
  return `${ADJECTIVES[randomInt(ADJECTIVES.length)]} ${NOUNS[randomInt(NOUNS.length)]} ${randomInt(
    10,
    100,
  )}`;
}
