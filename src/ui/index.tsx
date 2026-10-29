import { useEffect, useState, type CSSProperties } from "react";
import {
  KeyValueList,
  Spinner,
  StatusBadge,
  usePluginAction,
  usePluginData,
  type PluginDetailTabProps,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import type { ProjectRoomChoices } from "../project-rooms.js";
import type { ConnectionStatus } from "../worker.js";

// Paperclip's theme is Tailwind v4 CSS variables on the host page. Plugins read the variables
// rather than Tailwind classes, because the host stylesheet only contains classes it uses itself.
const space = (steps: number) => `calc(var(--spacing) * ${steps})`;

const styles = {
  stack: { display: "grid", gap: space(3) },
  heading: { margin: 0, fontSize: "var(--text-sm)", fontWeight: "var(--font-weight-semibold)" },
  text: { margin: 0, fontSize: "var(--text-sm)" },
  muted: { margin: 0, fontSize: "var(--text-sm)", color: "var(--muted-foreground)" },
  row: { display: "flex", gap: space(2) },
  input: {
    flex: 1,
    padding: `${space(2)} ${space(3)}`,
    fontSize: "var(--text-sm)",
    color: "var(--foreground)",
    background: "var(--background)",
    border: "1px solid var(--input)",
    borderRadius: "var(--radius-md)",
  },
  button: {
    padding: `${space(2)} ${space(3)}`,
    fontSize: "var(--text-sm)",
    fontWeight: "var(--font-weight-medium)",
    color: "var(--foreground)",
    background: "var(--background)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
    cursor: "pointer",
  },
  code: { fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" },
} satisfies Record<string, CSSProperties>;

type PendingLink = { matrixUserId: string; code: string };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Links the signed-in Paperclip user to their Matrix account, so their replies in issue threads
// become their comments. The worker learns who is signed in from Paperclip, not from this page.
function MatrixAccount({ companyId }: { companyId: string }) {
  const startLink = usePluginAction("startLink");
  const linkStatus = usePluginAction("linkStatus");
  const unlink = usePluginAction("unlink");
  // undefined while loading, null when not linked.
  const [linked, setLinked] = useState<string | null | undefined>(undefined);
  const [matrixUserId, setMatrixUserId] = useState("");
  const [pending, setPending] = useState<PendingLink | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  const refresh = () =>
    run(async () => {
      const status = (await linkStatus({ companyId })) as { matrixUserId: string | null };
      setLinked(status.matrixUserId);
      if (status.matrixUserId) setPending(null);
    });

  useEffect(() => {
    void refresh();
  }, [companyId]);

  const start = () =>
    run(async () => {
      const { code } = (await startLink({ companyId, matrixUserId })) as { code: string };
      setPending({ matrixUserId: matrixUserId.trim(), code });
    });

  const remove = () =>
    run(async () => {
      await unlink({ companyId });
      setLinked(null);
    });

  return (
    <div style={styles.stack}>
      <h3 style={styles.heading}>Your Matrix account</h3>
      {linked === undefined && !error && <Spinner size="sm" label="Checking your Matrix account" />}
      {linked && (
        <>
          <p style={styles.text}>
            Linked to <span style={styles.code}>{linked}</span>. Your replies in issue threads become your comments.
          </p>
          <div style={styles.row}>
            <button type="button" style={styles.button} onClick={remove}>
              Unlink
            </button>
          </div>
        </>
      )}
      {linked === null && !pending && (
        <>
          <p style={styles.muted}>Link your Matrix account so your replies in issue threads become your comments.</p>
          <div style={styles.row}>
            <input
              style={styles.input}
              aria-label="Your Matrix ID"
              placeholder="@you:example.com"
              value={matrixUserId}
              onChange={(event) => setMatrixUserId(event.target.value)}
            />
            <button type="button" style={styles.button} onClick={start}>
              Link
            </button>
          </div>
        </>
      )}
      {linked === null && pending && (
        <>
          <p style={styles.text}>
            From <span style={styles.code}>{pending.matrixUserId}</span>, send{" "}
            <span style={styles.code}>!link {pending.code}</span> in a room the bot is in, within 15 minutes. The bot
            reacts with a tick when it has linked you.
          </p>
          <div style={styles.row}>
            <button type="button" style={styles.button} onClick={refresh}>
              Check
            </button>
            <button type="button" style={styles.button} onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </>
      )}
      {error && <p style={{ ...styles.muted, color: "var(--destructive)" }}>{error}</p>}
    </div>
  );
}

export function DashboardWidget({ context }: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<ConnectionStatus>("connection", { companyId: context.companyId });

  if (loading) return <Spinner size="sm" label="Checking Matrix connection" />;
  if (error) return <StatusBadge status="error" label={`Could not check Matrix: ${error.message}`} />;
  if (!data?.connected) return <StatusBadge status="error" label={data?.reason ?? "Not connected"} />;

  return (
    <div style={styles.stack}>
      <KeyValueList
        pairs={[
          { label: "Status", value: <StatusBadge status="ok" label="Connected" /> },
          { label: "Signed in as", value: data.userId },
          // The loop keeps running while it retries a failing sync, so its error comes first.
          { label: "Reading rooms", value: data.sync?.lastError ?? (data.sync?.running ? "Yes" : "No") },
        ]}
      />
      {context.companyId && <MatrixAccount companyId={context.companyId} />}
    </div>
  );
}

// Picks the room where posts about this project go. Only rooms the bot is in are offered, because it
// can only post in those.
export function ProjectRoomTab({ context }: PluginDetailTabProps) {
  const projectId = context.entityId;
  const { data, loading, error, refresh } = usePluginData<ProjectRoomChoices>("projectRoom", { companyId: context.companyId, projectId });
  const setProjectRoom = usePluginAction("setProjectRoom");
  const [saveError, setSaveError] = useState<string | null>(null);

  if (loading) return <Spinner size="sm" label="Loading Matrix rooms" />;
  if (error) return <StatusBadge status="error" label={`Could not load Matrix rooms: ${error.message}`} />;
  if (!data?.connected) return <StatusBadge status="error" label={data?.reason ?? "Not connected"} />;

  async function choose(roomId: string) {
    setSaveError(null);
    try {
      await setProjectRoom({ companyId: context.companyId, projectId, roomId });
      refresh();
    } catch (caught) {
      setSaveError(errorText(caught));
    }
  }

  return (
    <div style={styles.stack}>
      <label htmlFor="matrix-project-room" style={styles.heading}>
        Matrix room for this project
      </label>
      <p style={styles.muted}>
        News about this project's issues goes here, and people can ask for work by mentioning the bot here. To offer
        another room, invite the bot to it first.
      </p>
      <select id="matrix-project-room" style={styles.input} value={data.selected ?? ""} onChange={(event) => void choose(event.target.value)}>
        <option value="">The default room</option>
        {data.rooms.map((room) => (
          <option key={room.roomId} value={room.roomId}>
            {room.name}
          </option>
        ))}
      </select>
      {saveError && <p style={{ ...styles.muted, color: "var(--destructive)" }}>{saveError}</p>}
    </div>
  );
}
