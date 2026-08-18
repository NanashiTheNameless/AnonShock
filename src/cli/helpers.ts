export { closeStore, isPaused, openStore, setPaused } from "../store/db.ts";
import { countLinks } from "../store/queries.ts";

export function countLinksSafe(): number {
  try {
    return countLinks();
  } catch {
    return 0;
  }
}
