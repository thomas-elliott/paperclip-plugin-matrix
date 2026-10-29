import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
// Paperclip shows the manifest version, so take it from package.json rather than keeping two copies.
import packageJson from "../package.json" with { type: "json" };

// Installed settings and state are keyed on this ID, so it must never change.
const PLUGIN_ID = "paperclip-plugin-matrix";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: packageJson.version,
  displayName: "Matrix",
  description: "Connect a Paperclip instance to a Matrix homeserver",
  author: "Thomas Elliott",
  categories: ["connector"],
  capabilities: [
    "http.outbound",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "events.subscribe",
    "companies.read",
    "projects.read",
    "issues.read",
    "agents.read",
    "approvals.read",
    "ui.dashboardWidget.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    required: ["homeserverUrl", "accessToken"],
    properties: {
      homeserverUrl: {
        type: "string",
        title: "Homeserver address",
        description: "The address of your Matrix homeserver, for example https://matrix.example.com",
      },
      accessToken: {
        // The secret picker stores { type: "secret_ref", secretId, version? }, not the token itself.
        type: "object",
        format: "secret-ref",
        title: "Bot access token",
        description: "The Matrix bot account's access token, stored as a Paperclip secret",
      },
      defaultRoom: {
        type: "string",
        title: "Room",
        description:
          "Where the bot posts, as a room ID (!abc…) or alias (#name:server). Invite the bot first. Encrypted rooms are not supported.",
      },
      projectRooms: {
        type: "array",
        title: "Project rooms",
        description: "Optional. Posts about these projects go to their own room instead.",
        items: {
          type: "object",
          required: ["project", "room"],
          properties: {
            project: { type: "string", title: "Project", description: "The project's name, as shown in Paperclip" },
            room: { type: "string", title: "Room", description: "Room ID or alias" },
          },
        },
      },
      paperclipUrl: {
        type: "string",
        title: "Paperclip address",
        description: "Optional. Your Paperclip's web address, for example https://paperclip.example.com, so messages link to it",
      },
    },
  },
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "matrix-connection",
        displayName: "Matrix connection",
        exportName: "DashboardWidget",
      },
    ],
  },
};

export default manifest;
