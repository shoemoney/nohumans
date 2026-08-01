/**
 * PRD 5.5 — enable/disable/show scheduled publishing. Requires >=1 successful manual publish.
 * @param {string[]} args positionals after the command name
 * @param {import("../cli.js").Ctx} ctx
 * @returns {Promise<number>|number} process exit code (0 = ok)
 */
export async function run(args, ctx) {
  throw new Error("not implemented: autopublish");
}
