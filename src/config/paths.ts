import { homedir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "./constants";

export const RUNTIME_DIRECTORY = `${REPO_ROOT}/runtime` as const;
export const STATE_FILE_PATH = `${RUNTIME_DIRECTORY}/state.json` as const;
export const AGENT_MD_CACHE_FILE_PATH = `${RUNTIME_DIRECTORY}/agent-md-cache.json` as const;
export const AUDIT_LOG_FILE_PATH = `${RUNTIME_DIRECTORY}/audit.log` as const;
export const DAEMON_PID_FILE_PATH = `${RUNTIME_DIRECTORY}/daemon.pid` as const;

export const DESKTOP_DIRECTORY = join(homedir(), "Desktop");
export const MNEMONIC_FILE_NAME = "openclaw-v4t-wallet-mnemonic.txt" as const;
export const MNEMONIC_FILE_PATH = join(DESKTOP_DIRECTORY, MNEMONIC_FILE_NAME);
export const MNEMONIC_FILE_MODE = 0o600 as const;

export const RUNTIME_PATHS = Object.freeze({
  state: STATE_FILE_PATH,
  agentMdCache: AGENT_MD_CACHE_FILE_PATH,
  auditLog: AUDIT_LOG_FILE_PATH,
  daemonPid: DAEMON_PID_FILE_PATH,
  mnemonicFile: MNEMONIC_FILE_PATH,
});
