import { TABLES } from "./rows.js";
/** Only one run of a proposal at a time (two devices, a double click): the ids being applied now. */
const applying = new Set();
export async function applyProposal(db, id, run, skip = false) {
  if (applying.has(id)) throw new Error("That proposal is being applied already");
  applying.add(id);
  try {
    const [row] = await db.select(TABLES.proposals, { id });
    if (!row) throw new Error("That proposal is gone (accepted or declined already?)");
    const changes = row.changes.map((c) => ({ ...c }));
    const save = () => db.update(TABLES.proposals, { id }, { changes });
    for (const [i, change] of changes.entries()) {
      if (change.done || change.skipped) continue;
      if (skip && change.error) {
        change.skipped = true;
        skip = false;
        continue;
      }
      try {
        await run(change);
      } catch (error) {
        change.error = error instanceof Error ? error.message : String(error);
        await save();
        const done = changes.filter((c) => c.done).length;
        const where = changes.length > 1 ? `${done} of ${changes.length} done; stopped at ${i + 1}: ` : "";
        throw new Error(`${where}${change.error}`);
      }
      change.done = true;
      delete change.error;
      // Saved after each, so a host that stops halfway doesn't do them again.
      if (i < changes.length - 1) await save();
    }
    await db.delete(TABLES.proposals, { id });
  } finally {
    applying.delete(id);
  }
}
