import type {
  AdapterSessionManagement,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import { agentConfigurationDoc, FALLBACK_MODELS, type } from "../index.js";
import { execute } from "./execute.js";
import { listCopilotLocalModels } from "./models.js";
import { sessionCodec } from "./sessionCodec.js";
import { listCopilotLocalSkills, syncCopilotLocalSkills } from "./skills.js";
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
export { listCopilotLocalModels, isValidGheHost } from "./models.js";
export { detectCopilotLocalModel } from "./detect-model.js";
export {
  listCopilotLocalSkills,
  syncCopilotLocalSkills,
  resolveCopilotLocalDesiredSkillNames,
} from "./skills.js";

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
    models: FALLBACK_MODELS,
    listModels: listCopilotLocalModels,
    listSkills: listCopilotLocalSkills,
    syncSkills: syncCopilotLocalSkills,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    agentConfigurationDoc,
  };
}
