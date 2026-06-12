import "./styles.css";
import { installAssetReloadRecovery, isStaleAssetImportError } from "./ui/asset-reload.ts";

installAssetReloadRecovery();

void import("./ui/app.ts").catch((err: unknown) => {
  if (!isStaleAssetImportError(err)) {
    throw err;
  }
});
