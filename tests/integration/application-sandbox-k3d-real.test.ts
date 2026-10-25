import test from "node:test";
import { verifyApplicationSandboxWorkflow } from "../helpers/application-sandbox-real.mjs";
import { redactQaError } from "../helpers/qa-secrets.mjs";

const selected = process.env.OCC_TEST_APPLICATION_SANDBOX_REAL === "1";

test(
  "application Sandbox enforces Agent-approved connectivity through the real API and worker",
  {
    skip: selected
      ? false
      : "Set OCC_TEST_APPLICATION_SANDBOX_REAL=1 with an owned OpenShell/k3d environment, migrated PostgreSQL, immutable runtime images and real model credentials.",
    timeout: 1_800_000,
  },
  async (context) => {
    try {
      await verifyApplicationSandboxWorkflow(context);
    } catch (error) {
      throw redactQaError(error);
    }
  },
);
