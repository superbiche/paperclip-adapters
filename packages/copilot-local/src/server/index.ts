import type {
  AdapterSessionManagement,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import { agentConfigurationDoc, models, type } from "../index.js";
import { execute } from "./execute.js";
import { sessionCodec } from "./sessionCodec.js";
import { testEnvironment } from "./test.js";

export { execute } from "./execute.js";
export {
  parseCopilotJsonl,
  describeCopilotFailure,
  isCopilotUnknownSessionError,
  detectCopilotAuthRequired,
} from "./parse.js";
export { sessionCodec } from "./sessionCodec.js";
export { testEnvironment } from "./test.js";
export {
  resolveCopilotToken,
  validateCopilotToken,
  isCopilotAuthError,
  buildCopilotHeaders,
  discoverCopilotApiUrl,
  type CopilotTokenResult,
} from "./auth.js";
export {
  fetchWithRetry,
  type FetchRetryOptions,
} from "./fetch-with-retry.js";

export const sessionManagement: AdapterSessionManagement = {
  supportsSessionResume: true,
  nativeContextManagement: "confirmed",
  defaultSessionCompaction: {
    enabled: true,
    maxSessionRuns: 40,
    maxRawInputTokens: 400_000,
    maxSessionAgeHours: 48,
  },
};

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    sessionCodec,
    sessionManagement,
    models,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    agentConfigurationDoc,
  };
}
