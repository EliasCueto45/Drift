// Compare content, including staged changes, without Unix shell commands.
import { execFileSync } from "node:child_process";
const paths = ["packages/contracts", "fixtures"];
execFileSync("git", ["diff", "--exit-code", "HEAD", "--", ...paths], { stdio: "inherit" });
const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", ...paths], { encoding: "utf8" });
if (untracked.trim()) {
  console.error(`Untracked generated files:\n${untracked}`);
  process.exit(1);
}
