import { randomBytes } from "node:crypto";
import { seedToString } from "../../engine/core/rng";

export function randomSeed(): string {
  return seedToString(randomBytes(8).readBigUInt64BE());
}
