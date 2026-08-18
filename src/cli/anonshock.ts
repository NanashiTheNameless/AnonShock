import { unlinkSync } from "node:fs";
import { config } from "../config.ts";
import { closeStore, countLinksSafe, isPaused, openStore, setPaused } from "./helpers.ts";

/**
 * Host control. Three powers, deliberately global and blunt: pause and resume
 * the instance, delete every link, wipe the store. There is no command to list,
 * inspect, or modify an individual link, because an interface that enumerates
 * links is an interface that deanonymizes their creators.
 */

const USAGE = `anonshock - host control for this instance

  anonshock status                      is the instance paused, and how many links exist
  anonshock pause                       freeze the instance; Stop is still delivered
  anonshock resume                      unfreeze
  anonshock purge-links --yes-i-mean-it delete every link and holder on this instance
  anonshock nuke --yes-i-mean-it        delete the store file entirely

There is no command to list, view, or disable one link. That is not an omission.
`;

function out(line: string): void {
  process.stdout.write(line + "\n");
}

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  const confirmed = argv.includes("--yes-i-mean-it");

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    out(USAGE);
    return 0;
  }

  if (cmd === "nuke") {
    if (!confirmed) {
      out("This deletes the entire store, including every link on this instance.");
      out("Re-run with --yes-i-mean-it to proceed.");
      return 1;
    }
    // Stop everything we can reach before the store goes away.
    openStore();
    const { killAllRooms } = await import("../core/rooms.ts");
    await killAllRooms();
    closeStore();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(config.dbPath + suffix);
      } catch {
        // absent is fine
      }
    }
    openStore();
    closeStore();
    out("store wiped and recreated empty");
    return 0;
  }

  openStore();
  try {
    switch (cmd) {
      case "status": {
        out(`paused: ${isPaused() ? "yes" : "no"}`);
        out(`links: ${countLinksSafe()}`);
        return 0;
      }
      case "pause": {
        setPaused(true);
        out("instance paused; Stop commands are still delivered");
        return 0;
      }
      case "resume": {
        setPaused(false);
        out("instance resumed");
        return 0;
      }
      case "purge-links": {
        const count = countLinksSafe();
        if (!confirmed) {
          out(`This deletes all ${count} link(s) on this instance, for everyone.`);
          out("Re-run with --yes-i-mean-it to proceed.");
          return 1;
        }
        const { killAllRooms, disposeAllRooms } = await import("../core/rooms.ts");
        await killAllRooms();
        disposeAllRooms();
        const { deleteAllLinks } = await import("../store/queries.ts");
        const deleted = deleteAllLinks();
        out(`deleted ${deleted} link(s)`);
        return 0;
      }
      default: {
        out(`unknown command: ${cmd}`);
        out(USAGE);
        return 1;
      }
    }
  } finally {
    closeStore();
  }
}

const code = await main(process.argv.slice(2));
process.exit(code);
