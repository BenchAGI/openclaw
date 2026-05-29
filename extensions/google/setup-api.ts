import { definePluginEntry } from "@benchagi/openclaw/plugin-sdk/plugin-entry";
import { buildGoogleGeminiCliBackend } from "./cli-backend.js";

export default definePluginEntry({
  id: "google",
  name: "Google Setup",
  description: "Lightweight Google setup hooks",
  register(api) {
    api.registerCliBackend(buildGoogleGeminiCliBackend());
  },
});
