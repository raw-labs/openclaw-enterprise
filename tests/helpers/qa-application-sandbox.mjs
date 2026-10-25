import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { protectedText, redactedQaTail } from "./qa-secrets.mjs";

/** Execute the regular Agent workflow against explicitly selected native infrastructure. */
export async function verifyQaApplicationSandbox(artifacts, modes) {
  const env = {
    ...process.env,
    OCC_TEST_APPLICATION_SANDBOX_REAL: "1",
    OCC_TEST_APPLICATION_SANDBOX_ENV: process.env.OCC_TEST_QA_APPLICATION_SANDBOX_ENV,
    OCC_TEST_APPLICATION_SANDBOX_MODES: modes.join(","),
    OCC_TEST_OPENAI_MODEL:
      process.env.OCC_TEST_OPENAI_MODEL ??
      process.env.OCC_TEST_QA_OPENAI_MODEL ??
      process.env.OCC_TEST_QA_CODEX_MODEL,
  };
  if (modes.includes("embedded")) {
    env.OPENAI_API_KEY = await protectedText(
      process.env.OCC_TEST_QA_OPENAI_KEY_FILE,
      "OpenAI credential",
    );
  }
  if (modes.includes("dedicated")) {
    env.CODEX_ACCESS_TOKEN = await protectedText(
      process.env.OCC_TEST_QA_CODEX_TOKEN_FILE,
      "Codex credential",
    );
  }
  delete env.NODE_TEST_CONTEXT;
  let output;
  let failed = false;
  try {
    output = await promisify(execFile)(
      process.execPath,
      ["--test", "--test-reporter=tap", "tests/integration/application-sandbox-k3d-real.test.ts"],
      { env, maxBuffer: 64 * 1024 * 1024, timeout: 1800000 },
    );
  } catch (error) {
    output = error;
    failed = true;
  }
  const text = redactedQaTail(`${output.stdout ?? ""}\n${output.stderr ?? ""}`, env, {
    lines: 100000,
    lineChars: 8000,
  }).join("\n");
  const evidence = resolve(artifacts, "application-sandbox-runtime.log");
  await writeFile(evidence, text, { mode: 0o600 });
  assert.equal(failed, false, `Application Sandbox workflow failed; see ${evidence}`);
  assert.match(
    text,
    /ok [0-9]+ - application Sandbox enforces Agent-approved connectivity through the real API and worker/,
  );
  assert.match(text, /# skipped 0\b/);
  return {
    evidence,
    outcome:
      "real Agent admission, worker launch, Gateway remote deny/allow, model turns, native filesystem boundary and cleanup",
  };
}
