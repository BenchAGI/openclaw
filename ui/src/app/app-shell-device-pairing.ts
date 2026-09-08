import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";
import type { ShellViewHost } from "./app-shell-view.ts";

type DevicePairSetupModule = typeof import("../pages/devices/view-pairing.runtime.ts");
type DevicePairSetupProps = Parameters<DevicePairSetupModule["renderDevicePairSetup"]>[0];

// Keep pairing out of the startup chunk while the eager shell stays dismissible during loading.
export function renderLazyDevicePairSetup(host: ShellViewHost, props: DevicePairSetupProps) {
  if (!props.open) {
    return nothing;
  }
  const renderer = host.devicePairSetupRenderer;
  if (renderer) {
    return renderer(props);
  }
  const failed = host.devicePairSetupLoadFailed;
  if (!failed) {
    host.loadDevicePairSetupRenderer();
  }
  // Loading and failure share the eager modal; a failed chunk remains dismissible and retryable.
  const title = t("devices.pairing.title");
  const message = t(failed ? "devices.pairing.loadFailed" : "common.loading");
  return html`<openclaw-modal-dialog
    label=${title}
    description=${message}
    @modal-cancel=${props.onClose}
  >
    <section class="device-pair-setup" aria-busy=${failed ? nothing : "true"}>
      <header class="device-pair-setup__header">
        <div>
          <h2>${title}</h2>
          <p role=${failed ? nothing : "status"}>${message}</p>
        </div>
      </header>
      <footer class="device-pair-setup__footer">
        ${
          failed
            ? html`<button
                class="btn btn--primary"
                type="button"
                @click=${() => host.retryDevicePairSetupRenderer()}
              >
                ${t("common.retry")}
              </button>`
            : nothing
        }
        <button class="btn btn--ghost" type="button" @click=${props.onClose}>
          ${t("common.close")}
        </button>
      </footer>
    </section>
  </openclaw-modal-dialog>`;
}
