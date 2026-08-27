import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    name: {
      type: "string",
      short: "n",
    },
  },
});

const packageNamePattern = /^@ldb\/([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const packageNameMatch = packageNamePattern.exec(values.name ?? "");

if (!packageNameMatch) {
  console.error("사용법: pnpm create-app --name @ldb/api");
  process.exit(1);
}

const packageName = values.name;
const directoryName = packageNameMatch[1];
const appsDirectory = join(import.meta.dirname, "..", "apps");
const appDirectory = join(appsDirectory, directoryName);

await mkdir(appsDirectory, { recursive: true });

try {
  await mkdir(appDirectory);
} catch (error) {
  if (error.code === "EEXIST") {
    console.error(`이미 존재하는 앱입니다: apps/${directoryName}`);
    process.exit(1);
  }

  throw error;
}

await mkdir(join(appDirectory, "src"));

const packageJson = {
  name: packageName,
  version: "0.0.0",
  private: true,
  type: "module",
  scripts: {
    dev: "",
    build: "",
    test: "",
    typecheck: "tsc --noEmit",
    lint: "eslint .",
  },
};

await writeFile(
  join(appDirectory, "package.json"),
  `${JSON.stringify(packageJson, null, 2)}\n`,
);

console.log(`생성 완료: apps/${directoryName}`);
