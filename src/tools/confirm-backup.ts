import { updateRuntimeStateFile } from "../daemon/runtime-state-file";
import { parseRuntimeState } from "../state";

export async function confirm_backup(
  options: {
    readonly stateFilePath?: string;
  } = {},
): Promise<{
  readonly confirmed: true;
  readonly walletAddress: string;
  readonly backupStatus: "confirmed";
  readonly message: string;
}> {
  const now = new Date().toISOString();
  const updater = (current: Awaited<ReturnType<typeof updateRuntimeStateFile>>) => {
    if (current.walletBackup.status !== "pending") {
      throw new Error(
        current.walletBackup.status === "confirmed"
          ? "Backup has already been confirmed."
          : `Unexpected backup status: ${current.walletBackup.status}`,
      );
    }

    if (current.walletBackup.mnemonicDisplayedAt === null) {
      throw new Error("Cannot confirm backup before the mnemonic has been displayed.");
    }

    return parseRuntimeState({
      ...current,
      walletBackup: {
        ...current.walletBackup,
        status: "confirmed",
        confirmedAt: now,
      },
    });
  };

  const updatedState =
    options.stateFilePath === undefined
      ? await updateRuntimeStateFile(updater)
      : await updateRuntimeStateFile(options.stateFilePath, updater);

  return {
    confirmed: true,
    walletAddress: updatedState.wallet.address,
    backupStatus: "confirmed",
    message: "Backup confirmed. The mnemonic will not be displayed again via create_wallet.",
  };
}
